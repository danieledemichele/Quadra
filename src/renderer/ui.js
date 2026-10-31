'use strict';
/* Strumenti comuni dell'interfaccia: stato, helper DOM, toast, finestre di dialogo. */

const api = window.quadra;
const KEEP = '__keep__';

const S = {
  tab: 'review',
  items: new Map(),
  selected: null,
  conti: [],
  contiError: null,
  settings: null,
  draft: null,
  secure: true,
  version: '',
  job: null, // { kind, startedAt }
  progress: null,
  statusMsg: '',
  quota: {},
  modelLists: {},
  hist: { q: '', status: 'done' },
  zoom: false,
};

const $ = (sel, root = document) => root.querySelector(sel);

const SVG_TAGS = new Set(['svg', 'circle', 'text', 'g', 'path', 'rect']);

function h(tag, props, ...kids) {
  const svg = SVG_TAGS.has(tag);
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (svg && !k.startsWith('on')) el.setAttribute(k, v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const fmtMoney = (n) => (typeof n === 'number' ? eur.format(n) : '—');
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const fmtAmountInput = (n) => (typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '');
const fmtNum = (n) => (n == null ? '—' : n >= 100000 ? `${Math.round(n / 1000)}K` : n.toLocaleString('it-IT'));
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function toast(msg, kind = 'ok') {
  const t = h('div', { class: `toast ${kind}`, role: 'status', text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4500);
}

const errMsg = (e) => (e && e.message ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

// Finestra di dialogo. actions: [{ label, value, kind }]. Restituisce il value scelto (null se annullata).
function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (v) => {
      document.removeEventListener('keydown', onKey, true);
      root.replaceChildren();
      if (prev && prev.focus) prev.focus();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    const btns = actions.map((a) => h('button', { class: `btn ${a.kind || ''}`, type: 'button', onclick: () => close(typeof a.value === 'function' ? a.value() : a.value) }, a.label));
    const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { text: title }), body, h('div', { class: 'modal-actions' }, btns));
    const root = $('#modal-root');
    root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => { if (e.target === e.currentTarget) close(null); } }, dlg));
    document.addEventListener('keydown', onKey, true);
    (dlg.querySelector('input,select,button.primary') || btns[btns.length - 1]).focus();
  });
}

async function confirmBox(title, text, okLabel = 'Conferma') {
  const v = await modal({ title, body: h('p', { text }), actions: [{ label: 'Annulla', value: false }, { label: okLabel, value: true, kind: 'primary' }] });
  return v === true;
}

async function askPerson() {
  const people = (S.settings?.people || []).map((p) => p.name);
  if (!people.length) { toast('Aggiungi almeno una persona nelle Impostazioni.', 'error'); return null; }
  if (people.length === 1) return people[0];
  return modal({
    title: 'Per chi sono questi scontrini?',
    body: h('p', { class: 'muted', text: 'Serve per il Tag in Notion.' }),
    actions: [{ label: 'Annulla', value: null }, ...people.map((n, i) => ({ label: n, value: n, kind: i === 0 ? 'primary' : '' }))],
  });
}

function badge(text, kind = '') { return h('span', { class: `badge ${kind}`, text }); }
