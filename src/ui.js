import { h, $ } from './util.js';
import { icon } from './icons.js';

const root = () => document.getElementById('overlay-root');

export function toast(message, { kind = 'info', ms = 3600 } = {}) {
  let host = $('#toasts');
  if (!host) {
    host = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
    root().append(host);
  }
  const el = h('div', { class: `toast ${kind}` }, h('span', { class: 'toast-icon', html: icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info') }), h('span', {}, message));
  host.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

/** Generic modal. Returns { el, body, close }. */
export function modal({ title, body, actions = [], width = 520, className = '', onClose, dismissable = true }) {
  const scrim = h('div', { class: 'scrim' });
  const closeFn = () => {
    document.removeEventListener('keydown', onKey, true);
    scrim.classList.remove('in');
    setTimeout(() => scrim.remove(), 160);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) {
      e.stopPropagation();
      closeFn();
    }
  };
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const footer = actions.length
    ? h(
        'div',
        { class: 'modal-actions' },
        actions.map((a) =>
          h('button', { class: `btn ${a.primary ? 'primary' : a.danger ? 'danger' : 'ghost'}`, onClick: () => a.onClick?.(closeFn) }, a.label)
        )
      )
    : null;
  const card = h(
    'div',
    { class: `modal ${className}`, style: { width: `min(${width}px, calc(100vw - 48px))` }, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title ? h('div', { class: 'modal-title' }, h('span', {}, title), dismissable ? h('button', { class: 'icon-btn sm', title: 'Close', onClick: closeFn, html: icon('close') }) : null) : null,
    bodyEl,
    footer
  );
  scrim.append(card);
  if (dismissable) scrim.addEventListener('pointerdown', (e) => e.target === scrim && closeFn());
  document.addEventListener('keydown', onKey, true);
  root().append(scrim);
  requestAnimationFrame(() => scrim.classList.add('in'));
  return { el: card, body: bodyEl, close: closeFn };
}

/** Resolves to the id of the clicked button, or null when dismissed. */
export function confirmDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v, close) => {
      settled = true;
      resolve(v);
      close?.();
    };
    modal({
      title,
      body: h('p', { class: 'modal-text' }, message),
      width: 440,
      actions: buttons.map((b) => ({ label: b.label, primary: b.primary, danger: b.danger, onClick: (close) => done(b.id, close) })),
      onClose: () => !settled && resolve(null),
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmText = 'Save' }) {
  return new Promise((resolve) => {
    let settled = false;
    const input = h('input', { class: 'input', type: 'text', value, placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': label || title });
    const m = modal({
      title,
      body: h('label', { class: 'field' }, label ? h('span', { class: 'field-label' }, label) : null, input),
      width: 460,
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        {
          label: confirmText,
          primary: true,
          onClick: (close) => {
            const v = input.value.trim();
            if (!v) return input.focus();
            settled = true;
            resolve(v);
            close();
          },
        },
      ],
      onClose: () => !settled && resolve(null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') m.el.querySelector('.btn.primary').click();
    });
    setTimeout(() => {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }, 30);
  });
}

function floating(el, x, y) {
  root().append(el);
  const r = el.getBoundingClientRect();
  const nx = Math.min(x, window.innerWidth - r.width - 8);
  const ny = Math.min(y, window.innerHeight - r.height - 8);
  el.style.left = `${Math.max(8, nx)}px`;
  el.style.top = `${Math.max(8, ny)}px`;
}

function dismissOnOutside(el, close) {
  const onDown = (e) => !el.contains(e.target) && close();
  const onKey = (e) => e.key === 'Escape' && close();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
  }, 0);
  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
  };
}

export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx').forEach((n) => n.remove());
  const el = h('div', { class: 'ctx', role: 'menu' });
  let off = () => {};
  const close = () => {
    off();
    el.remove();
  };
  for (const it of items) {
    if (it.separator) {
      el.append(h('div', { class: 'ctx-sep' }));
      continue;
    }
    el.append(
      h(
        'button',
        {
          class: `ctx-item ${it.danger ? 'danger' : ''}`,
          role: 'menuitem',
          onClick: () => {
            close();
            it.onClick?.();
          },
        },
        h('span', { class: 'ctx-icon', html: it.icon ? icon(it.icon) : '' }),
        h('span', {}, it.label)
      )
    );
  }
  floating(el, x, y);
  off = dismissOnOutside(el, close);
  return { close };
}

/** Anchored popover below `anchor`. */
export function popover(anchor, content, { align = 'left', minWidth = 0 } = {}) {
  document.querySelectorAll('.pop').forEach((n) => n.remove());
  const el = h('div', { class: 'pop' }, content);
  const a = anchor.getBoundingClientRect();
  if (minWidth) el.style.minWidth = `${Math.max(minWidth, a.width)}px`;
  let off = () => {};
  const close = () => {
    off();
    el.remove();
  };
  root().append(el);
  const r = el.getBoundingClientRect();
  let x = align === 'right' ? a.right - r.width : a.left;
  x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  let y = a.bottom + 6;
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, a.top - r.height - 6);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  off = dismissOnOutside(el, close);
  return { el, close };
}
