import { api } from './api.js';
import { state } from './store.js';
import { h, basename, dirname, relPath, fuzzyScore, extname, formatError } from './util.js';
import { icon, tintFor } from './icons.js';
import { toast } from './ui.js';
import { openFile } from './editor.js';

const root = () => document.getElementById('overlay-root');

let commands = [];
let fileCache = { root: null, at: 0, files: [] };

export function registerCommands(list) {
  commands = list;
}

export function invalidateFileCache() {
  fileCache.at = 0;
}

async function getFiles() {
  if (!state.root) return [];
  const fresh = fileCache.root === state.root && Date.now() - fileCache.at < 15000;
  if (!fresh) {
    try {
      fileCache = { root: state.root, at: Date.now(), files: await api.listFiles(state.root) };
    } catch (e) {
      toast(formatError(e), { kind: 'error' });
      return [];
    }
  }
  return fileCache.files;
}

let open = null;

/**
 * mode: 'files' (default) or 'commands'. When `pick` is given the palette resolves a
 * chosen absolute file path to it instead of opening the file.
 */
export async function openPalette({ mode = 'files', pick = null, placeholder } = {}) {
  open?.close();
  const files = await getFiles();
  let results = [];
  let index = 0;

  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: placeholder || (mode === 'commands' ? 'Type a command' : 'Search files, or type > for commands'),
    'aria-label': 'Search',
  });
  if (mode === 'commands') input.value = '>';
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const card = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick open' }, h('div', { class: 'palette-head' }, h('span', { class: 'palette-icon', html: icon('search') }), input), list);
  const scrim = h('div', { class: 'scrim top' }, card);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    scrim.classList.remove('in');
    setTimeout(() => scrim.remove(), 140);
    open = null;
  };
  open = { close };

  function compute() {
    const raw = input.value;
    if (raw.startsWith('>') && !pick) {
      const q = raw.slice(1).trim();
      results = commands
        .map((c) => ({ c, s: fuzzyScore(q, c.title) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => ({ type: 'command', cmd: x.c }));
    } else {
      const q = raw.trim();
      results = (q
        ? files
            .map((f) => ({ f, s: Math.max(fuzzyScore(q, basename(f)) * 2, fuzzyScore(q, f)) }))
            .filter((x) => x.s >= 0)
            .sort((a, b) => b.s - a.s)
        : files.slice(0, 60).map((f) => ({ f, s: 0 }))
      )
        .slice(0, 60)
        .map((x) => ({ type: 'file', rel: x.f }));
    }
    index = 0;
    paint();
  }

  function paint() {
    list.replaceChildren();
    if (!results.length) {
      const msg = !state.root && !input.value.startsWith('>') ? 'Open a folder to search its files.' : 'Nothing matches.';
      list.append(h('div', { class: 'palette-empty' }, msg));
      return;
    }
    results.forEach((r, i) => {
      let row;
      if (r.type === 'command') {
        row = h(
          'div',
          { class: 'p-item', role: 'option' },
          h('span', { class: 'p-icon', html: icon(r.cmd.icon || 'bolt') }),
          h('span', { class: 'p-title' }, r.cmd.title),
          r.cmd.keys ? h('kbd', {}, r.cmd.keys) : null
        );
      } else {
        const name = basename(r.rel);
        const dir = dirname(r.rel);
        row = h(
          'div',
          { class: 'p-item', role: 'option' },
          h('span', { class: 'p-icon', style: { color: tintFor(extname(name)) }, html: icon('file') }),
          h('span', { class: 'p-title' }, name),
          dir && dir !== '/' && dir !== '.' ? h('span', { class: 'p-sub' }, dir) : null
        );
      }
      row.setAttribute('aria-selected', i === index ? 'true' : 'false');
      row.classList.toggle('sel', i === index);
      row.addEventListener('pointermove', () => {
        if (index !== i) {
          index = i;
          list.querySelectorAll('.p-item').forEach((n, k) => n.classList.toggle('sel', k === i));
        }
      });
      row.addEventListener('click', () => choose(i));
      list.append(row);
    });
    list.children[index]?.scrollIntoView({ block: 'nearest' });
  }

  async function choose(i) {
    const r = results[i];
    if (!r) return;
    close();
    if (r.type === 'command') r.cmd.run();
    else if (pick) pick(`${state.root}/${r.rel}`);
    else openFile(`${state.root}/${r.rel}`);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      index = Math.min(results.length - 1, index + 1);
      list.querySelectorAll('.p-item').forEach((n, k) => n.classList.toggle('sel', k === index));
      list.children[index]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      index = Math.max(0, index - 1);
      list.querySelectorAll('.p-item').forEach((n, k) => n.classList.toggle('sel', k === index));
      list.children[index]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(index);
    }
  }

  input.addEventListener('input', compute);
  scrim.addEventListener('pointerdown', (e) => e.target === scrim && close());
  document.addEventListener('keydown', onKey, true);
  root().append(scrim);
  requestAnimationFrame(() => scrim.classList.add('in'));
  compute();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Resolve an absolute path chosen from the project's files, or null. */
export function pickProjectFile() {
  return new Promise((resolve) => {
    let picked = false;
    openPalette({ pick: (p) => ((picked = true), resolve(p)), placeholder: 'Choose a file to add to the chat' });
    const watcher = setInterval(() => {
      if (!document.querySelector('.palette')) {
        clearInterval(watcher);
        if (!picked) resolve(null);
      }
    }, 200);
  });
}

export { relPath };
