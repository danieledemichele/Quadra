'use strict';
const crypto = require('node:crypto');

function abortError() {
  const e = new Error('Operazione annullata');
  e.name = 'AbortError';
  return e;
}

function isAbort(e) {
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Combina il segnale di annullamento dell'utente con un timeout di rete.
function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : signal;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const clone = (o) => JSON.parse(JSON.stringify(o));

function shorten(text, n = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// "1m59.34s" | "49.567s" | "120ms" | "7.66" (secondi) -> millisecondi
function parseDurationMs(str) {
  if (str == null) return null;
  const s = String(str).trim();
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let found = false;
  let m;
  while ((m = re.exec(s))) {
    found = true;
    const v = parseFloat(m[1]);
    total += m[2] === 'ms' ? v : m[2] === 's' ? v * 1000 : m[2] === 'm' ? v * 60000 : v * 3600000;
  }
  if (!found) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.ceil(n * 1000) : null;
  }
  return Math.ceil(total);
}

// "5,83" | "€ 5.83" | "1.234,56" | 5.83 -> number (NaN se impossibile)
function toNumberLoose(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  let s = v.replace(/[^\d,.\-]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

// "2026-10-30" | "30/10/2026" | "30-10-26" -> "2026-10-30" (null se non valida)
function toIsoDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let y, mo, d;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else {
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})/);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
    if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

module.exports = {
  abortError, isAbort, sleep, withTimeout, sha256, clone, shorten,
  parseDurationMs, toNumberLoose, toIsoDate,
};
