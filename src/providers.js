import { api, runStream } from './api.js';
import { state, secretName, getProvider } from './store.js';
import { formatError } from './util.js';

const ANTHROPIC_VERSION = '2023-06-01';
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

export const CLI_MODELS = ['default', 'sonnet', 'opus', 'haiku'];

/** Which providers need a key before they can be used. */
export const needsKey = (p) => !p.local && p.kind !== 'claude-cli' && !p.custom;

function authFor(p) {
  if (!state.keys[p.id]) return null;
  return p.kind === 'anthropic'
    ? { secret: secretName(p), header: 'x-api-key' }
    : { secret: secretName(p), header: 'Authorization', prefix: 'Bearer ' };
}

function hintFor(status, p) {
  if (status === 401 || status === 403) return ' (the API key was rejected)';
  if (status === 404) return ' (check the address; OpenAI-style servers usually end in /v1)';
  return '';
}

/** Fetch the model list from a provider. Throws with a readable message. */
export async function listModels(p) {
  if (p.kind === 'claude-cli') {
    if (!state.cliPath) throw new Error('Claude Code was not found on this Mac');
    return CLI_MODELS;
  }
  const base = trimSlash(p.baseUrl);
  if (!base) throw new Error('Add the server address first');
  if (p.kind === 'anthropic' && !state.keys[p.id]) throw new Error('Add an API key first');
  if (needsKey(p) && !state.keys[p.id]) throw new Error('Add an API key first');

  let url = `${base}/models`;
  const headers = {};
  if (p.kind === 'anthropic') {
    url += '?limit=100';
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  }
  const res = await api.httpRequest({ method: 'GET', url, headers, auth: authFor(p), timeoutSecs: p.local ? 4 : 15 });
  if (res.status < 200 || res.status >= 300) throw new Error(`The server answered HTTP ${res.status}${hintFor(res.status, p)}`);

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error("The server replied, but not with a model list. Is this an OpenAI-compatible address?");
  }
  const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  let ids = arr.map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model)).filter(Boolean);
  ids = ids.filter((id) => !/embed|rerank|whisper|tts|moderation|dall-e|image/i.test(id));
  if (p.id === 'openai') ids = ids.filter((id) => /^(gpt|o\d|chatgpt|codex)/i.test(id) && !/audio|realtime|transcribe|search-preview/i.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function refreshModels(p) {
  state.status[p.id] = { state: 'loading' };
  try {
    const ids = await listModels(p);
    state.models[p.id] = ids;
    state.status[p.id] = { state: 'ok', message: `${ids.length} model${ids.length === 1 ? '' : 's'}` };
  } catch (e) {
    state.models[p.id] = [];
    state.status[p.id] = { state: 'error', message: formatError(e) };
  }
  return state.status[p.id];
}

export async function refreshAllModels() {
  await Promise.all(state.settings.providers.map((p) => refreshModels(p)));
}

const LOCAL_PORTS = [
  [1234, 'LM Studio'],
  [11434, 'Ollama'],
  [8080, 'llama.cpp server'],
  [8000, 'vLLM'],
  [1337, 'Jan'],
  [5001, 'KoboldCpp'],
  [5000, 'Local server'],
  [4891, 'GPT4All'],
];

/** Probe common local ports and return [{ name, baseUrl, models }] for servers that answer. */
export async function scanLocalServers() {
  const found = [];
  await Promise.all(
    LOCAL_PORTS.map(async ([port, name]) => {
      const baseUrl = `http://localhost:${port}/v1`;
      try {
        const res = await api.httpRequest({ method: 'GET', url: `${baseUrl}/models`, headers: {}, timeoutSecs: 2 });
        if (res.status >= 200 && res.status < 300) {
          const j = JSON.parse(res.body);
          if (Array.isArray(j.data)) found.push({ name, baseUrl, port, models: j.data.length });
        }
      } catch {
        /* nothing listening */
      }
    })
  );
  return found.sort((a, b) => a.port - b.port);
}

// ───────────── Chat streaming ─────────────

function sseParser(onData) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (d) onData(d);
      }
    }
  };
}

/**
 * Stream a chat completion from an OpenAI-compatible or Anthropic provider.
 * Returns { cancel }. Callbacks fire at most once for done/error.
 */
export function chatStream({ provider, model, system, messages, maxTokens, temperature, stop, onToken, onReasoning, onDone, onError }) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };
  const fail = (msg) => {
    if (finished) return;
    finished = true;
    onError?.(friendlyError(msg, provider));
  };

  const base = trimSlash(provider.baseUrl);
  let req;
  let handle;

  if (provider.kind === 'anthropic') {
    const body = { model, max_tokens: maxTokens || 8192, messages, stream: true };
    if (system) body.system = system;
    if (temperature != null) body.temperature = temperature;
    req = {
      method: 'POST',
      url: `${base}/messages`,
      headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      auth: authFor(provider),
    };
    handle = sseParser((d) => {
      let j;
      try {
        j = JSON.parse(d);
      } catch {
        return;
      }
      if (j.type === 'content_block_delta') {
        if (j.delta?.type === 'text_delta') onToken?.(j.delta.text);
        else if (j.delta?.type === 'thinking_delta') onReasoning?.(j.delta.thinking);
      } else if (j.type === 'error') fail(j.error?.message || 'The model returned an error');
      else if (j.type === 'message_stop') finish();
    });
  } else {
    const msgs = [...(system ? [{ role: 'system', content: system }] : []), ...messages];
    const body = { model, messages: msgs, stream: true };
    const isOpenAI = provider.id === 'openai';
    if (maxTokens) body[isOpenAI ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    if (temperature != null && !isOpenAI) body.temperature = temperature;
    if (stop && !isOpenAI) body.stop = stop;
    req = {
      method: 'POST',
      url: `${base}/chat/completions`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      auth: authFor(provider),
    };
    handle = sseParser((d) => {
      if (d === '[DONE]') return finish();
      let j;
      try {
        j = JSON.parse(d);
      } catch {
        return;
      }
      if (j.error) return fail(j.error.message || JSON.stringify(j.error));
      const delta = j.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) onToken?.(delta.content);
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) onReasoning?.(r);
    });
  }

  const job = runStream('http_stream', { req }, (ev) => {
    if (finished) return;
    if (ev.event === 'chunk') handle(ev.data);
    else if (ev.event === 'error') fail(ev.data);
    else if (ev.event === 'done') finish();
  });
  job.promise.catch((e) => fail(formatError(e)));
  return {
    cancel: () => {
      finished = true;
      job.cancel();
    },
  };
}

