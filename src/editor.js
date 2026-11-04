import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

import { api } from './api.js';
import { state, saveSettings } from './store.js';
import { $, h, basename, dirname, relPath, extname, debounce, emit, formatError } from './util.js';
import { icon, tintFor } from './icons.js';
import { modal, confirmDialog, toast } from './ui.js';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// Project files rarely resolve their imports inside a bare editor, so skip semantic noise.
const ts = monaco.languages.typescript ?? monaco.typescript;
for (const d of [ts?.javascriptDefaults, ts?.typescriptDefaults]) {
  d?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true });
  d?.setEagerModelSync?.(true);
}

export { monaco };

let editor = null;
/** path -> { path, model, savedVersion, viewState, mtime, dirty } */
const docs = new Map();
let activePath = null;

const MONO_FALLBACK = "'SF Mono', Menlo, Monaco, 'Courier New', monospace";

export function applyTheme(accent = state.settings.appearance.accent) {
  monaco.editor.defineTheme('pino', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e6eaee' },
      { token: 'comment', foreground: '5d6773', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c3a9ff' },
      { token: 'keyword.control', foreground: 'c3a9ff' },
      { token: 'string', foreground: '9be3b9' },
      { token: 'string.escape', foreground: '7cd6c4' },
      { token: 'number', foreground: 'ffb86b' },
      { token: 'regexp', foreground: '7cd6c4' },
      { token: 'type', foreground: '7cc4ff' },
      { token: 'type.identifier', foreground: '7cc4ff' },
      { token: 'tag', foreground: 'ff9a8a' },
      { token: 'attribute.name', foreground: 'ffcf8a' },
      { token: 'attribute.value', foreground: '9be3b9' },
      { token: 'delimiter', foreground: '8b95a1' },
      { token: 'variable', foreground: 'e6eaee' },
      { token: 'variable.predefined', foreground: 'ffb4c8' },
      { token: 'constant', foreground: 'ffb86b' },
    ],
    colors: {
      'editor.background': '#050607',
      'editor.foreground': '#e6eaee',
      'editorGutter.background': '#050607',
      'editorLineNumber.foreground': '#363e48',
      'editorLineNumber.activeForeground': '#98a2ae',
      'editor.lineHighlightBackground': '#0b0d10',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': accent + '38',
      'editor.inactiveSelectionBackground': accent + '1f',
      'editor.selectionHighlightBackground': accent + '1f',
      'editor.wordHighlightBackground': accent + '1a',
      'editor.findMatchBackground': accent + '55',
      'editor.findMatchHighlightBackground': accent + '2a',
      'editorCursor.foreground': accent,
      'editorIndentGuide.background1': '#101318',
      'editorIndentGuide.activeBackground1': '#262c34',
      'editorBracketMatch.background': accent + '22',
      'editorBracketMatch.border': accent + '66',
      'editorWhitespace.foreground': '#1a1e24',
      'editorWidget.background': '#0b0d10',
      'editorWidget.border': '#1b2027',
      'editorSuggestWidget.background': '#0b0d10',
      'editorSuggestWidget.border': '#1b2027',
      'editorSuggestWidget.selectedBackground': '#161a20',
      'editorHoverWidget.background': '#0b0d10',
      'editorHoverWidget.border': '#1b2027',
      'editorGhostText.foreground': '#5f6b78',
      'input.background': '#0f1216',
      'list.hoverBackground': '#12161b',
      'scrollbarSlider.background': '#ffffff12',
      'scrollbarSlider.hoverBackground': '#ffffff22',
      'scrollbarSlider.activeBackground': '#ffffff30',
      'minimap.background': '#050607',
      'stickyScroll.background': '#080a0c',
      'stickyScrollHover.background': '#0e1115',
      'diffEditor.insertedTextBackground': '#4ade8022',
      'diffEditor.insertedLineBackground': '#4ade800f',
      'diffEditor.removedTextBackground': '#ff6b6b26',
      'diffEditor.removedLineBackground': '#ff6b6b10',
      'diffEditorGutter.insertedLineBackground': '#4ade8018',
      'diffEditorGutter.removedLineBackground': '#ff6b6b18',
    },
  });
  monaco.editor.setTheme('pino');
}

function editorOptions() {
  const e = state.settings.editor;
  return {
    fontFamily: `'${e.fontFamily}', ${MONO_FALLBACK}`,
    fontSize: e.fontSize,
    lineHeight: Math.round(e.fontSize * e.lineHeight),
    fontLigatures: e.ligatures,
    minimap: { enabled: e.minimap, renderCharacters: false, scale: 1 },
    wordWrap: e.wordWrap,
    tabSize: e.tabSize,
    stickyScroll: { enabled: e.stickyScroll },
  };
}

