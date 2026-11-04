import '@fontsource-variable/google-sans-flex';
import '@fontsource-variable/google-sans-code';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, inTauri } from './api.js';
import { state, loadSettings, saveSettings, updateSetting, addRecentFolder, secretName } from './store.js';
import { $, h, basename, formatError, on, relPath, extname } from './util.js';
import { icon, PINO_MARK } from './icons.js';
import { toast, confirmDialog } from './ui.js';
import {
  initEditor, openFile, saveActive, saveAll, closeDoc, closeAll, switchRelative, reloadFromDisk, hasDirty,
  getActiveDoc, getEditor, applyTheme, monaco,
} from './editor.js';
import { setRoot, refreshTree, newEntry, initExplorerKeys, revealInTree } from './explorer.js';
import { initChat, updateModelButton, focusChat, attachSelection, newChat, setMode, refreshChips } from './chat.js';
import { initCompletion } from './completion.js';
import { openSettings } from './settings.js';
import { openPalette, registerCommands, invalidateFileCache } from './palette.js';
import { refreshAllModels } from './providers.js';

const isMac = /Mac/i.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

// ───────────── Layout ─────────────

function applyAccent() {
  const a = state.settings.appearance.accent;
  document.documentElement.style.setProperty('--accent', a);
}

function applyLayout() {
  const ui = state.settings.ui;
  const app = $('#app');
  app.style.setProperty('--sidebar-w', `${ui.sidebarWidth}px`);
  app.style.setProperty('--chat-w', `${ui.chatWidth}px`);
  app.classList.toggle('no-sidebar', !ui.sidebarOpen);
  app.classList.toggle('no-chat', !ui.chatOpen);
  $('#btn-sidebar')?.setAttribute('aria-pressed', String(ui.sidebarOpen));
  $('#btn-chat')?.setAttribute('aria-pressed', String(ui.chatOpen));
}

function toggleSidebar() {
  updateSetting('ui.sidebarOpen', !state.settings.ui.sidebarOpen);
  applyLayout();
}

function toggleChat(force) {
  const open = force ?? !state.settings.ui.chatOpen;
  updateSetting('ui.chatOpen', open);
  applyLayout();
  if (open) focusChat();
}

function initResizers() {
  const wire = (id, key, min, max, dir) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = state.settings.ui[key];
      el.classList.add('active');
      document.body.classList.add('resizing');
      const move = (ev) => {
        const w = Math.max(min, Math.min(max, start + (ev.clientX - startX) * dir));
        state.settings.ui[key] = w;
        $('#app').style.setProperty(key === 'sidebarWidth' ? '--sidebar-w' : '--chat-w', `${w}px`);
      };
      const up = () => {
        el.releasePointerCapture(e.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.classList.remove('active');
        document.body.classList.remove('resizing');
        saveSettings();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => {
      state.settings.ui[key] = key === 'sidebarWidth' ? 268 : 400;
      applyLayout();
      saveSettings();
    });
  };
  wire('#rs-left', 'sidebarWidth', 200, 520, 1);
  wire('#rs-right', 'chatWidth', 300, 760, -1);
}

// ───────────── Folders ─────────────

async function openFolder(path) {
  try {
    const canon = await api.setWorkspace(path);
    state.root = canon;
    addRecentFolder(canon);
    state.settings.workspace.expanded = state.settings.workspace.expanded.filter((p) => p.startsWith(canon + '/'));
    await setRoot(canon);
    invalidateFileCache();
    $('#app').classList.add('has-root');
    $('#folder-name').textContent = basename(canon);
    $('#win-title').textContent = basename(canon);
    document.title = `${basename(canon)} · Pino IDE`;
    updateStatus();
    renderWelcome();
    refreshChips();
    return true;
  } catch (e) {
    toast(`Couldn't open that folder: ${formatError(e)}`, { kind: 'error' });
    return false;
  }
}

async function chooseFolder() {
  if (hasDirty()) {
    const ok = await closeAll();
    if (!ok) return;
  } else await closeAll();
  const p = await api.pickFolder();
  if (p) await openFolder(p);
}

