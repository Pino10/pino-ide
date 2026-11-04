import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from './api.js';
import { state, getProvider, updateSetting } from './store.js';
import { h, $, basename, relPath, rafThrottle, formatError, emit } from './util.js';
import { icon } from './icons.js';
import { toast, popover } from './ui.js';
import { chatStream, cliStream, refreshModels } from './providers.js';
import { getActiveDoc, getSelectionInfo, insertAtCursor, colorizeCode, reviewDiff, reloadFromDisk } from './editor.js';
import { EDIT_RULES, buildProposals, applyProposal, diffStats } from './edits.js';
import { refreshTree } from './explorer.js';
import { pickProjectFile, invalidateFileCache } from './palette.js';

marked.setOptions({ gfm: true, breaks: false });

const MAX_FILE_CHARS = 60000;
const MAX_HISTORY_CHARS = 120000;

const conv = { messages: [], sessionId: null, busy: false, handle: null };
let attachments = []; // { kind: 'file' | 'selection', path, text?, startLine?, endLine? }
let mode = 'ask';
let els = {};

const BASE_SYSTEM =
  'You are Pino, an expert programming assistant inside the Pino IDE. Be direct and practical. ' +
  'Prefer minimal, correct changes that follow the style of the surrounding code. When you show code, use fenced code blocks with a language tag.';

// ───────────── Markdown rendering ─────────────

const FENCE_OPEN = /^`{3,}\s*(edit|file)\s+(?:path=)?(.+?)\s*$/;

function splitSegments(text) {
  const lines = text.split('\n');
  const md = [];
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (!m) {
      md.push(lines[i++]);
      continue;
    }
    let j = i + 1;
    const body = [];
    while (j < lines.length && !/^`{3,}\s*$/.test(lines[j])) body.push(lines[j++]);
    blocks.push({ kind: m[1], path: m[2].replace(/^["'`]|["'`]$/g, ''), body: body.join('\n'), closed: j < lines.length });
    i = j + 1;
  }
  return { markdown: md.join('\n'), blocks };
}

function sanitize(htmlStr) {
  return DOMPurify.sanitize(htmlStr, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
}

function enhanceCode(root, { highlight }) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.dataset.done) return;
    const code = pre.querySelector('code');
    if (!code) return;
    const text = code.textContent.replace(/\n$/, '');
    const lang = (/language-([\w+#-]+)/.exec(code.className) || [])[1] || '';
    pre.dataset.done = '1';
    const bar = h(
      'div',
      { class: 'code-bar' },
      h('span', { class: 'code-lang' }, lang || 'text'),
      h('span', { class: 'grow' }),
      h('button', { class: 'chip-btn', title: 'Insert at the cursor in the editor', onClick: () => (insertAtCursor(text) ? toast('Inserted at the cursor', { kind: 'success', ms: 1800 }) : toast('Open a file first.', { kind: 'error' })) }, 'Insert'),
      h('button', {
        class: 'chip-btn',
        onClick: (e) => {
          navigator.clipboard?.writeText(text);
          e.currentTarget.textContent = 'Copied';
          setTimeout(() => (e.currentTarget.textContent = 'Copy'), 1400);
        },
      }, 'Copy')
    );
    pre.prepend(bar);
    if (highlight && lang) {
      colorizeCode(text, lang).then((html) => {
        if (html && code.isConnected) code.innerHTML = sanitize(html);
      });
    }
  });
  root.querySelectorAll('a').forEach((a) => {
    a.setAttribute('rel', 'noopener noreferrer');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) api.openExternal(href).catch(() => {});
    });
  });
}

function renderMarkdownInto(el, text, streaming) {
  const { markdown, blocks } = splitSegments(text);
  el.replaceChildren();
  const body = h('div', { class: 'md' });
  body.innerHTML = sanitize(marked.parse(markdown || ''));
  enhanceCode(body, { highlight: !streaming });
  el.append(body);
  if (streaming) {
    for (const b of blocks.filter((x) => !x.closed || streaming)) {
      el.append(h('div', { class: 'writing' }, h('span', { class: 'spinner' }), h('span', {}, `${b.closed ? 'Prepared' : 'Writing'} changes to ${b.path}`)));
    }
  }
  return blocks;
}

// ───────────── Context assembly ─────────────