export function applyEditorSettings() {
  if (!editor) return;
  editor.updateOptions(editorOptions());
  monaco.editor.remeasureFonts();
}

export function initEditor(container) {
  applyTheme();
  editor = monaco.editor.create(container, {
    model: null,
    theme: 'pino',
    ...editorOptions(),
    automaticLayout: true,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    cursorBlinking: 'smooth',
    roundedSelection: true,
    scrollBeyondLastLine: false,
    padding: { top: 14, bottom: 14 },
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    renderLineHighlight: 'line',
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    inlineSuggest: { enabled: true, mode: 'subwordSmart' },
    fixedOverflowWidgets: true,
    mouseWheelZoom: true,
    renderWhitespace: 'selection',
    folding: true,
    glyphMargin: false,
    lineNumbersMinChars: 3,
    contextmenu: true,
    quickSuggestions: { other: true, comments: false, strings: false },
    acceptSuggestionOnEnter: 'smart',
  });

  editor.onDidChangeCursorPosition((e) => {
    const sel = editor.getSelection();
    const m = editor.getModel();
    const selected = sel && !sel.isEmpty() && m ? m.getValueInRange(sel).length : 0;
    emit('cursor', { line: e.position.lineNumber, col: e.position.column, selected });
  });

  document.fonts?.load(`13px "${state.settings.editor.fontFamily}"`).then(() => monaco.editor.remeasureFonts()).catch(() => {});
  renderTabs();
  return editor;
}

export const getEditor = () => editor;
export const getDoc = (path) => docs.get(path) || null;
export const getActiveDoc = () => (activePath ? docs.get(activePath) || null : null);
export const listDocs = () => [...docs.values()];
export const hasDirty = () => listDocs().some((d) => d.dirty);

const autoSave = debounce((path) => {
  const d = docs.get(path);
  if (d?.dirty) saveDoc(d).catch(() => {});
}, 900);

function describeOpenError(err) {
  const s = formatError(err);
  if (s === 'BINARY') return "This file looks binary, so it can't be edited here.";
  if (s === 'TOO_LARGE') return 'This file is larger than 8 MB, so it was not opened.';
  if (s === 'NOT_UTF8') return "This file isn't UTF-8 text, so opening it could corrupt it.";
  return s;
}

export async function openFile(path, { line, col, silent } = {}) {
  let doc = docs.get(path);
  if (!doc) {
    let res;
    try {
      res = await api.readFile(path);
    } catch (e) {
      if (!silent) toast(describeOpenError(e), { kind: 'error' });
      return null;
    }
    const model = monaco.editor.createModel(res.content, undefined, monaco.Uri.file(path));
    doc = { path, model, savedVersion: model.getAlternativeVersionId(), viewState: null, mtime: res.mtimeMs, dirty: false };
    model.onDidChangeContent(() => {
      const dirty = model.getAlternativeVersionId() !== doc.savedVersion;
      if (dirty !== doc.dirty) {
        doc.dirty = dirty;
        renderTabs();
        emit('doc:dirty', doc);
      }
      if (state.settings.editor.autoSave === 'afterDelay') autoSave(path);
    });
    docs.set(path, doc);
  }
  activate(path);
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: col || 1 });
  }
  editor.focus();
  return doc;
}

function activate(path) {
  const prev = getActiveDoc();
  if (prev) prev.viewState = editor.saveViewState();
  activePath = path;
  const doc = docs.get(path);
  editor.setModel(doc.model);
  if (doc.viewState) editor.restoreViewState(doc.viewState);
  renderTabs();
  emit('doc:active', doc);
  persistTabs();
}

function persistTabs() {
  state.settings.workspace.openFiles = [...docs.keys()];
  state.settings.workspace.active = activePath;
  saveSettings();
}

export async function saveDoc(doc) {
  try {
    const mtime = await api.writeFile(doc.path, doc.model.getValue());
    doc.savedVersion = doc.model.getAlternativeVersionId();
    doc.mtime = mtime;
    doc.dirty = false;
    renderTabs();
    emit('doc:dirty', doc);
    emit('doc:saved', doc);
    return true;
  } catch (e) {
    toast(`Couldn't save ${basename(doc.path)}: ${formatError(e)}`, { kind: 'error' });
    return false;
  }
}

export const saveActive = async () => {
  const d = getActiveDoc();
  return d ? saveDoc(d) : false;
};

