// Rounded, 1.8px stroke icons on a 24px grid.
const p = (d) => `<path d="${d}"/>`;
const wrap = (inner, fill = 'none') =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS = {
  sidebar: wrap('<rect x="3.5" y="4.5" width="17" height="15" rx="4"/>' + p('M9.5 4.5v15')),
  chat: wrap('<rect x="3.5" y="4.5" width="17" height="15" rx="4"/>' + p('M14.5 4.5v15')),
  search: wrap('<circle cx="11" cy="11" r="6.5"/>' + p('m20 20-4-4')),
  settings: wrap(
    '<circle cx="12" cy="12" r="3"/>' +
      p('M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z')
  ),
  folder: wrap(p('M3.5 7.5a2.5 2.5 0 0 1 2.5-2.5h3.4l2 2.2H18a2.5 2.5 0 0 1 2.5 2.5v7.3A2.5 2.5 0 0 1 18 19.5H6a2.5 2.5 0 0 1-2.5-2.5Z')),
  folderOpen: wrap(p('M3.5 17V7.5A2.5 2.5 0 0 1 6 5h3.4l2 2.2H18a2.5 2.5 0 0 1 2.5 2.5v.8') + p('M3.7 17.6 6 11.5a2 2 0 0 1 1.9-1.3H21a1 1 0 0 1 .95 1.3l-1.9 5.8A2 2 0 0 1 18.2 19H6a2.5 2.5 0 0 1-2.3-1.4Z')),
  file: wrap(p('M7 3.5h6.5L19 9v9.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z') + p('M13.5 3.5V9H19')),
  newFile: wrap(p('M7 3.5h6.5L19 9v9.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z') + p('M12 11.5v5M9.5 14h5')),
  newFolder: wrap(p('M3.5 7.5A2.5 2.5 0 0 1 6 5h3.4l2 2.2H18a2.5 2.5 0 0 1 2.5 2.5v7.3a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 1-2.5-2.5Z') + p('M12 10.8v5M9.5 13.3h5')),
  refresh: wrap(p('M20 11a8 8 0 0 0-14.5-4M4 4v3.5h3.5M4 13a8 8 0 0 0 14.5 4M20 20v-3.5h-3.5')),
  plus: wrap(p('M12 5v14M5 12h14')),
  close: wrap(p('M6 6l12 12M18 6 6 18')),
  chevronRight: wrap(p('m9 6 6 6-6 6')),
  chevronDown: wrap(p('m6 9 6 6 6-6')),
  send: wrap(p('M12 19V5M5.5 11.5 12 5l6.5 6.5')),
  stop: wrap('<rect x="7" y="7" width="10" height="10" rx="2.5"/>', 'currentColor'),
  sparkle: wrap(p('M12 3.5c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7Z') + p('M18.5 16.5c.2 1.4.8 2 2 2.2-1.2.2-1.8.8-2 2.2-.2-1.4-.8-2-2-2.2 1.2-.2 1.8-.8 2-2.2Z')),
  check: wrap(p('m5 12.5 4.5 4.5L19 7.5')),
  copy: wrap('<rect x="8.5" y="8.5" width="11" height="11" rx="3"/>' + p('M15.5 8.5v-1a3 3 0 0 0-3-3h-5a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3h1')),
  trash: wrap(p('M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7')),
  pencil: wrap(p('M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z')),
  eye: wrap(p('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z') + '<circle cx="12" cy="12" r="2.8"/>'),
  reveal: wrap(p('M14 4.5h5.5V10M19.5 4.5 11 13M18 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10')),
  link: wrap(p('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1')),
  cpu: wrap('<rect x="6.5" y="6.5" width="11" height="11" rx="3"/>' + p('M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21')),
  keyboard: wrap('<rect x="2.5" y="6" width="19" height="12" rx="3.5"/>' + p('M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9')),
  palette: wrap(p('M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.6-2.1-.5-1.3.3-2.4 1.6-2.4H17a3.5 3.5 0 0 0 3.5-3.5C20.5 7 16.8 3.5 12 3.5Z') + '<circle cx="7.8" cy="11" r=".9" fill="currentColor"/><circle cx="10.5" cy="7.6" r=".9" fill="currentColor"/><circle cx="15" cy="7.8" r=".9" fill="currentColor"/>'),
  code: wrap(p('m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13')),
  bolt: wrap(p('M13 3 5 13.5h6L10 21l8-10.5h-6z')),
  terminal: wrap('<rect x="3" y="4.5" width="18" height="15" rx="4"/>' + p('m7.5 10 3 2.5-3 2.5M12.5 15h4')),
  branch: wrap('<circle cx="7" cy="6" r="2.3"/><circle cx="7" cy="18" r="2.3"/><circle cx="17" cy="9" r="2.3"/>' + p('M7 8.3v7.4M17 11.3c0 3-3 3.7-8.6 5')),
  info: wrap('<circle cx="12" cy="12" r="8.5"/>' + p('M12 11v5M12 8h.01')),
  alert: wrap(p('M12 4 3 19.5h18z') + p('M12 10v4.5M12 17.2h.01')),
  diff: wrap(p('M8 4.5v11M8 15.5a2.3 2.3 0 1 0 0 .01M16 19.5v-11M16 8.5A2.3 2.3 0 1 0 16 8.4M14 6h4')),
  history: wrap(p('M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 4v4.5H8M12 7.5V12l3 2')),
};

export function icon(name) {
  return ICONS[name] || ICONS.file;
}

/** Pino mark: a small pine made of three rounded tiers. */
export const PINO_MARK = `<svg viewBox="0 0 48 48" width="1em" height="1em" aria-hidden="true"><path d="M24 5.5c1.4 0 2.5.7 3.3 1.9l8 12.2c1.4 2.1-.1 4.9-2.6 4.9h-1.7l5.9 8.9c1.5 2.2-.1 5.1-2.7 5.1H27.5V42a3.5 3.5 0 0 1-7 0v-3.5H12.9c-2.6 0-4.2-2.9-2.7-5.1l5.9-8.9h-1.7c-2.5 0-4-2.8-2.6-4.9l8-12.2c.8-1.2 1.9-1.9 3.2-1.9Z" fill="currentColor"/></svg>`;

// File-type tint for the explorer (muted, tonal).
const TINTS = {
  js: '#e6c35c', mjs: '#e6c35c', cjs: '#e6c35c', jsx: '#7cc4ff', ts: '#6fa8ff', tsx: '#6fa8ff',
  php: '#a9a2ff', py: '#79c0ff', r: '#6fa8ff', rs: '#f0a070', go: '#6bd0e0', swift: '#ff9a6b',
  html: '#ff9a6b', css: '#8fb5ff', scss: '#f08fc0', json: '#d9c27a', md: '#9fb0c3', yml: '#e08f8f', yaml: '#e08f8f',
  sql: '#c9a0ff', sh: '#8fe0a8', zsh: '#8fe0a8', env: '#d9c27a', pbix: '#f2c94c', ipynb: '#f2994a',
  svg: '#ffb86b', png: '#8fd3b0', jpg: '#8fd3b0', lock: '#667085', toml: '#b0a088', xml: '#ff9a6b', vue: '#7ed3a0',
};
export function tintFor(ext) {
  return TINTS[ext] || '#8b95a1';
}
