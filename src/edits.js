import { api } from './api.js';
import { state } from './store.js';
import { getDoc, setDocText } from './editor.js';
import { uid } from './util.js';

/** Instructions that teach any model the edit format Pino can review and apply. */
export const EDIT_RULES = `

When the user asks you to change, fix, add or refactor code, explain briefly, then give the changes in blocks Pino can apply. Paths are relative to the open folder.

To modify an existing file, use one or more SEARCH/REPLACE pairs:

\`\`\`edit path/to/file.ext
<<<<<<< SEARCH
exact lines currently in the file
=======
the new lines
>>>>>>> REPLACE
\`\`\`

To create a new file or replace a file completely:

\`\`\`file path/to/file.ext
the full contents of the file
\`\`\`

Rules: SEARCH text must match the existing file exactly (including indentation) and be unique in the file; keep each SEARCH as small as possible while still unique; never use "..." to skip code; do not wrap these blocks in other fences. If the user only asks a question, answer normally without these blocks.`;

/** Split a markdown reply into prose and edit/file blocks. */
export function parseEdits(markdown) {
  const lines = String(markdown || '').split('\n');
  const blocks = [];
  const prose = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^`{3,}\s*(edit|file)\s+(?:path=)?(.+?)\s*$/.exec(lines[i]);
    if (!m) {
      prose.push(lines[i++]);
      continue;
    }
    const body = [];
    let j = i + 1;
    while (j < lines.length && !/^`{3,}\s*$/.test(lines[j])) body.push(lines[j++]);
    const closed = j < lines.length;
    blocks.push({ kind: m[1], path: m[2].replace(/^["'`]|["'`]$/g, ''), body: body.join('\n'), closed });
    i = j + 1;
  }
  return { prose: prose.join('\n').replace(/\n{3,}/g, '\n\n').trim(), blocks };
}

function parsePairs(body) {
  const pairs = [];
  let mode = null;
  let search = [];
  let replace = [];
  for (const line of body.split('\n')) {
    if (/^<{5,}\s*SEARCH\s*$/.test(line)) {
      mode = 'search';
      search = [];
      replace = [];
    } else if (mode === 'search' && /^={5,}\s*$/.test(line)) mode = 'replace';
    else if (mode === 'replace' && /^>{5,}\s*REPLACE\s*$/.test(line)) {
      pairs.push({ search: search.join('\n'), replace: replace.join('\n') });
      mode = null;
    } else if (mode === 'search') search.push(line);
    else if (mode === 'replace') replace.push(line);
  }
  return pairs;
}

function applyPair(text, { search, replace }) {
  if (search === '') return { text: text ? text + (text.endsWith('\n') ? '' : '\n') + replace : replace };
  let idx = text.indexOf(search);
  if (idx >= 0) {
    const second = text.indexOf(search, idx + 1);
    return { text: text.slice(0, idx) + replace + text.slice(idx + search.length), ambiguous: second >= 0 };
  }
  // Tolerate trailing-whitespace and surrounding blank-line differences.
  const norm = (s) => s.split('\n').map((l) => l.replace(/\s+$/, ''));
  const hay = text.split('\n');
  const needle = norm(search.replace(/^\n+|\n+$/g, ''));
  const hayN = norm(text);
  for (let k = 0; k + needle.length <= hayN.length; k++) {
    if (needle.every((l, n) => l === hayN[k + n])) {
      const out = [...hay.slice(0, k), ...replace.replace(/^\n+|\n+$/g, '').split('\n'), ...hay.slice(k + needle.length)];
      return { text: out.join('\n') };
    }
  }
  return { error: 'The text to replace was not found in the file' };
}

function safeRel(path) {
  const p = path.replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.split('/').includes('..') || p.includes('\\')) return null;
  return p;
}

/** Turn parsed blocks into reviewable per-file proposals. */
export async function buildProposals(blocks) {
  const root = state.root;
  const files = new Map();
  for (const b of blocks) {
    if (!b.closed) continue;
    const rel = safeRel(b.path);
    if (!rel) {
      files.set(b.path, { rel: b.path, abs: null, errors: ['That path is not inside the open folder'], original: '', current: '', exists: false, edits: 0 });
      continue;
    }
    const abs = `${root}/${rel}`;
    let f = files.get(rel);
    if (!f) {
      let original = null;
      const open = getDoc(abs);
      if (open) original = open.model.getValue();
      else {
        try {
          original = (await api.readFile(abs)).content;
        } catch {
          original = null;
        }
      }
      f = { rel, abs, errors: [], original: original ?? '', current: original ?? '', exists: original !== null, edits: 0, crlf: (original ?? '').includes('\r\n') };
      if (f.crlf) {
        f.original = f.original.replace(/\r\n/g, '\n');
        f.current = f.current.replace(/\r\n/g, '\n');
      }
      files.set(rel, f);
    }
    if (b.kind === 'file') {
      f.current = b.body.endsWith('\n') ? b.body : b.body + '\n';
      f.edits++;
    } else {
      const pairs = parsePairs(b.body);
      if (!pairs.length) f.errors.push('No SEARCH/REPLACE pair found in this block');
      for (const pair of pairs) {
        const r = applyPair(f.current, pair);
        if (r.error) f.errors.push(r.error);
        else {
          f.current = r.text;
          f.edits++;
          if (r.ambiguous) f.errors.push('Part of the file matched more than once; the first match was changed. Check the diff.');
        }
      }
    }
  }
  return [...files.values()].map((f) => ({
    id: uid(),
    rel: f.rel,
    abs: f.abs,
    isNew: !f.exists,
    original: f.original,
    modified: f.crlf ? f.current.replace(/\n/g, '\r\n') : f.current,
    originalRaw: f.crlf ? f.original.replace(/\n/g, '\r\n') : f.original,
    errors: f.errors,
    changed: f.edits > 0 && f.current !== f.original,
    status: 'pending',
  }));
}

export async function applyProposal(p) {
  if (!p.abs) throw new Error('This change points outside the open folder');
  const mtime = await api.writeFile(p.abs, p.modified);
  const open = getDoc(p.abs);
  if (open) {
    setDocText(p.abs, p.modified, { saved: true });
    open.mtime = mtime;
  }
  p.status = 'applied';
}

/** Rough +/- line counts for the change card. */
export function diffStats(a, b) {
  const count = (s) => {
    const m = new Map();
    for (const l of s.split('\n')) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const A = count(a);
  const B = count(b);
  let add = 0;
  let del = 0;
  for (const [l, n] of B) add += Math.max(0, n - (A.get(l) || 0));
  for (const [l, n] of A) del += Math.max(0, n - (B.get(l) || 0));
  return { add, del };
}
