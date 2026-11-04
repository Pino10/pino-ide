import { api } from './api.js';
import { debounce } from './util.js';

export const BUILTIN_PROVIDERS = [
  { id: 'lmstudio', name: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', local: true },
  { id: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://localhost:11434/v1', local: true },
  { id: 'claude-cli', name: 'Claude Code', kind: 'claude-cli', baseUrl: '', note: 'Uses your Claude subscription through the Claude Code CLI' },
  { id: 'claude-api', name: 'Claude API', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'grok', name: 'Grok (xAI)', kind: 'openai', baseUrl: 'https://api.x.ai/v1' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com' },
];

export const ACCENTS = [
  { name: 'Pine', value: '#7ccfa5' },
  { name: 'Lagoon', value: '#7cc4ff' },
  { name: 'Iris', value: '#b9a4ff' },
  { name: 'Amber', value: '#ffc472' },
  { name: 'Rose', value: '#ff9bb5' },
  { name: 'Snow', value: '#e6eaee' },
];

const DEFAULTS = {
  version: 1,
  providers: BUILTIN_PROVIDERS.map((p) => ({ ...p })),
  selected: { providerId: null, model: null },
  autocomplete: { enabled: false, providerId: null, model: null, mode: 'chat', delayMs: 350, maxTokens: 96 },
  editor: {
    fontSize: 13.5,
    fontFamily: 'Google Sans Code Variable',
    lineHeight: 1.65,
    ligatures: true,
    minimap: false,
    wordWrap: 'off',
    tabSize: 4,
    autoSave: 'off',
    stickyScroll: true,
  },
  appearance: { accent: '#7ccfa5', gap: 8 },
  ai: { extraInstructions: '', includeActiveFile: true },
  workspace: { recent: [], last: null, openFiles: [], active: null, expanded: [] },
  ui: { sidebarOpen: true, chatOpen: true, sidebarWidth: 268, chatWidth: 400 },
};

export const state = {
  settings: structuredClone(DEFAULTS),
  /** providerId -> true when an API key is stored in the Keychain */
  keys: {},
  /** providerId -> string[] of model ids */
  models: {},
  /** providerId -> { state: 'idle'|'loading'|'ok'|'error', message } */
  status: {},
  /** canonical path of the open folder */
  root: null,
  cliPath: null,
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, extra) {
  const out = structuredClone(base);
  if (!isObj(extra)) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (isObj(v) && isObj(out[k])) out[k] = merge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function normalizeProviders(saved) {
  const list = Array.isArray(saved) ? saved.filter((p) => p && p.id && p.kind) : [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const out = [];
  for (const b of BUILTIN_PROVIDERS) {
    const s = byId.get(b.id);
    out.push(s ? { ...b, baseUrl: s.baseUrl || b.baseUrl } : { ...b });
    byId.delete(b.id);
  }
  for (const p of byId.values()) out.push({ ...p, custom: true });
  return out;
}

export async function loadSettings() {
  try {
    const raw = await api.settingsRead();
    const saved = JSON.parse(raw || '{}');
    state.settings = merge(DEFAULTS, saved);
    state.settings.providers = normalizeProviders(saved.providers);
  } catch {
    state.settings = structuredClone(DEFAULTS);
  }
}

const persist = debounce(() => {
  api.settingsWrite(JSON.stringify(state.settings)).catch(() => {});
}, 400);

export const saveSettings = () => persist();

export const getProvider = (id) => state.settings.providers.find((p) => p.id === id) || null;
export const secretName = (p) => `provider.${p.id}`;

export function updateSetting(path, value) {
  const keys = path.split('.');
  let o = state.settings;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
  saveSettings();
}

export function addRecentFolder(path) {
  const r = state.settings.workspace.recent.filter((p) => p !== path);
  r.unshift(path);
  state.settings.workspace.recent = r.slice(0, 8);
  state.settings.workspace.last = path;
  saveSettings();
}
