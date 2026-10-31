'use strict';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Suffissi societari solo in coda: "Eurospin Italia S.p.A." -> "Eurospin Italia"
const LEGAL_TAIL = /(?:[\s,]+(?:s\.\s?p\.\s?a\.?|s\.\s?r\.\s?l\.?|s\.\s?n\.\s?c\.?|s\.\s?a\.\s?s\.?|spa|srl|snc|sas))+\s*$/i;

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s'’\-\/])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
}

function knownRegex(store) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(store.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u');
}

// Il nome compare come parola intera (così "MD" non scatta dentro "Medical").
function matchKnownStore(name, knownStores = []) {
  const key = String(name || '').toLowerCase();
  if (!key) return null;
  const sorted = [...knownStores].sort((a, b) => b.length - a.length);
  for (const k of sorted) {
    if (k && knownRegex(k).test(key)) return k;
  }
  return null;
}

// Porta il nome letto dallo scontrino a quello che la formula Categoria di Notion riconosce.
function normalizeStoreName(raw, { knownStores = [], aliases = {} } = {}) {
  let name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!name) return '';
  const key = name.toLowerCase();
  if (aliases[key]) return aliases[key];
  const known = matchKnownStore(name, knownStores);
  if (known) return known;
  name = name.replace(LEGAL_TAIL, '').replace(/[\s,.\-]+$/, '').trim();
  if (name && name === name.toUpperCase() && /\p{L}/u.test(name)) name = titleCase(name);
  return name;
}

// Anteprima della Categoria (la formula vera sta in Notion; qui conosciamo solo i negozi alimentari).
function previewCategory(name, knownStores) {
  return matchKnownStore(name, knownStores) ? 'Spesa alimentare' : null;
}

module.exports = { normalizeStoreName, matchKnownStore, previewCategory, titleCase };
