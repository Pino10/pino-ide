import { api } from './api.js';
import { state, saveSettings } from './store.js';
import { $, h, basename, dirname, joinPath, extname, formatError, on, relPath } from './util.js';
import { icon, tintFor } from './icons.js';
import { contextMenu, confirmDialog, promptDialog, toast } from './ui.js';
import { openFile, closeDocsUnder, movedPath, getActiveDoc } from './editor.js';

const DIM = new Set(['node_modules', '.git', 'vendor', 'target', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.idea', 'Pods']);

const expanded = new Set();
/** dir path -> DirEntry[] */
const cache = new Map();
let root = null;
let selected = null;

const tree = () => $('#tree');

async function load(dir) {
  try {
    const entries = await api.listDir(dir);
    cache.set(dir, entries);
    return entries;
  } catch (e) {
    toast(`Couldn't read ${basename(dir)}: ${formatError(e)}`, { kind: 'error' });
    cache.set(dir, []);
    return [];
  }
}

export async function setRoot(path) {
  root = path;
  cache.clear();
  expanded.clear();
  selected = null;
  const saved = state.settings.workspace.expanded || [];
  for (const p of saved) if (p.startsWith(path + '/')) expanded.add(p);
  await load(root);
  await Promise.all([...expanded].map((p) => load(p)));
  render();
}

export async function refreshTree() {
  if (!root) return;
  const dirs = [root, ...expanded];
  await Promise.all(dirs.map((d) => load(d)));
  for (const p of [...expanded]) if (!cache.get(p)?.length && !(await dirExists(p))) expanded.delete(p);
  render();
}

async function dirExists(p) {
  try {
    await api.listDir(p);
    return true;
  } catch {
    return false;
  }
}

function persistExpanded() {
  state.settings.workspace.expanded = [...expanded];
  saveSettings();
}

async function toggleDir(path) {
  if (expanded.has(path)) {
    expanded.delete(path);
  } else {
    expanded.add(path);
    if (!cache.has(path)) await load(path);
  }
  persistExpanded();
  render();
}

function fileIcon(name) {
  return `<span class="ficon" style="color:${tintFor(extname(name))}">${icon('file')}</span>`;
}

function rowFor(entry, depth) {
  const isOpen = entry.isDir && expanded.has(entry.path);
  const row = h(
    'div',
    {
      class: `row ${entry.isDir ? 'dir' : 'file'} ${DIM.has(entry.name) ? 'dim' : ''} ${selected === entry.path ? 'selected' : ''}`,
      role: 'treeitem',
      'aria-expanded': entry.isDir ? String(isOpen) : null,
      'aria-level': String(depth + 1),
      tabindex: '-1',
      'data-path': entry.path,
      style: { paddingLeft: `${10 + depth * 14}px` },
      onClick: () => {
        selected = entry.path;
        if (entry.isDir) toggleDir(entry.path);
        else {
          markSelected();
          openFile(entry.path);
        }
        markSelected();
      },
      onContextmenu: (e) => {
        e.preventDefault();
        selected = entry.path;
        markSelected();
        menuFor(e.clientX, e.clientY, entry);
      },
    },
    h('span', { class: `chev ${entry.isDir ? '' : 'none'} ${isOpen ? 'open' : ''}`, html: icon('chevronRight') }),
    entry.isDir
      ? h('span', { class: 'ficon folder', html: icon(isOpen ? 'folderOpen' : 'folder') })
      : h('span', { html: fileIcon(entry.name) }),
    h('span', { class: 'rname' }, entry.name)
  );
  return row;
}

function walk(dir, depth, out) {
  for (const entry of cache.get(dir) || []) {
    out.push(rowFor(entry, depth));
    if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1, out);
  }
}

export function render() {
  const el = tree();
  if (!el) return;
  const scroll = el.scrollTop;
  el.replaceChildren();
  if (!root) return;
  const rows = [];
  walk(root, 0, rows);
  if (!rows.length) el.append(h('div', { class: 'tree-empty' }, 'This folder is empty.'));
  el.append(...rows);
  el.scrollTop = scroll;
  markActive();
}

function markSelected() {
  tree()
    ?.querySelectorAll('.row.selected')
    .forEach((r) => r.classList.remove('selected'));
  if (selected) tree()?.querySelector(`.row[data-path="${CSS.escape(selected)}"]`)?.classList.add('selected');
}

function markActive() {
  const el = tree();
  if (!el) return;
  el.querySelectorAll('.row.active').forEach((r) => r.classList.remove('active'));
  const d = getActiveDoc();
  if (d) el.querySelector(`.row[data-path="${CSS.escape(d.path)}"]`)?.classList.add('active');
}

on('doc:active', markActive);

/** Expand parents of a file and scroll it into view. */
export async function revealInTree(path) {
  if (!root || !path.startsWith(root + '/')) return;
  const parts = relPath(root, path).split('/').slice(0, -1);
  let cur = root;
  for (const part of parts) {
    cur = joinPath(cur, part);
    expanded.add(cur);
    if (!cache.has(cur)) await load(cur);
  }
  persistExpanded();
  render();
  selected = path;
  markSelected();
  tree()?.querySelector(`.row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' });
}

function targetDir(entry) {
  if (entry) return entry.isDir ? entry.path : dirname(entry.path);
  if (selected) {
    const known = [...cache.values()].flat().find((e) => e.path === selected);
    if (known) return known.isDir ? known.path : dirname(known.path);
  }
  return root;
}

export async function newEntry(isDir, entry = null) {
  if (!root) return;
  const dir = targetDir(entry);
  const where = dir === root ? basename(root) : relPath(root, dir);
  const name = await promptDialog({
    title: isDir ? 'New folder' : 'New file',
    label: `Name (inside ${where})`,
    placeholder: isDir ? 'components' : 'index.php',
    confirmText: 'Create',
  });
  if (!name) return;
  if (/[\\]|^\.\.?$|\.\.\//.test(name)) return toast("That name isn't allowed.", { kind: 'error' });
  const full = joinPath(dir, name);
  try {
    await api.createEntry(full, isDir);
    expanded.add(dir);
    await refreshTree();
    persistExpanded();
    if (!isDir) openFile(full);
  } catch (e) {
    toast(formatError(e), { kind: 'error' });
  }
}

async function rename(entry) {
  const name = await promptDialog({ title: 'Rename', label: 'New name', value: entry.name, confirmText: 'Rename' });
  if (!name || name === entry.name) return;
  if (/[\\/]/.test(name)) return toast("Names can't contain slashes.", { kind: 'error' });
  const to = joinPath(dirname(entry.path), name);
  try {
    await api.renameEntry(entry.path, to);
    await movedPath(entry.path, to);
    if (expanded.delete(entry.path)) expanded.add(to);
    await refreshTree();
  } catch (e) {
    toast(formatError(e), { kind: 'error' });
  }
}

async function trash(entry) {
  const choice = await confirmDialog({
    title: `Move ${entry.name} to the Trash?`,
    message: entry.isDir ? 'The folder and everything in it will be moved to the Trash.' : 'You can restore it from the Trash.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Move to Trash', danger: true },
    ],
  });
  if (choice !== 'ok') return;
  try {
    await api.deleteEntry(entry.path);
    closeDocsUnder(entry.path);
    expanded.delete(entry.path);
    await refreshTree();
  } catch (e) {
    toast(formatError(e), { kind: 'error' });
  }
}

function menuFor(x, y, entry) {
  contextMenu(x, y, [
    { label: 'New file', icon: 'newFile', onClick: () => newEntry(false, entry) },
    { label: 'New folder', icon: 'newFolder', onClick: () => newEntry(true, entry) },
    { separator: true },
    { label: 'Rename', icon: 'pencil', onClick: () => rename(entry) },
    { label: 'Show in Finder', icon: 'reveal', onClick: () => api.reveal(entry.path).catch((e) => toast(formatError(e), { kind: 'error' })) },
    { label: 'Copy path', icon: 'copy', onClick: () => navigator.clipboard?.writeText(entry.path).then(() => toast('Path copied', { kind: 'success' })) },
    { separator: true },
    { label: 'Move to Trash', icon: 'trash', danger: true, onClick: () => trash(entry) },
  ]);
}

/** Keyboard navigation (arrows, Enter) for the tree. */
export function initExplorerKeys() {
  const el = tree();
  el.addEventListener('contextmenu', (e) => {
    if (e.target === el && root) {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'New file', icon: 'newFile', onClick: () => newEntry(false) },
        { label: 'New folder', icon: 'newFolder', onClick: () => newEntry(true) },
      ]);
    }
  });
  el.addEventListener('keydown', (e) => {
    const rows = [...el.querySelectorAll('.row')];
    const cur = document.activeElement?.closest?.('.row');
    const i = rows.indexOf(cur);
    const go = (n) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, n))];
      r?.focus();
      selected = r?.dataset.path || null;
      markSelected();
    };
    if (e.key === 'ArrowDown') (e.preventDefault(), go(i + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), go(i - 1));
    else if (cur && (e.key === 'Enter' || e.key === ' ')) (e.preventDefault(), cur.click());
    else if (cur && e.key === 'ArrowRight' && cur.classList.contains('dir') && !expanded.has(cur.dataset.path)) toggleDir(cur.dataset.path);
    else if (cur && e.key === 'ArrowLeft' && cur.classList.contains('dir') && expanded.has(cur.dataset.path)) toggleDir(cur.dataset.path);
  });
  el.addEventListener('focusin', (e) => {
    if (e.target === el) el.querySelector('.row')?.focus();
  });
}
