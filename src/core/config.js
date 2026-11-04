'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { clone } = require('./util');

const SECRET_KEEP = '__keep__';

const DEFAULT_STORES = [
  'Super Pan', 'Conad', 'Pane Kentos', 'Su Stampu', 'Mercato San Benedetto', 'Coop', 'MD',
  'Pizzette al Taglio', 'Despar', 'Gzedda', 'Maurys', 'Eurospin', 'Lidl', 'Acqua e Sapone', 'Bulk',
];

const PROVIDER_PRESETS = [
  { key: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { key: 'ollama', label: 'Ollama (sul PC)', baseUrl: 'http://localhost:11434/v1', needsKey: false },
  { key: 'custom', label: 'Personalizzato (compatibile OpenAI)', baseUrl: '', needsKey: true },
];

function defaults() {
  return {
    version: 1,
    people: [
      { name: 'Daniele', folder: '/Daniele' },
      { name: 'Ettore', folder: '/Ettore' },
    ],
    dropbox: { appKey: '', appSecret: '', refreshToken: '' },
    notion: {
      apiKey: '',
      databaseId: '2e02578e062981789226e195cf01af61', // Uscite
      budgetDatabaseId: '2e02578e0629814bb5c7fa8bfb7cdd39', // Budget Mensile
    },
    providers: [{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: '' }],
    models: [
      { id: 'm-qwen38', providerId: 'groq', model: 'qwen/qwen3.8-27b', enabled: true, jsonMode: true },
      { id: 'm-scout', providerId: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', enabled: true, jsonMode: true },
    ],
    knownStores: [...DEFAULT_STORES],
    aliases: {},
    attachPhotos: true,
    maxMegapixels: 2,
    maxWaitSeconds: 120,
  };
}

const str = (v, d = '') => (typeof v === 'string' ? v : d);
const num = (v, d, lo, hi) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

function fixFolder(f) {
  let s = str(f).trim().replace(/\\/g, '/');
  if (!s) return '';
  if (!s.startsWith('/')) s = '/' + s;
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

function isLocalUrl(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

function normalizeSettings(input) {
  const d = defaults();
  const s = input && typeof input === 'object' ? input : {};

  const people = Array.isArray(s.people)
    ? s.people.map((p) => ({ name: str(p?.name).trim(), folder: fixFolder(p?.folder) })).filter((p) => p.name && p.folder)
    : d.people;

  const seen = new Set();
  const providers = (Array.isArray(s.providers) ? s.providers : d.providers)
    .map((p, i) => ({
      id: str(p?.id) || `p-${i}`,
      label: str(p?.label).trim() || 'Provider',
      baseUrl: str(p?.baseUrl).trim().replace(/\/+$/, ''),
      apiKey: str(p?.apiKey),
    }))
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  const models = (Array.isArray(s.models) ? s.models : d.models)
    .map((m, i) => ({
      id: str(m?.id) || `m-${i}`,
      providerId: str(m?.providerId),
      model: str(m?.model).trim(),
      enabled: m?.enabled !== false,
      jsonMode: m?.jsonMode !== false,
    }))
    .filter((m) => m.model && providers.some((p) => p.id === m.providerId));

  const stores = Array.isArray(s.knownStores) ? s.knownStores : d.knownStores;
  const knownStores = [...new Set(stores.map((x) => str(x).trim()).filter(Boolean))];

  const aliases = {};
  if (s.aliases && typeof s.aliases === 'object') {
    for (const [k, v] of Object.entries(s.aliases)) if (str(k).trim() && str(v).trim()) aliases[k.toLowerCase().trim()] = v.trim();
  }

  return {
    version: 1,
    people,
    dropbox: {
      appKey: str(s.dropbox?.appKey).trim(),
      appSecret: str(s.dropbox?.appSecret),
      refreshToken: str(s.dropbox?.refreshToken),
    },
    notion: {
      apiKey: str(s.notion?.apiKey),
      databaseId: str(s.notion?.databaseId, d.notion.databaseId).trim().replace(/-/g, ''),
      budgetDatabaseId: str(s.notion?.budgetDatabaseId, d.notion.budgetDatabaseId).trim().replace(/-/g, ''),
    },
    providers,
    models,
    knownStores,
    aliases,
    attachPhotos: s.attachPhotos !== false,
    maxMegapixels: num(s.maxMegapixels, d.maxMegapixels, 0.5, 8),
    maxWaitSeconds: num(s.maxWaitSeconds, d.maxWaitSeconds, 10, 600),
  };
}

function eachSecret(settings, fn) {
  fn(settings.dropbox, 'appSecret');
  fn(settings.dropbox, 'refreshToken');
  fn(settings.notion, 'apiKey');
  for (const p of settings.providers) fn(p, 'apiKey');
}

const plainAdapter = {
  available: false,
  encrypt: (s) => 'plain:' + s,
  decrypt: (s) => (s.startsWith('plain:') ? s.slice(6) : s),
};

class ConfigStore {
  constructor(file, cryptoAdapter = plainAdapter) {
    this.file = file;
    this.crypto = cryptoAdapter;
    this.listeners = [];
    this.settings = this._load();
  }

  _load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignora */ }
      }
    }
    const s = normalizeSettings(raw);
    eachSecret(s, (o, k) => {
      if (o[k]) {
        try { o[k] = this.crypto.decrypt(o[k]); } catch { o[k] = ''; }
      }
    });
    return s;
  }

  _save() {
    const out = clone(this.settings);
    eachSecret(out, (o, k) => { if (o[k]) o[k] = this.crypto.encrypt(o[k]); });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    for (const cb of this.listeners) cb(this.settings);
  }

  onChange(cb) { this.listeners.push(cb); }

  get() { return this.settings; }

  // Versione per l'interfaccia: i segreti non escono mai dal processo principale.
  getPublic() {
    const out = clone(this.settings);
    eachSecret(out, (o, k) => { o[k] = o[k] ? SECRET_KEEP : ''; });
    return out;
  }

  applyPublic(patch) {
    const cur = this.settings;
    const next = clone(patch);
    next.dropbox = next.dropbox || {};
    next.notion = next.notion || {};
    for (const k of ['appSecret', 'refreshToken']) if (next.dropbox[k] === SECRET_KEEP) next.dropbox[k] = cur.dropbox[k];
    if (next.notion.apiKey === SECRET_KEEP) next.notion.apiKey = cur.notion.apiKey;
    for (const p of next.providers || []) {
      if (p.apiKey === SECRET_KEEP) p.apiKey = cur.providers.find((x) => x.id === p.id)?.apiKey || '';
    }
    // Gli alias imparati restano se l'interfaccia non li invia.
    if (next.aliases === undefined) next.aliases = cur.aliases;
    this.settings = normalizeSettings(next);
    this._save();
    return this.getPublic();
  }

  setDropboxRefreshToken(token) {
    this.settings.dropbox.refreshToken = token;
    this._save();
  }

  addAlias(raw, name) {
    const key = String(raw || '').toLowerCase().trim();
    if (!key || !name) return;
    this.settings.aliases[key] = name;
    this._save();
  }
}

module.exports = { ConfigStore, SECRET_KEEP, PROVIDER_PRESETS, DEFAULT_STORES, defaults, normalizeSettings, isLocalUrl };
