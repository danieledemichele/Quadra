'use strict';
/* Personalizzazione dell'aspetto: salvata in locale (localStorage) e applicata subito, senza passare dal pulsante Salva. */

const PREFS_KEY = 'quadra.prefs.v1';

// Colori [chiaro, scuro]
const PALETTE = {
  blue: { label: 'Blu', c: ['#007aff', '#0a84ff'] },
  indigo: { label: 'Indaco', c: ['#5856d6', '#7d7aff'] },
  teal: { label: 'Turchese', c: ['#00a0a8', '#40c8e0'] },
  green: { label: 'Verde', c: ['#248a3d', '#30d158'] },
  orange: { label: 'Arancio', c: ['#e07000', '#ff9f0a'] },
  pink: { label: 'Rosa', c: ['#d6336c', '#ff6482'] },
};
const PERSON_DEFAULTS = ['blue', 'orange', 'teal', 'pink'];

const SECTIONS = [
  ['people', 'Spesa per persona'],
  ['daily', 'Spesa giornaliera'],
  ['pace', 'Ritmo del mese'],
  ['category', 'Per categoria'],
  ['stores', 'Dove hai speso di più'],
  ['trend', 'Andamento (8 settimane / 12 mesi)'],
  ['moves', 'Elenco movimenti'],
];

const PREF_DEFAULTS = {
  theme: 'auto', // auto | light | dark
  accent: 'blue',
  textSize: 'm', // s | m | l | xl
  density: 'normal', // normal | compact
  width: 'full', // standard | wide | full
  startPeriod: 'week',
  splitChart: true,
  sections: { people: true, daily: true, pace: true, category: true, stores: true, trend: true, moves: true },
  colors: {},
};

const TEXT_ZOOM = { s: 0.93, m: 1, l: 1.1, xl: 1.2 };
const WIDTH_PX = { standard: '1120px', wide: '1560px', full: '100%' };
const pick = (v, ok, d) => (ok.includes(v) ? v : d);

function sanitizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = PREF_DEFAULTS;
  const sections = {};
  for (const [k] of SECTIONS) sections[k] = r.sections?.[k] !== false;
  const colors = {};
  for (const [name, c] of Object.entries(r.colors && typeof r.colors === 'object' ? r.colors : {})) if (PALETTE[c]) colors[name] = c;
  return {
    theme: pick(r.theme, ['auto', 'light', 'dark'], d.theme),
    accent: pick(r.accent, Object.keys(PALETTE), d.accent),
    textSize: pick(r.textSize, Object.keys(TEXT_ZOOM), d.textSize),
    density: pick(r.density, ['normal', 'compact'], d.density),
    width: pick(r.width, Object.keys(WIDTH_PX), d.width),
    startPeriod: pick(r.startPeriod, ['week', 'month'], d.startPeriod),
    splitChart: r.splitChart !== false,
    sections,
    colors,
  };
}

function loadPrefs() {
  try { return sanitizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY))); } catch { return sanitizePrefs(null); }
}

const P = loadPrefs();

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(P)); } catch { /* senza archivio locale le scelte valgono solo per questa sessione */ }
}

function isDarkNow() {
  return P.theme === 'dark' || (P.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

const colorHex = (key) => (PALETTE[key] || PALETTE.blue).c[isDarkNow() ? 1 : 0];

// Colore di una persona: scelto nelle impostazioni, altrimenti uno di default in base all'ordine.
function personColor(name, people = []) {
  if (name === 'Non assegnato') return isDarkNow() ? '#8e8e93' : '#a1a1a6';
  const i = Math.max(0, people.indexOf(name));
  return colorHex(P.colors[name] || PERSON_DEFAULTS[i % PERSON_DEFAULTS.length]);
}

function applyPrefs() {
  const el = document.documentElement;
  if (P.theme === 'auto') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', P.theme);
  el.dataset.density = P.density;
  el.style.zoom = String(TEXT_ZOOM[P.textSize]);
  el.style.setProperty('--maxw', WIDTH_PX[P.width]);
  const hex = colorHex(P.accent);
  el.style.setProperty('--accent', hex);
  el.style.setProperty('--accent-soft', `color-mix(in srgb, ${hex} 16%, transparent)`);
}

function setPref(key, value) {
  P[key] = value;
  savePrefs();
  applyPrefs();
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyPrefs(); if (typeof S !== 'undefined' && S.tab === 'dash' && typeof paintDash === 'function') paintDash(); });
applyPrefs();
