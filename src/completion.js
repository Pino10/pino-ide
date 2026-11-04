import { monaco } from './editor.js';
import { state, getProvider } from './store.js';
import { chatOnce, fimComplete } from './providers.js';
import { basename } from './util.js';

const SYSTEM =
  'You are a code completion engine inside a code editor. The file is shown with the marker <|cursor|> at the caret. ' +
  'Reply with ONLY the text to insert at the caret: no explanations, no markdown fences, and do not repeat text that is already before or after the caret. ' +
  'Keep it short (usually one to a few lines) and finish the current statement or block. If nothing sensible can be added, reply with nothing.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

export function cleanCompletion(raw, prefix) {
  let t = String(raw || '');
  t = t.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  t = t.replace(/<\|cursor\|>/g, '');
  const fence = /^\s*```[\w+-]*\n([\s\S]*?)(\n```\s*)?$/.exec(t);
  if (fence) t = fence[1];
  t = t.replace(/^\n+(?=\S)/, (m) => (prefix.endsWith('\n') ? '' : m));
  // Models sometimes echo the line they are completing.
  const lastLine = prefix.split('\n').pop();
  if (lastLine.trim().length > 3 && t.startsWith(lastLine)) t = t.slice(lastLine.length);
  const lines = t.split('\n');
  if (lines.length > 16) t = lines.slice(0, 16).join('\n');
  return t.trimEnd() ? t.replace(/\s+$/, '') : '';
}

export function initCompletion() {
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      async provideInlineCompletions(model, position, _ctx, token) {
        const ac = state.settings.autocomplete;
        if (!ac.enabled || !ac.providerId || !ac.model) return { items: [] };
        const provider = getProvider(ac.providerId);
        if (!provider || provider.kind === 'claude-cli') return { items: [] };

        const mine = ++seq;
        await sleep(ac.delayMs);
        if (token.isCancellationRequested || mine !== seq) return { items: [] };

        const full = model.getValue();
        const offset = model.getOffsetAt(position);
        const prefix = full.slice(Math.max(0, offset - 6000), offset);
        const suffix = full.slice(offset, offset + 2000);
        if (!prefix.trim()) return { items: [] };

        const ref = { cancel: null };
        const sub = token.onCancellationRequested(() => ref.cancel?.());
        try {
          let text;
          if (ac.mode === 'fim') {
            text = await fimComplete({ provider, model: ac.model, prefix, suffix, maxTokens: ac.maxTokens, signalRef: ref });
          } else {
            text = await chatOnce({
              provider,
              model: ac.model,
              system: SYSTEM,
              messages: [{ role: 'user', content: `File: ${basename(model.uri.path)} (${model.getLanguageId()})\n\n${prefix}<|cursor|>${suffix}` }],
              maxTokens: ac.maxTokens,
              temperature: 0,
              signalRef: ref,
            });
          }
          if (token.isCancellationRequested || mine !== seq) return { items: [] };
          const insertText = cleanCompletion(text, prefix);
          if (!insertText) return { items: [] };
          return {
            items: [{ insertText, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }],
          };
        } catch {
          return { items: [] };
        } finally {
          sub.dispose();
        }
      },
      freeInlineCompletions() {},
      disposeInlineCompletions() {},
    }
  );
}