function fenced(path, text) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${ext}\n${text}\n${fence}`;
}

async function buildContext() {
  const parts = [];
  const used = new Set();
  const doc = getActiveDoc();
  const cap = (s) => (s.length > MAX_FILE_CHARS ? s.slice(0, MAX_FILE_CHARS) + '\n… (truncated)' : s);
  if (state.settings.ai.includeActiveFile && doc) {
    parts.push(`Active file: ${relPath(state.root, doc.path)}\n${fenced(doc.path, cap(doc.model.getValue()))}`);
    used.add(doc.path);
  }
  for (const a of attachments) {
    if (a.kind === 'selection') {
      parts.push(`Selected code in ${relPath(state.root, a.path)} (lines ${a.startLine}-${a.endLine}):\n${fenced(a.path, cap(a.text))}`);
    } else if (!used.has(a.path)) {
      used.add(a.path);
      try {
        const r = await api.readFile(a.path);
        parts.push(`File: ${relPath(state.root, a.path)}\n${fenced(a.path, cap(r.content))}`);
      } catch (e) {
        parts.push(`File: ${relPath(state.root, a.path)} (could not be read: ${formatError(e)})`);
      }
    }
  }
  return parts.length ? `<context>\n${parts.join('\n\n')}\n</context>\n\n` : '';
}

function systemPrompt(forCli) {
  let s = BASE_SYSTEM;
  if (state.root) s += `\nThe open folder is "${basename(state.root)}".`;
  if (state.settings.ai.extraInstructions.trim()) s += `\n\nUser instructions:\n${state.settings.ai.extraInstructions.trim()}`;
  if (mode === 'edit' && !forCli) s += EDIT_RULES;
  return s;
}

function trimHistory(messages) {
  let total = 0;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    total += messages[i].content.length;
    if (total > MAX_HISTORY_CHARS && out.length) break;
    out.unshift(messages[i]);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ───────────── Sending ─────────────

export function selectedProvider() {
  const { providerId, model } = state.settings.selected;
  const p = getProvider(providerId);
  return p && model ? { provider: p, model } : null;
}

function addMessage(role, text = '') {
  const wrap = h('div', { class: `msg ${role}` });
  if (role === 'assistant') wrap.append(h('div', { class: 'avatar', html: icon('sparkle') }));
  const body = h('div', { class: 'msg-body' });
  wrap.append(body);
  els.list.append(wrap);
  if (role === 'user') body.textContent = text;
  scrollDown(true);
  return body;
}

const scrollDown = (force = false) => {
  const l = els.list;
  const near = l.scrollHeight - l.scrollTop - l.clientHeight < 140;
  if (force || near) l.scrollTop = l.scrollHeight;
};

function setBusy(b) {
  conv.busy = b;
  els.send.classList.toggle('stop', b);
  els.send.innerHTML = icon(b ? 'stop' : 'send');
  els.send.title = b ? 'Stop (Esc)' : 'Send (Enter)';
  els.send.setAttribute('aria-label', b ? 'Stop' : 'Send');
}

export async function send() {
  if (conv.busy) return stop();
  const text = els.input.value.trim();
  if (!text) return;
  const sel = selectedProvider();
  if (!sel) {
    toast('Choose a model first. Open Settings to connect one.', { kind: 'error' });
    return openModelPicker();
  }
  const { provider, model } = sel;
  const isCli = provider.kind === 'claude-cli';
  if (isCli && !state.root) return toast('Open a folder first so Claude Code knows where to work.', { kind: 'error' });
  if (!isCli && provider.kind !== 'openai' && provider.kind !== 'anthropic') return toast('That provider type is not supported.', { kind: 'error' });

  els.empty?.remove();
  els.input.value = '';
  autosize();
  addMessage('user', text);
  const ctx = await buildContext();
  const userContent = ctx + text;
  const atts = attachments.length;
  attachments = [];
  renderChips();
  if (atts) emit('chat:attachments');

  const body = addMessage('assistant');
  const status = h('div', { class: 'status-line' }, h('span', { class: 'spinner' }), h('span', {}, 'Thinking'));
  const tools = h('div', { class: 'tools' });
  const out = h('div', { class: 'out' });
  body.append(tools, out, status);

  conv.messages.push({ role: 'user', content: userContent, display: text });
  let acc = '';
  let toolCount = 0;
  let ended = false;
  setBusy(true);

  const rerender = rafThrottle(() => {
    if (ended) return;
    renderMarkdownInto(out, acc, true);
    scrollDown();
  });

  const finishUi = async (err) => {
    ended = true;
    setBusy(false);
    conv.handle = null;
    status.remove();
    if (err) {
      if (!acc) conv.messages.pop();
      out.append(h('div', { class: 'msg-error' }, h('span', { html: icon('alert') }), h('span', {}, err)));
    }
    if (acc) {
      conv.messages.push({ role: 'assistant', content: acc });
      const blocks = renderMarkdownInto(out, acc, false);
      if (mode === 'edit' && !isCli && blocks.some((b) => b.closed)) {
        const props = await buildProposals(blocks);
        if (props.length) body.append(changeCard(props));
      }
    }
    if (isCli) {
      invalidateFileCache();
      await refreshTree();
      await reloadFromDisk();
    }
    scrollDown();
  };

  if (isCli) {
    conv.handle = cliStream({
      model,
      prompt: userContent,
      cwd: state.root,
      sessionId: conv.sessionId,
      mode: mode === 'edit' ? 'acceptEdits' : 'plan',
      systemPrompt: [BASE_SYSTEM, state.settings.ai.extraInstructions.trim()].filter(Boolean).join('\n\n'),
      onSession: (id) => (conv.sessionId = id),
      onTool: (t) => {
        toolCount++;
        tools.append(h('div', { class: 'tool-chip' }, h('b', {}, t.name), t.detail ? h('span', {}, ' ' + t.detail.replace(state.root + '/', '')) : null));
        status.lastChild.textContent = `Working (${toolCount} step${toolCount === 1 ? '' : 's'})`;
        scrollDown();
      },
      onToken: (t) => {
        acc += t;
        status.lastChild.textContent = 'Writing';
        rerender();
      },
      onDone: () => finishUi(),
      onError: (m) => finishUi(m),
    });
  } else {
    const history = trimHistory(conv.messages).map((m) => ({ role: m.role, content: m.content }));
    conv.handle = chatStream({
      provider,
      model,
      system: systemPrompt(false),
      messages: history,
      onReasoning: () => {
        if (!acc) status.lastChild.textContent = 'Thinking';
      },
      onToken: (t) => {
        acc += t;
        status.lastChild.textContent = 'Writing';
        rerender();
      },
      onDone: () => finishUi(),
      onError: (m) => finishUi(m),
    });
  }
}

export function stop() {
  conv.handle?.cancel();
  if (conv.busy) {
    // The stream is already torn down, so finish the UI ourselves.
    setBusy(false);
    els.list.querySelectorAll('.status-line').forEach((n) => n.remove());
    const last = conv.messages[conv.messages.length - 1];
    if (last?.role === 'user') conv.messages.push({ role: 'assistant', content: '(stopped)' });
    conv.handle = null;
  }
}

export function newChat() {
  if (conv.busy) stop();
  conv.messages = [];
  conv.sessionId = null;
  attachments = [];
  renderChips();
  els.list.replaceChildren(els.empty);
  els.input.focus();
}

// ───────────── Change cards (review before apply) ─────────────

function changeCard(props) {
  const card = h('div', { class: 'changes' });
  const rows = props.map((p) => {
    const st = diffStats(p.originalRaw, p.modified);
    const row = h('div', { class: 'change-row' });
    const paint = () => {
      row.replaceChildren();
      row.classList.toggle('done', p.status !== 'pending');
      row.append(
        h('span', { class: 'ch-icon', html: icon(p.isNew ? 'newFile' : 'file') }),
        h('div', { class: 'ch-main' },
          h('div', { class: 'ch-name' }, p.rel, p.isNew ? h('span', { class: 'badge' }, 'New') : null),
          p.errors.length ? h('div', { class: 'ch-err' }, p.errors[0]) : h('div', { class: 'ch-stat' }, h('span', { class: 'add' }, `+${st.add}`), h('span', { class: 'del' }, `−${st.del}`))
        )
      );
      if (p.status === 'applied') row.append(h('span', { class: 'ch-state ok' }, 'Applied'));
      else if (p.status === 'discarded') row.append(h('span', { class: 'ch-state' }, 'Discarded'));
      else if (p.changed && p.abs) {
        row.append(
          h('button', { class: 'chip-btn', onClick: () => review() }, 'Review'),
          h('button', { class: 'chip-btn accent', onClick: () => apply() }, 'Apply'),
          h('button', { class: 'chip-btn', title: 'Discard', onClick: () => ((p.status = 'discarded'), paint(), sync()) }, 'Discard')
        );
      } else row.append(h('span', { class: 'ch-state' }, p.errors.length ? 'Can’t apply' : 'No changes'));
    };
    async function review() {
      const ok = await reviewDiff({ title: p.isNew ? `New file: ${p.rel}` : `Review changes: ${p.rel}`, path: p.rel, original: p.originalRaw, modified: p.modified, applyLabel: 'Apply', rejectLabel: 'Close' });
      if (ok) apply();
    }
    async function apply() {
      try {
        await applyProposal(p);
        invalidateFileCache();
        await refreshTree();
        toast(`Applied changes to ${basename(p.rel)}`, { kind: 'success' });
      } catch (e) {
        toast(formatError(e), { kind: 'error' });
      }
      paint();
      sync();
    }
    p._paint = paint;
    paint();
    return row;
  });
  const pending = () => props.filter((p) => p.status === 'pending' && p.changed && p.abs);
  const head = h('div', { class: 'changes-head' });
  const sync = () => {
    head.replaceChildren(h('span', { class: 'ch-title', html: icon('diff') + `<span>${props.length} file${props.length === 1 ? '' : 's'} changed</span>` }));
    if (pending().length > 1) {
      head.append(
        h('button', {
          class: 'chip-btn accent',
          onClick: async () => {
            for (const p of pending()) {
              try {
                await applyProposal(p);
              } catch (e) {
                toast(`${p.rel}: ${formatError(e)}`, { kind: 'error' });
              }
              p._paint();
            }
            invalidateFileCache();
            await refreshTree();
            sync();
          },
        }, 'Apply all')
      );
    }
  };
  sync();
  card.append(head, ...rows);
  return card;
}

// ───────────── Composer ─────────────

function autosize() {
  const t = els.input;
  t.style.height = 'auto';
  t.style.height = Math.min(220, t.scrollHeight) + 'px';
}

function renderChips() {
  els.chips.replaceChildren();
  const doc = getActiveDoc();
  if (state.settings.ai.includeActiveFile && doc) {
    els.chips.append(h('span', { class: 'ctx-chip auto', title: 'The open file is shared automatically' }, h('span', { html: icon('file') }), basename(doc.path)));
  }
  attachments.forEach((a, i) => {
    els.chips.append(
      h('span', { class: 'ctx-chip' },
        h('span', { html: icon(a.kind === 'selection' ? 'code' : 'file') }),
        a.kind === 'selection' ? `${basename(a.path)}:${a.startLine}-${a.endLine}` : basename(a.path),
        h('button', { class: 'x', 'aria-label': 'Remove', onClick: () => ((attachments = attachments.filter((_, k) => k !== i)), renderChips()) }, '×')
      )
    );
  });
}

export function attachSelection() {
  const s = getSelectionInfo();
  if (!s) return toast('Select some code in the editor first.', { kind: 'info' });
  attachments.push({ kind: 'selection', path: s.path, text: s.text, startLine: s.startLine, endLine: s.endLine });
  renderChips();
  els.input.focus();
}

async function attachFile() {
  const p = await pickProjectFile();
  if (p && !attachments.some((a) => a.path === p)) {
    attachments.push({ kind: 'file', path: p });
    renderChips();
  }
  els.input.focus();
}

// ───────────── Model picker ─────────────

export function updateModelButton() {
  const sel = selectedProvider();
  const btn = els.model;
  if (!btn) return;
  btn.replaceChildren(
    h('span', { class: 'dot ' + (sel ? 'on' : '') }),
    h('span', { class: 'm-name' }, sel ? sel.model : 'Choose a model'),
    sel ? h('span', { class: 'm-prov' }, sel.provider.name) : null,
    h('span', { class: 'm-chev', html: icon('chevronDown') })
  );
  renderModeHint();
}

export function openModelPicker() {
  const content = h('div', { class: 'picker' });
  const search = h('input', { class: 'input sm', placeholder: 'Filter models', spellcheck: 'false', 'aria-label': 'Filter models' });
  const list = h('div', { class: 'picker-list' });
  content.append(h('div', { class: 'picker-head' }, search), list);
  const pop = popover(els.model, content, { minWidth: 340 });

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    let any = false;
    for (const p of state.settings.providers) {
      const models = (state.models[p.id] || []).filter((m) => !q || m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      const st = state.status[p.id];
      if (!models.length && q) continue;
      any = true;
      list.append(
        h('div', { class: 'picker-group' },
          h('span', {}, p.name),
          st?.state === 'loading' ? h('span', { class: 'spinner sm' }) : null
        )
      );
      if (!models.length) {
        const msg = st?.state === 'error' ? st.message : p.kind !== 'claude-cli' && !p.local && !state.keys[p.id] ? 'Add an API key in Settings' : 'No models found';
        list.append(h('div', { class: 'picker-note' }, msg));
        continue;
      }
      for (const m of models) {
        const on = state.settings.selected.providerId === p.id && state.settings.selected.model === m;
        list.append(
          h('button', {
            class: `picker-item ${on ? 'on' : ''}`,
            onClick: () => {
              updateSetting('selected', { providerId: p.id, model: m });
              updateModelButton();
              pop.close();
            },
          }, h('span', {}, m), on ? h('span', { html: icon('check') }) : null)
        );
      }
    }
    if (!any) list.append(h('div', { class: 'picker-note' }, 'Nothing matches.'));
  };
  search.addEventListener('input', paint);
  paint();
  search.focus();
  // Refresh in the background so the list is current.
  Promise.all(state.settings.providers.filter((p) => p.local || p.kind === 'claude-cli' || state.keys[p.id]).map((p) => refreshModels(p))).then(() => pop.el.isConnected && paint());
}

function renderModeHint() {
  const sel = selectedProvider();
  const cli = sel?.provider.kind === 'claude-cli';
  els.modeHint.textContent =
    mode === 'ask'
      ? cli ? 'Ask: Claude Code can read your project but not change it.' : 'Ask: answers questions about your code.'
      : cli ? 'Edit: Claude Code changes files directly in your folder.' : 'Edit: the model proposes changes and you review each one.';
  els.modeAsk.classList.toggle('on', mode === 'ask');
  els.modeEdit.classList.toggle('on', mode === 'edit');
  els.modeAsk.setAttribute('aria-pressed', String(mode === 'ask'));
  els.modeEdit.setAttribute('aria-pressed', String(mode === 'edit'));
}

// ───────────── Init ─────────────

export function initChat(root) {
  els.list = h('div', { class: 'chat-list', 'aria-live': 'polite' });
  els.empty = h('div', { class: 'chat-empty' },
    h('div', { class: 'empty-mark', html: icon('sparkle') }),
    h('h3', {}, 'Ask Pino anything'),
    h('p', {}, 'Your open file is shared automatically. Switch to Edit and the model will propose changes you can review before they touch your files.')
  );
  els.list.append(els.empty);

  els.model = h('button', { class: 'model-btn', title: 'Choose a model', onClick: openModelPicker });
  els.modeAsk = h('button', { class: 'seg', onClick: () => ((mode = 'ask'), renderModeHint()) }, 'Ask');
  els.modeEdit = h('button', { class: 'seg', onClick: () => ((mode = 'edit'), renderModeHint()) }, 'Edit');
  els.modeHint = h('div', { class: 'mode-hint' });
  els.chips = h('div', { class: 'chips' });
  els.input = h('textarea', { class: 'composer-input', rows: '1', placeholder: 'Message Pino', 'aria-label': 'Message', spellcheck: 'true' });
  els.send = h('button', { class: 'send-btn', onClick: send, html: icon('send'), title: 'Send (Enter)', 'aria-label': 'Send' });

  const header = h('div', { class: 'chat-head' },
    els.model,
    h('span', { class: 'grow' }),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Mode' }, els.modeAsk, els.modeEdit),
    h('button', { class: 'icon-btn', title: 'New chat', 'aria-label': 'New chat', onClick: newChat, html: icon('plus') })
  );
  const composer = h('div', { class: 'composer' },
    els.chips,
    els.input,
    h('div', { class: 'composer-bar' },
      h('button', { class: 'icon-btn sm', title: 'Add a file from this project', 'aria-label': 'Add a file', onClick: attachFile, html: icon('link') }),
      h('button', { class: 'icon-btn sm', title: 'Add the selected code', 'aria-label': 'Add selection', onClick: attachSelection, html: icon('code') }),
      els.modeHint,
      h('span', { class: 'grow' }),
      els.send
    )
  );
  root.append(header, els.list, composer);

  els.input.addEventListener('input', autosize);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && conv.busy) stop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && conv.busy && !document.querySelector('.scrim')) stop();
  });
  updateModelButton();
  renderChips();
}

export const refreshChips = renderChips;
export const focusChat = () => els.input?.focus();
export const getMode = () => mode;
export const setMode = (m) => ((mode = m), renderModeHint());
export { $ };
