import { api } from './api.js';
import { state, saveSettings, updateSetting, secretName, getProvider, ACCENTS } from './store.js';
import { h, formatError, uid } from './util.js';
import { icon } from './icons.js';
import { modal, toast, confirmDialog } from './ui.js';
import { refreshModels, scanLocalServers, needsKey } from './providers.js';
import { applyTheme, applyEditorSettings } from './editor.js';
import { updateModelButton, refreshChips } from './chat.js';

const FONTS = ['Google Sans Code Variable', 'JetBrains Mono Variable', 'SF Mono', 'Menlo'];

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

function toggle(value, onChange, label) {
  const b = h('button', { class: `switch ${value ? 'on' : ''}`, role: 'switch', 'aria-checked': String(!!value), 'aria-label': label, onClick: () => {
    value = !value;
    b.classList.toggle('on', value);
    b.setAttribute('aria-checked', String(value));
    onChange(value);
  } }, h('span', { class: 'knob' }));
  return b;
}

function row(title, desc, control) {
  return h('div', { class: 'srow' }, h('div', { class: 'srow-text' }, h('div', { class: 'srow-title' }, title), desc ? h('div', { class: 'srow-desc' }, desc) : null), control);
}

function select(options, value, onChange, label) {
  const s = h('select', { class: 'input select', 'aria-label': label }, options.map((o) => {
    const [v, text] = Array.isArray(o) ? o : [o, o];
    return h('option', { value: v, selected: v === value }, text);
  }));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function statusPill(id) {
  const st = state.status[id];
  if (!st || st.state === 'idle') return h('span', { class: 'pill' }, 'Not checked');
  if (st.state === 'loading') return h('span', { class: 'pill' }, h('span', { class: 'spinner sm' }), 'Checking');
  if (st.state === 'ok') return h('span', { class: 'pill ok' }, st.message);
  return h('span', { class: 'pill err', title: st.message }, 'Not connected');
}

// ───────────── Models page ─────────────

function providerCard(p, rerender) {
  const keyNeeded = needsKey(p) || p.kind === 'anthropic';
  const wantsKey = keyNeeded || p.custom;
  const card = h('div', { class: 'pcard' });
  const st = state.status[p.id];

  const url = h('input', { class: 'input', value: p.baseUrl, placeholder: 'http://localhost:1234/v1', spellcheck: 'false', 'aria-label': `${p.name} address` });
  url.addEventListener('change', () => {
    p.baseUrl = url.value.trim();
    saveSettings();
    check();
  });

  const keyInput = h('input', { class: 'input', type: 'password', placeholder: state.keys[p.id] ? 'Saved in your Keychain' : 'Paste API key', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${p.name} API key` });
  const saveKey = async () => {
    const v = keyInput.value.trim();
    if (!v) return;
    try {
      await api.secretSet(secretName(p), v);
      state.keys[p.id] = true;
      keyInput.value = '';
      toast(`${p.name} key saved to your Keychain`, { kind: 'success' });
      await check();
    } catch (e) {
      toast(formatError(e), { kind: 'error' });
    }
  };
  keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveKey());

  async function check() {
    if (p.kind === 'claude-cli') state.cliPath = await api.cliPath().catch(() => null);
    await refreshModels(p);
    updateModelButton();
    rerender();
  }

  card.append(
    h('div', { class: 'pcard-head' },
      h('div', { class: 'pcard-name' }, p.name, p.note ? h('span', { class: 'pcard-note' }, p.note) : null),
      statusPill(p.id),
      h('button', { class: 'icon-btn sm', title: 'Check connection', 'aria-label': 'Check connection', onClick: check, html: icon('refresh') }),
      p.custom ? h('button', { class: 'icon-btn sm', title: 'Remove', 'aria-label': 'Remove provider', onClick: async () => {
        state.settings.providers = state.settings.providers.filter((x) => x.id !== p.id);
        await api.secretDelete(secretName(p)).catch(() => {});
        delete state.keys[p.id];
        if (state.settings.selected.providerId === p.id) state.settings.selected = { providerId: null, model: null };
        saveSettings();
        updateModelButton();
        rerender();
      }, html: icon('trash') }) : null
    )
  );

  if (p.kind === 'claude-cli') {
    card.append(
      state.cliPath
        ? h('div', { class: 'pcard-body note' }, h('span', { html: icon('check') }), `Found at ${state.cliPath}. Pino uses the account you signed in with in Terminal.`)
        : h('div', { class: 'pcard-body note warn' }, h('span', { html: icon('alert') }), 'Claude Code was not found. Install it, run "claude" once in Terminal to sign in, then press refresh.')
    );
  } else {
    card.append(h('div', { class: 'pcard-body' }, field('Address', url, p.local || p.custom ? 'The port can change; update it here any time.' : null)));
    if (wantsKey) {
      card.append(
        h('div', { class: 'pcard-body' },
          field('API key', h('div', { class: 'inline' }, keyInput, h('button', { class: 'btn', onClick: saveKey }, 'Save'),
            state.keys[p.id] ? h('button', { class: 'btn ghost', onClick: async () => {
              await api.secretDelete(secretName(p)).catch(() => {});
              state.keys[p.id] = false;
              state.models[p.id] = [];
              state.status[p.id] = { state: 'idle' };
              updateModelButton();
              rerender();
            } }, 'Remove') : null),
          p.custom ? 'Optional for local servers.' : 'Stored in the macOS Keychain, never in a file.')
        )
      );
    }
  }
  if (st?.state === 'error') card.append(h('div', { class: 'pcard-body note warn' }, h('span', { html: icon('alert') }), st.message));
  return card;
}

function modelsPage() {
  const page = h('div', { class: 'spage' });
  const rerender = () => {
    page.replaceChildren(...build());
  };
  const build = () => {
    const out = [h('p', { class: 'lead' }, 'Connect the models you use. Local servers are detected automatically; cloud providers need an API key.')];

    const scanBtn = h('button', { class: 'btn', onClick: async () => {
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning…';
      const found = await scanLocalServers();
      scanBtn.disabled = false;
      scanBtn.textContent = 'Scan for local servers';
      let added = 0;
      for (const f of found) {
        const exists = state.settings.providers.some((p) => p.baseUrl.replace(/\/+$/, '') === f.baseUrl);
        if (!exists) {
          state.settings.providers.push({ id: 'custom-' + uid().slice(0, 8), name: `${f.name} (:${f.port})`, kind: 'openai', baseUrl: f.baseUrl, local: true, custom: true });
          added++;
        }
      }
      saveSettings();
      if (!found.length) toast('No local servers answered. Start LM Studio or Ollama and try again.', { kind: 'info' });
      else toast(added ? `Found ${found.length}, added ${added} new` : `Found ${found.length}, all already listed`, { kind: 'success' });
      await Promise.all(state.settings.providers.filter((p) => p.local).map((p) => refreshModels(p)));
      updateModelButton();
      rerender();
    } }, 'Scan for local servers');
    const addBtn = h('button', { class: 'btn ghost', onClick: () => {
      state.settings.providers.push({ id: 'custom-' + uid().slice(0, 8), name: 'Custom server', kind: 'openai', baseUrl: 'http://localhost:8080/v1', local: true, custom: true });
      saveSettings();
      rerender();
    } }, 'Add custom server');
    out.push(h('div', { class: 'toolbar' }, scanBtn, addBtn));

    for (const p of state.settings.providers) {
      if (p.custom) {
        const name = h('input', { class: 'input name-input', value: p.name, 'aria-label': 'Server name' });
        name.addEventListener('change', () => {
          p.name = name.value.trim() || 'Custom server';
          saveSettings();
          updateModelButton();
        });
        const c = providerCard(p, rerender);
        c.querySelector('.pcard-name').replaceChildren(name);
        out.push(c);
      } else out.push(providerCard(p, rerender));
    }
    return out;
  };
  rerender();
  return page;
}

// ───────────── Autocomplete page ─────────────

function autocompletePage() {
  const ac = state.settings.autocomplete;
  const page = h('div', { class: 'spage' });
  const rerender = () => page.replaceChildren(...build());
  const build = () => {
    const providers = state.settings.providers.filter((p) => p.kind !== 'claude-cli');
    const models = state.models[ac.providerId] || [];
    return [
      h('p', { class: 'lead' }, 'Ghost-text suggestions as you type. Press Tab to accept. A small, fast local model works best; every pause sends your nearby code to the model you pick.'),
      row('Inline suggestions', 'Off by default.', toggle(ac.enabled, (v) => updateSetting('autocomplete.enabled', v), 'Inline suggestions')),
      row('Provider', null, select([['', 'Choose…'], ...providers.map((p) => [p.id, p.name])], ac.providerId || '', async (v) => {
        ac.providerId = v || null;
        ac.model = null;
        saveSettings();
        if (v && !state.models[v]?.length) await refreshModels(getProvider(v));
        rerender();
      }, 'Autocomplete provider')),
      row('Model', models.length ? null : 'Connect the provider in Models first.', select([['', 'Choose…'], ...models.map((m) => [m, m])], ac.model || '', (v) => updateSetting('autocomplete.model', v || null), 'Autocomplete model')),
      row('Method', 'Chat works with any model. Fill-in-the-middle is faster and better when the model supports it (for example Qwen Coder or DeepSeek Coder base models).', select([['chat', 'Chat prompt'], ['fim', 'Fill-in-the-middle']], ac.mode, (v) => updateSetting('autocomplete.mode', v), 'Method')),
      row('Delay', 'How long to pause typing before asking.', select([[200, '200 ms'], [350, '350 ms'], [600, '600 ms'], [1000, '1 second']].map(([v, t]) => [String(v), t]), String(ac.delayMs), (v) => updateSetting('autocomplete.delayMs', Number(v)), 'Delay')),
      row('Suggestion length', null, select([['48', 'Short'], ['96', 'Medium'], ['200', 'Long']], String(ac.maxTokens), (v) => updateSetting('autocomplete.maxTokens', Number(v)), 'Suggestion length')),
    ];
  };
  rerender();
  return page;
}

// ───────────── Editor and appearance ─────────────

function editorPage() {
  const e = state.settings.editor;
  const set = (k, v) => {
    e[k] = v;
    saveSettings();
    applyEditorSettings();
  };
  const accentRow = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Accent color' });
  const paintSwatches = () => {
    accentRow.replaceChildren(...ACCENTS.map((a) => h('button', {
      class: `swatch ${state.settings.appearance.accent === a.value ? 'on' : ''}`,
      style: { '--c': a.value },
      role: 'radio',
      'aria-checked': String(state.settings.appearance.accent === a.value),
      'aria-label': a.name,
      title: a.name,
      onClick: () => {
        state.settings.appearance.accent = a.value;
        saveSettings();
        document.documentElement.style.setProperty('--accent', a.value);
        applyTheme(a.value);
        paintSwatches();
      },
    })));
  };
  paintSwatches();
  return h('div', { class: 'spage' },
    row('Accent color', null, accentRow),
    row('Font', 'Google Sans Code ships with Pino. Others use what is installed on your Mac.', select(FONTS.map((f) => [f, f.replace(' Variable', '')]), e.fontFamily, (v) => set('fontFamily', v), 'Editor font')),
    row('Font size', null, select(['12', '13', '13.5', '14', '15', '16', '18'], String(e.fontSize), (v) => set('fontSize', Number(v)), 'Font size')),
    row('Line spacing', null, select([['1.4', 'Compact'], ['1.65', 'Comfortable'], ['1.9', 'Spacious']], String(e.lineHeight), (v) => set('lineHeight', Number(v)), 'Line spacing')),
    row('Font ligatures', null, toggle(e.ligatures, (v) => set('ligatures', v), 'Font ligatures')),
    row('Tab size', null, select(['2', '4', '8'], String(e.tabSize), (v) => set('tabSize', Number(v)), 'Tab size')),
    row('Word wrap', null, select([['off', 'Off'], ['on', 'On']], e.wordWrap, (v) => set('wordWrap', v), 'Word wrap')),
    row('Minimap', null, toggle(e.minimap, (v) => set('minimap', v), 'Minimap')),
    row('Sticky scroll', 'Keep the current function or class pinned at the top.', toggle(e.stickyScroll, (v) => set('stickyScroll', v), 'Sticky scroll')),
    row('Auto save', null, select([['off', 'Off'], ['afterDelay', 'After a pause']], e.autoSave, (v) => set('autoSave', v), 'Auto save'))
  );
}

function aiPage() {
  const ai = state.settings.ai;
  const ta = h('textarea', { class: 'input area', rows: '6', placeholder: 'Example: I write procedural PHP with prepared statements, escape all output, and use Bootstrap from a CDN.', 'aria-label': 'Instructions for the model' });
  ta.value = ai.extraInstructions;
  ta.addEventListener('change', () => updateSetting('ai.extraInstructions', ta.value));
  return h('div', { class: 'spage' },
    row('Share the open file automatically', 'Sent with each message so the model sees what you see.', toggle(ai.includeActiveFile, (v) => { updateSetting('ai.includeActiveFile', v); refreshChips(); }, 'Share the open file')),
    field('Standing instructions', ta, 'Added to every chat. Good for your coding style and preferred libraries.')
  );
}

const PAGES = [
  ['models', 'Models', 'cpu', modelsPage],
  ['autocomplete', 'Autocomplete', 'bolt', autocompletePage],
  ['editor', 'Editor', 'palette', editorPage],
  ['ai', 'Instructions', 'sparkle', aiPage],
];

let lastPage = 'models';

export function openSettings(page = lastPage) {
  const content = h('div', { class: 'spane' });
  const nav = h('nav', { class: 'snav', 'aria-label': 'Settings sections' });
  const paint = (id) => {
    lastPage = id;
    nav.replaceChildren(...PAGES.map(([pid, label, ic]) => h('button', { class: `snav-item ${pid === id ? 'on' : ''}`, onClick: () => paint(pid) }, h('span', { html: icon(ic) }), label)));
    const entry = PAGES.find((p) => p[0] === id);
    content.replaceChildren(h('h2', { class: 'spane-title' }, entry[1]), entry[3]());
  };
  const m = modal({ title: 'Settings', className: 'settings', width: 920, body: h('div', { class: 'settings-grid' }, nav, content) });
  paint(page);
  return m;
}

export { confirmDialog };