async function openRecent(path) {
  if (!(await closeAll())) return;
  state.settings.workspace.openFiles = [];
  state.settings.workspace.expanded = [];
  const ok = await openFolder(path);
  if (!ok) {
    state.settings.workspace.recent = state.settings.workspace.recent.filter((p) => p !== path);
    saveSettings();
    renderWelcome();
  }
}

async function restoreSession() {
  const last = state.settings.workspace.last;
  if (!last) return;
  const files = [...state.settings.workspace.openFiles];
  const active = state.settings.workspace.active;
  if (!(await openFolder(last))) return;
  for (const f of files) if (f !== active && f.startsWith(last + '/')) await openFile(f, { silent: true });
  if (active && active.startsWith(last + '/')) await openFile(active, { silent: true });
  if (active) revealInTree(active);
}

// ───────────── Welcome ─────────────

function renderWelcome() {
  const el = $('#welcome');
  const recent = state.settings.workspace.recent;
  el.replaceChildren(
    h('div', { class: 'welcome-inner' },
      h('div', { class: 'welcome-mark', html: PINO_MARK }),
      h('h1', {}, 'Pino IDE'),
      h('p', { class: 'welcome-sub' }, 'A quiet, fast editor for your Mac, with the models you already use.'),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn primary lg', onClick: chooseFolder }, h('span', { html: icon('folderOpen') }), 'Open folder'),
        h('button', { class: 'btn lg', onClick: () => openSettings('models') }, h('span', { html: icon('cpu') }), 'Connect models')
      ),
      recent.length
        ? h('div', { class: 'recent' },
            h('div', { class: 'recent-title' }, 'Recent'),
            recent.map((p) => h('button', { class: 'recent-item', onClick: () => openRecent(p), title: p }, h('span', { html: icon('folder') }), h('span', { class: 'r-name' }, basename(p)), h('span', { class: 'r-path' }, p.replace(/^\/Users\/[^/]+/, '~')))))
        : null,
      h('div', { class: 'hints' },
        h('span', {}, h('kbd', {}, `${MOD}O`), 'Open folder'),
        h('span', {}, h('kbd', {}, `${MOD}P`), 'Find a file'),
        h('span', {}, h('kbd', {}, `${MOD}L`), 'Chat'),
        h('span', {}, h('kbd', {}, `${MOD},`), 'Settings')
      )
    )
  );
}

// ───────────── Status bar ─────────────

let cursor = { line: 1, col: 1, selected: 0 };

function updateStatus() {
  const doc = getActiveDoc();
  const ed = state.settings.editor;
  const sel = state.settings.selected;
  const ac = state.settings.autocomplete;
  const bar = $('#statusbar');
  bar.replaceChildren(
    h('div', { class: 'sb-left' },
      state.root ? h('span', { class: 'sb-item', id: 'sb-branch' }) : null,
      state.root ? h('span', { class: 'sb-item' }, h('span', { html: icon('folder') }), basename(state.root)) : null
    ),
    h('div', { class: 'sb-right' },
      doc ? h('span', { class: 'sb-item' }, `Ln ${cursor.line}, Col ${cursor.col}${cursor.selected ? ` (${cursor.selected} selected)` : ''}`) : null,
      doc ? h('span', { class: 'sb-item' }, doc.model.getLanguageId()) : null,
      doc ? h('span', { class: 'sb-item' }, `Spaces: ${ed.tabSize}`) : null,
      h('button', { class: 'sb-item btn-like', title: 'Inline suggestions', onClick: () => openSettings('autocomplete') }, h('span', { html: icon('bolt') }), ac.enabled ? 'Autocomplete on' : 'Autocomplete off'),
      h('button', { class: 'sb-item btn-like', title: 'Choose a model', onClick: () => (toggleChat(true), $('.model-btn')?.click()) }, h('span', { html: icon('sparkle') }), sel.model || 'No model')
    )
  );
  if (state.root) {
    api.gitBranch(state.root).then((b) => {
      const el = $('#sb-branch');
      if (el && b) el.replaceChildren(h('span', { html: icon('branch') }), b);
      else el?.remove();
    }).catch(() => {});
  }
}

