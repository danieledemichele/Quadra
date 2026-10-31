'use strict';
const { sleep, withTimeout, abortError, isAbort, parseDurationMs, toNumberLoose, toIsoDate, shorten } = require('./util');
const { isLocalUrl } = require('./config');

class ModelError extends Error {
  constructor(message, { status, kind, waitMs } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.kind = kind;
    this.waitMs = waitMs;
  }
}

// ---------- parsing della risposta ----------

function parseModelJson(text) {
  if (typeof text !== 'string') return null;
  let t = text;
  if (/<think>/i.test(t)) {
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    if (/<think>/i.test(t)) return null; // ragionamento troncato, nessuna risposta
  }
  t = t.replace(/```(?:json)?/gi, '').trim();
  try {
    const o = JSON.parse(t);
    if (o && typeof o === 'object') return o;
  } catch { /* prova il metodo tollerante */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(t.slice(a, b + 1));
      if (o && typeof o === 'object') return o;
    } catch { /* ultimo tentativo */ }
  }
  const pick = (re) => (t.match(re) || [])[1];
  const store = pick(/"store"\s*:\s*"([^"]*)"/i);
  const date = pick(/"date"\s*:\s*"([^"]*)"/i);
  const total = pick(/"(?:total|amount|importo)"\s*:\s*"?([\d.,]+)"?/i);
  if (store || date || total) return { store, date, total };
  return null;
}

function normalizeResult(o) {
  const store = typeof o.store === 'string' ? o.store.replace(/\s+/g, ' ').trim() : '';
  const date = toIsoDate(typeof o.date === 'string' ? o.date : '');
  const n = toNumberLoose(o.total ?? o.amount ?? o.importo);
  const amount = Number.isFinite(n) && n !== 0 ? Math.round(Math.abs(n) * 100) / 100 : null;
  return { store, date, amount };
}

// ---------- estrattore ----------

class Extractor {
  constructor({ config, fetch = globalThis.fetch }) {
    this.config = config;
    this.fetch = fetch;
    this.pstate = new Map(); // providerId -> { nextAt }
    this.cooldown = new Map(); // modelId -> timestamp fino a cui è esaurito
  }

  resetCooldowns() { this.cooldown.clear(); }

  _spacing(provider) {
    return /groq\.com/i.test(provider.baseUrl) ? 2100 : 0; // free tier Groq: 30 richieste/minuto
  }

  async _gate(provider, signal) {
    const st = this.pstate.get(provider.id) || { nextAt: 0 };
    this.pstate.set(provider.id, st);
    const start = Math.max(Date.now(), st.nextAt);
    st.nextAt = start + this._spacing(provider);
    const wait = start - Date.now();
    if (wait > 0) await sleep(wait, signal);
  }

  _prompt(knownStores) {
    const year = new Date().getFullYear();
    return [
      'Leggi questo scontrino italiano e rispondi SOLO con un oggetto JSON, senza altro testo:',
      '{"store": string, "date": "YYYY-MM-DD", "total": number}',
      '- store: nome commerciale dell\'insegna (es. "Eurospin", "Conad", "Lidl"), non la ragione sociale né l\'indirizzo.',
      knownStores?.length ? `  Se è una di queste, scrivila esattamente così: ${knownStores.join(', ')}.` : '',
      '- date: data di emissione dello scontrino. Formato italiano giorno/mese/anno. Se l\'anno ha due cifre è 20xx (siamo nel ' + year + ').',
      '- total: importo totale pagato (TOTALE COMPLESSIVO), con il punto come separatore decimale. Non il subtotale, non il contante, non il resto, non l\'IVA.',
      'Se un valore non è leggibile usa null.',
    ].filter(Boolean).join('\n');
  }

  _url(provider) {
    if (!provider.baseUrl) throw new ModelError(`Provider "${provider.label}" senza indirizzo.`, { kind: 'config' });
    if (!/^https:\/\//i.test(provider.baseUrl) && !isLocalUrl(provider.baseUrl)) {
      throw new ModelError(`Provider "${provider.label}": l'indirizzo deve iniziare con https:// (la chiave non viene inviata in chiaro).`, { kind: 'config' });
    }
    return provider.baseUrl;
  }

  _quota(res, provider, model) {
    const h = (k) => res.headers.get(k);
    const num = (k) => { const v = parseFloat(h(k)); return Number.isFinite(v) ? v : null; };
    const q = {
      provider: provider.label,
      model,
      limitRequests: num('x-ratelimit-limit-requests'),
      remainingRequests: num('x-ratelimit-remaining-requests'),
      limitTokens: num('x-ratelimit-limit-tokens'),
      remainingTokens: num('x-ratelimit-remaining-tokens'),
      resetRequestsMs: parseDurationMs(h('x-ratelimit-reset-requests')),
      resetTokensMs: parseDurationMs(h('x-ratelimit-reset-tokens')),
    };
    const any = q.limitRequests != null || q.remainingRequests != null || q.remainingTokens != null;
    return any ? q : null;
  }

  async _call(m, provider, messages, { jsonMode, maxTokens, signal, onQuota }) {
    const base = this._url(provider);
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const body = { model: m.model, messages, temperature: 0, max_tokens: maxTokens };
    if (jsonMode) body.response_format = { type: 'json_object' };

    let res;
    try {
      res = await this.fetch(`${base}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(signal, 90000),
      });
    } catch (e) {
      if (signal?.aborted) throw abortError();
      throw new ModelError(`${provider.label} non raggiungibile: ${e.message}`, { kind: 'network' });
    }

    const q = this._quota(res, provider, m.model);
    if (q) {
      onQuota?.(q);
      if (q.remainingRequests === 0 && q.resetRequestsMs) this.cooldown.set(m.id, Date.now() + q.resetRequestsMs);
      if (q.remainingTokens != null && q.remainingTokens < 2500 && q.resetTokensMs && q.resetTokensMs < 60000) {
        const st = this.pstate.get(provider.id);
        if (st) st.nextAt = Math.max(st.nextAt, Date.now() + q.resetTokensMs);
      }
    }

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignora */ }

    if (!res.ok) {
      const msg = json?.error?.message || shorten(text);
      const code = json?.error?.code || '';
      const label = `${provider.label} ${res.status}: ${msg}`;
      if (res.status === 429) {
        const ra = parseFloat(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) ? ra * 1000
          : Math.max(parseDurationMs(res.headers.get('x-ratelimit-reset-requests')) || 0, parseDurationMs(res.headers.get('x-ratelimit-reset-tokens')) || 0) || 20000;
        throw new ModelError(label, { status: 429, kind: 'rate', waitMs });
      }
      if (res.status === 401 || res.status === 403) throw new ModelError(`${label} (controlla la chiave API)`, { status: res.status, kind: 'auth' });
      if (res.status === 404 || /model_not_found|decommission|deprecat|does not exist|not supported/i.test(`${code} ${msg}`)) {
        throw new ModelError(`${label} (modello non disponibile)`, { status: res.status, kind: 'gone' });
      }
      if (res.status === 400 && /json/i.test(msg) && jsonMode) throw new ModelError(label, { status: 400, kind: 'json-validate' });
      if (res.status >= 500) throw new ModelError(label, { status: res.status, kind: 'server' });
      throw new ModelError(label, { status: res.status, kind: 'bad-request' });
    }
    const content = json?.choices?.[0]?.message?.content;
    return { content: typeof content === 'string' ? content : '' };
  }

  async _tryModel(m, provider, messages, opts) {
    const maxWaitMs = this.config.get().maxWaitSeconds * 1000;
    let jsonMode = m.jsonMode;
    let rateRetries = 0;
    let serverRetries = 0;
    let formatRetried = false;
    for (;;) {
      await this._gate(provider, opts.signal);
      try {
        const { content } = await this._call(m, provider, messages, { jsonMode, maxTokens: 2048, signal: opts.signal, onQuota: opts.onQuota });
        const parsed = parseModelJson(content);
        if (!parsed) {
          if (!formatRetried) { formatRetried = true; jsonMode = !jsonMode; continue; }
          throw new ModelError(`${m.model}: risposta non interpretabile`, { kind: 'bad-output' });
        }
        return { ...normalizeResult(parsed), model: m.model, provider: provider.label, raw: parsed };
      } catch (e) {
        if (isAbort(e)) throw e;
        if (e.kind === 'rate') {
          if (e.waitMs > maxWaitMs || rateRetries >= 3) {
            this.cooldown.set(m.id, Date.now() + e.waitMs);
            throw e;
          }
          rateRetries++;
          opts.onStatus?.({ type: 'wait', ms: e.waitMs, model: m.model });
          await sleep(e.waitMs + 250, opts.signal);
          continue;
        }
        if (e.kind === 'json-validate' && jsonMode) { jsonMode = false; continue; }
        if ((e.kind === 'server' || e.kind === 'network') && serverRetries++ < 1) {
          await sleep(2000, opts.signal);
          continue;
        }
        if (e.kind === 'gone') this.cooldown.set(m.id, Date.now() + 6 * 3600 * 1000);
        throw e;
      }
    }
  }

  // jpeg: Buffer. Prova i modelli attivi nell'ordine impostato.
  async extract(jpeg, { signal, onQuota, onStatus } = {}) {
    const cfg = this.config.get();
    const candidates = cfg.models.filter((m) => m.enabled);
    if (!candidates.length) throw new Error('Nessun modello attivo: aggiungine uno in Impostazioni → Modelli.');
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: this._prompt(cfg.knownStores) },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
      ],
    }];
    const errors = [];
    for (const m of candidates) {
      const provider = cfg.providers.find((p) => p.id === m.providerId);
      if (!provider) continue;
      const until = this.cooldown.get(m.id);
      if (until && until > Date.now()) {
        errors.push(`${m.model}: limite raggiunto, riprova tra ${Math.ceil((until - Date.now()) / 60000)} min`);
        continue;
      }
      try {
        return await this._tryModel(m, provider, messages, { signal, onQuota, onStatus });
      } catch (e) {
        if (isAbort(e)) throw e;
        errors.push(e.message);
        onStatus?.({ type: 'fallback', model: m.model, reason: e.message });
      }
    }
    const err = new Error(errors.join(' · ') || 'Nessun modello utilizzabile.');
    err.kind = 'all-failed';
    throw err;
  }

  async testModel({ providerId, model }, signal) {
    const cfg = this.config.get();
    const provider = cfg.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error('Provider non trovato.');
    const t0 = Date.now();
    const { content } = await this._call(
      { id: 'test', model },
      provider,
      [{ role: 'user', content: 'Rispondi solo con la parola: ok' }],
      { jsonMode: false, maxTokens: 64, signal },
    );
    return { ms: Date.now() - t0, reply: shorten(content.replace(/<think>[\s\S]*?<\/think>/gi, ''), 60) };
  }

  async listModels(providerId, signal) {
    const provider = this.config.get().providers.find((p) => p.id === providerId);
    if (!provider) throw new Error('Provider non trovato.');
    const base = this._url(provider);
    const headers = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
    let res;
    try {
      res = await this.fetch(`${base}/models`, { headers, signal: withTimeout(signal, 20000) });
    } catch (e) {
      if (signal?.aborted) throw abortError();
      throw new Error(`${provider.label} non raggiungibile: ${e.message}`);
    }
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${provider.label} ${res.status}: ${j?.error?.message || 'elenco modelli non disponibile'}`);
    return (j?.data || []).map((x) => x.id).filter(Boolean).sort();
  }
}

module.exports = { Extractor, ModelError, parseModelJson, normalizeResult };