export async function saveAll() {
  for (const d of listDocs().filter((x) => x.dirty)) await saveDoc(d);
}

export async function closeDoc(path, { force = false } = {}) {
  const doc = docs.get(path);
  if (!doc) return true;
  if (doc.dirty && !force) {
    const choice = await confirmDialog({
      title: `Save changes to ${basename(path)}?`,
      message: "Your changes will be lost if you don't save them.",
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'discard', label: "Don't save", danger: true },
        { id: 'save', label: 'Save', primary: true },
      ],
    });
    if (!choice || choice === 'cancel') return false;
    if (choice === 'save' && !(await saveDoc(doc))) return false;
  }
  const order = [...docs.keys()];
  const idx = order.indexOf(path);
  docs.delete(path);
  if (activePath === path) {
    const next = order[idx + 1] || order[idx - 1] || null;
    if (next) activate(next);
    else {
      activePath = null;
      editor.setModel(null);
      emit('doc:active', null);
    }
  }
  doc.model.dispose();
  renderTabs();
  persistTabs();
  emit('doc:closed', path);
  return true;
}

export async function closeAll() {
  for (const p of [...docs.keys()]) if (!(await closeDoc(p))) return false;
  return true;
}

export function closeDocsUnder(path) {
  for (const p of [...docs.keys()]) if (p === path || p.startsWith(path + '/')) closeDoc(p, { force: true });
}

/** After a rename on disk, re-point open documents at the new path. */
export async function movedPath(from, to) {
  const affected = [...docs.keys()].filter((p) => p === from || p.startsWith(from + '/'));
  const wasActive = activePath;
  for (const old of affected) {
    const next = to + old.slice(from.length);
    const d = docs.get(old);
    const content = d.model.getValue();
    const dirty = d.dirty;
    await closeDoc(old, { force: true });
    const nd = await openFile(next, { silent: true });
    if (nd && dirty) nd.model.setValue(content);
  }
  if (wasActive && docs.has(wasActive)) activate(wasActive);
}

export function switchRelative(delta) {
  const order = [...docs.keys()];
  if (order.length < 2) return;
  const i = order.indexOf(activePath);
  activate(order[(i + delta + order.length) % order.length]);
  editor.focus();
}

/** Replace a document's text as an undoable edit and mark it saved after a disk write. */
export function setDocText(path, text, { saved = false } = {}) {
  const d = docs.get(path);
  if (!d) return;
  const full = d.model.getFullModelRange();
  d.model.pushEditOperations([], [{ range: full, text }], () => null);
  if (saved) {
    d.savedVersion = d.model.getAlternativeVersionId();
    d.dirty = false;
    renderTabs();
    emit('doc:dirty', d);
  }
}

/** Call when the window regains focus: pick up changes made outside the IDE (git, Claude Code, ...). */
export async function reloadFromDisk() {
  for (const d of listDocs()) {
    try {
      const m = await api.mtime(d.path);
      if (m === d.mtime) continue;
      if (d.dirty) {
        d.mtime = m;
        toast(`${basename(d.path)} changed on disk. Your unsaved version is still open.`, { kind: 'info' });
        continue;
      }
      const res = await api.readFile(d.path);
      if (res.content !== d.model.getValue()) {
        const vs = d.path === activePath ? editor.saveViewState() : null;
        d.model.setValue(res.content);
        if (vs) editor.restoreViewState(vs);
      }
      d.savedVersion = d.model.getAlternativeVersionId();
      d.mtime = res.mtimeMs;
      d.dirty = false;
    } catch {
      /* deleted or unreadable: leave the tab as is */
    }
  }
  renderTabs();
}

export function getSelectionInfo() {
  const d = getActiveDoc();
  if (!d || !editor) return null;
  const sel = editor.getSelection();
  if (!sel || sel.isEmpty()) return null;
  return {
    path: d.path,
    text: d.model.getValueInRange(sel),
    startLine: sel.startLineNumber,
    endLine: sel.endLineNumber,
    range: sel,
  };
}

export function insertAtCursor(text) {
  if (!editor || !editor.getModel()) return false;
  const sel = editor.getSelection();
  editor.executeEdits('pino-chat', [{ range: sel, text, forceMoveMarkers: true }]);
  editor.focus();
  return true;
}

// ───────────── Tabs and breadcrumbs ─────────────