// ───────────── Shortcuts and commands ─────────────

const COMMANDS = [
  { title: 'Open folder…', keys: `${MOD}O`, icon: 'folderOpen', run: chooseFolder },
  { title: 'Find file', keys: `${MOD}P`, icon: 'search', run: () => openPalette() },
  { title: 'New file', icon: 'newFile', run: () => newEntry(false) },
  { title: 'New folder', icon: 'newFolder', run: () => newEntry(true) },
  { title: 'Save', keys: `${MOD}S`, icon: 'check', run: saveActive },
  { title: 'Save all', keys: isMac ? '⌥⌘S' : 'Ctrl+Alt+S', icon: 'check', run: saveAll },
  { title: 'Close tab', keys: `${MOD}W`, icon: 'close', run: () => getActiveDoc() && closeDoc(getActiveDoc().path) },
  { title: 'Toggle sidebar', keys: `${MOD}B`, icon: 'sidebar', run: toggleSidebar },
  { title: 'Toggle chat', keys: `${MOD}J`, icon: 'chat', run: () => toggleChat() },
  { title: 'Focus chat', keys: `${MOD}L`, icon: 'chat', run: () => toggleChat(true) },
  { title: 'Ask about selected code', keys: isMac ? '⇧⌘L' : 'Ctrl+Shift+L', icon: 'code', run: () => (toggleChat(true), attachSelection()) },
  { title: 'New chat', icon: 'plus', run: newChat },
  { title: 'Chat: Ask mode', icon: 'chat', run: () => setMode('ask') },
  { title: 'Chat: Edit mode', icon: 'pencil', run: () => setMode('edit') },
  { title: 'Settings', keys: `${MOD},`, icon: 'settings', run: () => openSettings() },
  { title: 'Settings: Models', icon: 'cpu', run: () => openSettings('models') },
  { title: 'Settings: Autocomplete', icon: 'bolt', run: () => openSettings('autocomplete') },
  { title: 'Refresh file tree', icon: 'refresh', run: refreshTree },
  { title: 'Reveal active file in sidebar', icon: 'eye', run: () => getActiveDoc() && revealInTree(getActiveDoc().path) },
  { title: 'Toggle minimap', icon: 'palette', run: () => { updateSetting('editor.minimap', !state.settings.editor.minimap); getEditor()?.updateOptions({ minimap: { enabled: state.settings.editor.minimap } }); } },
  { title: 'Toggle word wrap', icon: 'palette', run: () => { const v = state.settings.editor.wordWrap === 'on' ? 'off' : 'on'; updateSetting('editor.wordWrap', v); getEditor()?.updateOptions({ wordWrap: v }); } },
  { title: 'Toggle autocomplete', icon: 'bolt', run: () => { updateSetting('autocomplete.enabled', !state.settings.autocomplete.enabled); updateStatus(); } },
];

function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const run = (fn) => (e.preventDefault(), e.stopPropagation(), fn());
    if (k === 's' && e.altKey) run(saveAll);
    else if (k === 's') run(saveActive);
    else if (k === 'o') run(chooseFolder);
    else if (k === 'p' && e.shiftKey) run(() => openPalette({ mode: 'commands' }));
    else if (k === 'p') run(() => openPalette());
    else if (k === 'b') run(toggleSidebar);
    else if (k === 'j') run(() => toggleChat());
    else if (k === 'l' && e.shiftKey) run(() => (toggleChat(true), attachSelection()));
    else if (k === 'l') run(() => toggleChat(true));
    else if (k === ',') run(() => openSettings());
    else if (k === 'w') run(() => getActiveDoc() && closeDoc(getActiveDoc().path));
    else if (e.ctrlKey && e.key === 'Tab') run(() => switchRelative(e.shiftKey ? -1 : 1));
    else if (e.shiftKey && (e.key === '[' || e.key === '{')) run(() => switchRelative(-1));
    else if (e.shiftKey && (e.key === ']' || e.key === '}')) run(() => switchRelative(1));
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Tab') (e.preventDefault(), switchRelative(e.shiftKey ? -1 : 1));
  });
}