function friendlyError(msg, provider) {
  const s = String(msg || '');
  if (/HTTP 401|HTTP 403/.test(s)) return `${provider.name} rejected the API key. Check it in Settings.`;
  if (/HTTP 404/.test(s) && provider.local) return `${provider.name} doesn't have that model loaded. Load it in the app, or pick another.`;
  if (/HTTP 429/.test(s)) return `${provider.name} is rate limiting requests. Wait a moment and try again.`;
  if (/Could not connect/.test(s)) return `Couldn't reach ${provider.name}. Is it running?`;
  return s;
}

/** Collect a whole response (used by inline edit and autocomplete). */
export function chatOnce(opts) {
  return new Promise((resolve, reject) => {
    let text = '';
    const h = chatStream({
      ...opts,
      onToken: (t) => {
        text += t;
        opts.onToken?.(t, text);
      },
      onDone: () => resolve(text),
      onError: (e) => reject(new Error(e)),
    });
    if (opts.signalRef) {
      opts.signalRef.cancel = () => {
        h.cancel();
        reject(new Error('cancelled'));
      };
    }
  });
}

/** Legacy /completions with a suffix, for models that support fill-in-the-middle. */
export function fimComplete({ provider, model, prefix, suffix, maxTokens, signalRef }) {
  return new Promise((resolve, reject) => {
    const body = { model, prompt: prefix, suffix, max_tokens: maxTokens || 96, temperature: 0, stream: false };
    let text = '';
    let status = 200;
    const job = runStream(
      'http_stream',
      {
        req: {
          method: 'POST',
          url: `${trimSlash(provider.baseUrl)}/completions`,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          auth: authFor(provider),
        },
      },
      (ev) => {
        if (ev.event === 'status') status = ev.data;
        else if (ev.event === 'chunk') text += ev.data;
        else if (ev.event === 'error') reject(new Error(ev.data));
        else if (ev.event === 'done') {
          try {
            const j = JSON.parse(text);
            resolve(j.choices?.[0]?.text ?? '');
          } catch {
            reject(new Error(`Unexpected reply (HTTP ${status})`));
          }
        }
      }
    );
    job.promise.catch((e) => reject(new Error(formatError(e))));
    if (signalRef) {
      signalRef.cancel = () => {
        job.cancel();
        reject(new Error('cancelled'));
      };
    }
  });
}

// ───────────── Claude Code CLI ─────────────

/**
 * Run the user's installed Claude Code CLI (already signed in with their subscription).
 * mode: 'plan' (read-only analysis) or 'acceptEdits' (may change files in the folder).
 */
export function cliStream({ model, prompt, cwd, sessionId, mode, systemPrompt, onToken, onTool, onSession, onDone, onError }) {
  let finished = false;
  let sawPartial = false;
  let errorText = '';
  let stderrText = '';
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };
  const fail = (m) => {
    if (finished) return;
    finished = true;
    onError?.(m);
  };

  const describeTool = (b) => {
    const i = b.input || {};
    const target = i.file_path || i.path || i.command || i.pattern || i.url || '';
    return { name: b.name, detail: String(target).slice(0, 120) };
  };

  const handleLine = (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.session_id) onSession?.(j.session_id);
    if (j.type === 'stream_event') {
      const d = j.event?.delta;
      if (j.event?.type === 'content_block_delta' && d?.type === 'text_delta') {
        sawPartial = true;
        onToken?.(d.text);
      }
    } else if (j.type === 'assistant') {
      for (const b of j.message?.content || []) {
        if (b.type === 'tool_use') onTool?.(describeTool(b));
        else if (b.type === 'text' && !sawPartial) onToken?.(b.text);
      }
      sawPartial = false;
    } else if (j.type === 'result') {
      if (j.is_error) errorText = typeof j.result === 'string' ? j.result : 'Claude Code reported an error';
    }
  };

  const job = runStream('claude_cli_run', { req: { prompt, cwd, model, sessionId, permissionMode: mode, systemPrompt } }, (ev) => {
    if (finished) return;
    if (ev.event === 'line') handleLine(ev.data);
    else if (ev.event === 'stderr') stderrText = ev.data;
    else if (ev.event === 'error') fail(ev.data);
    else if (ev.event === 'exit') {
      if (errorText) fail(errorText);
      else if (ev.data != null && ev.data !== 0) fail(stderrText || `Claude Code exited with code ${ev.data}`);
      else finish();
    } else if (ev.event === 'done') finish();
  });
  job.promise.catch((e) => fail(formatError(e)));
  return {
    cancel: () => {
      finished = true;
      job.cancel();
    },
  };
}

export { getProvider };