export function renderTabs() {
  const bar = $('#tabs');
  const crumbs = $('#crumbs');
  if (!bar) return;
  bar.replaceChildren();
  for (const d of docs.values()) {
    const name = basename(d.path);
    const active = d.path === activePath;
    const closeBtn = h('button', {
      class: 'tab-close',
      title: d.dirty ? 'Unsaved changes. Click to close.' : 'Close (⌘W)',
      'aria-label': `Close ${name}`,
      onClick: (e) => {
        e.stopPropagation();
        closeDoc(d.path);
      },
      html: d.dirty ? '<span class="dirty-dot"></span>' : icon('close'),
    });
    const tab = h(
      'div',
      {
        class: `tab ${active ? 'active' : ''} ${d.dirty ? 'dirty' : ''}`,
        role: 'tab',
        'aria-selected': active ? 'true' : 'false',
        tabindex: '0',
        title: relPath(state.root, d.path),
        onClick: () => active || (activate(d.path), editor.focus()),
        onAuxclick: (e) => e.button === 1 && closeDoc(d.path),
        onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), activate(d.path)),
      },
      h('span', { class: 'tab-dot', style: { background: tintFor(extname(name)) } }),
      h('span', { class: 'tab-name' }, name),
      closeBtn
    );
    bar.append(tab);
    if (active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
  const showEditor = docs.size > 0;
  $('#editor')?.classList.toggle('hidden', !showEditor);
  $('#welcome')?.classList.toggle('hidden', showEditor);
  $('#tabs-wrap')?.classList.toggle('hidden', !showEditor);

  if (crumbs) {
    crumbs.replaceChildren();
    if (activePath) {
      const rel = relPath(state.root, activePath);
      const parts = rel.split('/');
      parts.forEach((part, i) => {
        if (i) crumbs.append(h('span', { class: 'crumb-sep', html: icon('chevronRight') }));
        crumbs.append(h('span', { class: i === parts.length - 1 ? 'crumb last' : 'crumb' }, part));
      });
    }
  }
}

// ───────────── Chat code highlighting ─────────────

const ALIASES = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', md: 'markdown', rs: 'rust', cs: 'csharp', 'c++': 'cpp', rb: 'ruby' };
let languageIds = null;

export function resolveLanguage(lang) {
  if (!lang) return 'plaintext';
  languageIds ??= new Set(monaco.languages.getLanguages().map((l) => l.id));
  const l = lang.toLowerCase();
  const id = ALIASES[l] || l;
  if (languageIds.has(id)) return id;
  const byAlias = monaco.languages.getLanguages().find((x) => x.aliases?.some((a) => a.toLowerCase() === l));
  return byAlias?.id || 'plaintext';
}

export async function colorizeCode(text, lang) {
  try {
    return await monaco.editor.colorize(text, resolveLanguage(lang), { tabSize: 2 });
  } catch {
    return null;
  }
}

// ───────────── Diff review ─────────────

/**
 * Show original vs proposed text and resolve true when the user applies it.
 */
export function reviewDiff({ title, path, original, modified, applyLabel = 'Apply changes', rejectLabel = 'Discard' }) {
  return new Promise((resolve) => {
    const language = resolveLanguage(extname(basename(path)));
    const host = h('div', { class: 'diff-host' });
    let decided = false;
    let diff = null;
    let om = null;
    let mm = null;
    let inline = false;

    const toggle = h('button', {
      class: 'btn ghost sm',
      onClick: () => {
        inline = !inline;
        diff?.updateOptions({ renderSideBySide: !inline });
        toggle.textContent = inline ? 'Side by side' : 'Inline';
      },
    }, 'Inline');

    const dispose = () => {
      diff?.dispose();
      om?.dispose();
      mm?.dispose();
    };
    const finish = (v, close) => {
      decided = true;
      resolve(v);
      close?.();
    };

    modal({
      title,
      className: 'wide',
      width: 1180,
      body: h('div', { class: 'diff-wrap' }, h('div', { class: 'diff-bar' }, h('span', { class: 'diff-path' }, path), toggle), host),
      actions: [
        { label: rejectLabel, onClick: (close) => finish(false, close) },
        { label: applyLabel, primary: true, onClick: (close) => finish(true, close) },
      ],
      onClose: () => {
        dispose();
        if (!decided) resolve(false);
      },
    });

    om = monaco.editor.createModel(original, language);
    mm = monaco.editor.createModel(modified, language);
    diff = monaco.editor.createDiffEditor(host, {
      theme: 'pino',
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      originalEditable: false,
      fontFamily: `'${state.settings.editor.fontFamily}', ${MONO_FALLBACK}`,
      fontSize: state.settings.editor.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 10, bottom: 10 },
      overviewRulerBorder: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      renderIndicators: true,
      ignoreTrimWhitespace: false,
    });
    diff.setModel({ original: om, modified: mm });
  });
}

export { dirname };
