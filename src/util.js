export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny hyperscript helper: h('div', {class:'x', onClick}, child, 'text') */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Event bus
const target = new EventTarget();
export const emit = (name, detail) => target.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => {
  const f = (e) => fn(e.detail);
  target.addEventListener(name, f);
  return () => target.removeEventListener(name, f);
};

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

export function rafThrottle(fn) {
  let queued = false;
  return (...a) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...a);
    });
  };
}

export const uid = () => crypto.randomUUID();

// Paths (macOS/Linux style; Tauri gives absolute POSIX paths)
export const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
export const dirname = (p) => {
  const i = p.replace(/[\\/]+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
export const joinPath = (a, b) => (a.endsWith('/') ? a + b : a + '/' + b);
export const relPath = (root, p) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
export const extname = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** Subsequence fuzzy score; -1 means no match. */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += i === last + 1 ? 5 : 1;
      if (i === 0 || '/-_. '.includes(t[i - 1])) score += 4;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score - t.length * 0.01 : -1;
}

export function formatError(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  return e.message || JSON.stringify(e);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