// ───────────── Boot ─────────────

function buildShell() {
  $('#btn-sidebar').innerHTML = icon('sidebar');
  $('#btn-chat').innerHTML = icon('chat');
  $('#btn-settings').innerHTML = icon('settings');
  $('#btn-search').innerHTML = icon('search');
  $('#btn-newfile').innerHTML = icon('newFile');
  $('#btn-newfolder').innerHTML = icon('newFolder');
  $('#btn-refresh').innerHTML = icon('refresh');
  $('#btn-sidebar').addEventListener('click', toggleSidebar);
  $('#btn-chat').addEventListener('click', () => toggleChat());
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-search').addEventListener('click', () => openPalette());
  $('#btn-newfile').addEventListener('click', () => newEntry(false));
  $('#btn-newfolder').addEventListener('click', () => newEntry(true));
  $('#btn-refresh').addEventListener('click', refreshTree);
  $('#folder-head').addEventListener('dblclick', chooseFolder);
  $('#open-folder-side').addEventListener('click', chooseFolder);
  $('#titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    getCurrentWindow().toggleMaximize().catch(() => {});
  });
}

async function boot() {
  if (!inTauri()) {
    document.body.innerHTML = '<div style="color:#e6eaee;font:16px system-ui;padding:48px;max-width:560px">Pino IDE runs inside its desktop shell. Start it with <code>npm run tauri dev</code>.</div>';
    return;
  }
  await loadSettings();
  applyAccent();
  applyLayout();
  buildShell();
  initResizers();
  initExplorerKeys();
  initEditor($('#editor'));
  initCompletion();
  initChat($('#chat'));
  registerCommands(COMMANDS);
  initShortcuts();
  renderWelcome();
  updateStatus();

  on('cursor', (c) => {
    cursor = c;
    updateStatus();
  });
  on('doc:active', () => {
    updateStatus();
    refreshChips();
  });
  on('doc:closed', () => refreshChips());
  on('doc:dirty', () => {
    const d = hasDirty();
    $('#win-dirty').classList.toggle('on', d);
  });
  on('doc:saved', () => invalidateFileCache());

  window.addEventListener('focus', () => {
    reloadFromDisk();
    if (state.root) refreshTree();
  });

  // Close guard
  try {
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (!hasDirty()) return;
      event.preventDefault();
      const choice = await confirmDialog({
        title: 'Quit with unsaved changes?',
        message: 'Some files have changes that are not saved.',
        buttons: [
          { id: 'cancel', label: 'Keep editing' },
          { id: 'discard', label: 'Quit without saving', danger: true },
          { id: 'save', label: 'Save all and quit', primary: true },
        ],
      });
      if (choice === 'save') {
        await saveAll();
        if (!hasDirty()) await getCurrentWindow().destroy();
      } else if (choice === 'discard') await getCurrentWindow().destroy();
    });
  } catch {
    /* not critical */
  }

  // Which providers already have keys? Then restore the session and load model lists.
  await Promise.all(state.settings.providers.map(async (p) => {
    try {
      state.keys[p.id] = await api.secretHas(secretName(p));
    } catch {
      state.keys[p.id] = false;
    }
  }));
  state.cliPath = await api.cliPath().catch(() => null);
  await restoreSession();

  refreshAllModels().then(() => {
    const sel = state.settings.selected;
    if (!sel.model) {
      const pick = ['lmstudio', 'ollama', 'claude-cli', 'claude-api', 'openai', 'grok', 'deepseek'].find((id) => state.models[id]?.length);
      const first = state.settings.providers.find((p) => p.id === pick) || state.settings.providers.find((p) => state.models[p.id]?.length);
      if (first) {
        const m = first.kind === 'claude-cli' ? 'default' : state.models[first.id][0];
        updateSetting('selected', { providerId: first.id, model: m });
      }
    }
    updateModelButton();
    updateStatus();
  });
  updateModelButton();
}

boot();
