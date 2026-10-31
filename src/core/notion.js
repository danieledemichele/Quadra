'use strict';
const { sleep, withTimeout, abortError, shorten } = require('./util');

const NOTION_VERSION = '2025-09-03';

const plain = (arr) => (Array.isArray(arr) ? arr.map((t) => t.plain_text || '').join('') : '');
const round2 = (n) => Math.round(n * 100) / 100;

function formulaText(p) {
  const f = p?.formula;
  if (!f) return null;
  const v = f.string ?? f.number ?? f.boolean ?? null;
  return v === null || v === '' ? null : String(v);
}

class Notion {
  constructor({ config, fetch = globalThis.fetch, baseUrl = 'https://api.notion.com' }) {
    this.config = config;
    this.fetch = fetch;
    this.baseUrl = baseUrl;
    this._schema = null;
    this._budget = new Map();
    config.onChange?.(() => { this._schema = null; this._budget.clear(); this._contiDs = null; });
  }

  async _req(method, path, body, signal) {
    const key = this.config.get().notion.apiKey;
    if (!key) throw new Error('Chiave Notion mancante: inseriscila in Impostazioni.');
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(this.baseUrl + path, {
          method,
          headers: { Authorization: `Bearer ${key}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: withTimeout(signal, 30000),
        });
      } catch (e) {
        if (signal?.aborted) throw abortError();
        throw new Error(`Notion non raggiungibile: ${e.message}`);
      }
      if (res.status === 429 && attempt < 3) {
        await sleep((parseFloat(res.headers.get('retry-after')) || 2) * 1000 + 200, signal);
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignora */ }
      if (!res.ok) throw new Error(`Notion ${res.status}: ${json?.message || shorten(text)}`);
      return json;
    }
  }

  async _firstDataSource(databaseId, signal) {
    const db = await this._req('GET', `/v1/databases/${databaseId}`, null, signal);
    const id = db.data_sources?.[0]?.id;
    if (!id) throw new Error('Questo database Notion non ha una data source accessibile (l\'integrazione è collegata alla pagina?).');
    return id;
  }

  async _relationDs(prop, signal) {
    const r = prop?.relation;
    if (!r) return null;
    if (r.data_source_id) return r.data_source_id;
    if (r.database_id) return this._firstDataSource(r.database_id, signal);
    return null;
  }

  async schema(signal) {
    if (this._schema) return this._schema;
    const dsId = await this._firstDataSource(this.config.get().notion.databaseId, signal);
    const ds = await this._req('GET', `/v1/data_sources/${dsId}`, null, signal);
    const props = ds.properties || {};
    const find = (names, types) => {
      for (const n of names) {
        const k = Object.keys(props).find((x) => x.toLowerCase() === n.toLowerCase() && (!types || types.includes(props[x].type)));
        if (k) return { name: k, ...props[k] };
      }
      return null;
    };
    const titleEntry = Object.entries(props).find(([, v]) => v.type === 'title');
    const s = {
      dataSourceId: dsId,
      title: titleEntry?.[0] || 'Descrizione',
      date: find(['Data'], ['date']),
      amount: find(['Importo'], ['number']),
      tags: find(['Tags', 'Tag'], ['multi_select', 'select']),
      conti: find(['Conti', 'Conto'], ['relation']),
      budget: find(['Budget Mensile'], ['relation']),
      categoria: find(['Categoria']),
      tipo: find(['Tipo']),
    };
    s.missing = [];
    if (!s.date) s.missing.push('Data');
    if (!s.amount) s.missing.push('Importo');
    if (!s.tags) s.missing.push('Tags');
    if (!s.conti) s.missing.push('Conti');
    if (!s.budget) s.missing.push('Budget Mensile');
    this._schema = s;
    return s;
  }

  async listConti(signal) {
    const s = await this.schema(signal);
    if (!s.conti) return [];
    const dsId = await this._relationDs(s.conti, signal);
    if (!dsId) return [];
    const out = [];
    let cursor;
    do {
      const j = await this._req('POST', `/v1/data_sources/${dsId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, signal);
      for (const p of j.results || []) {
        const t = Object.values(p.properties || {}).find((v) => v.type === 'title');
        const name = plain(t?.title).trim();
        if (name) out.push({ id: p.id, name });
      }
      cursor = j.has_more ? j.next_cursor : null;
    } while (cursor);
    return out.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  }

  async findBudget(month, signal) {
    if (this._budget.has(month)) return this._budget.get(month);
    const s = await this.schema(signal);
    let dsId = s.budget ? await this._relationDs(s.budget, signal) : null;
    if (!dsId) dsId = await this._firstDataSource(this.config.get().notion.budgetDatabaseId, signal);
    const j = await this._req('POST', `/v1/data_sources/${dsId}/query`, {
      page_size: 1,
      filter: { property: 'Mese (testo)', rich_text: { equals: month } },
    }, signal);
    const id = j.results?.[0]?.id || null;
    if (id) this._budget.set(month, id);
    return id;
  }

  async createExpense({ store, date, amount, person, contoId }, signal) {
    const s = await this.schema(signal);
    const warnings = [];
    const props = {};
    props[s.title] = { title: [{ text: { content: store } }] };
    if (s.date) props[s.date.name] = { date: { start: date } };
    if (s.amount) props[s.amount.name] = { number: -Math.abs(round2(amount)) };
    if (s.tags && person) {
      props[s.tags.name] = s.tags.type === 'select'
        ? { select: { name: person } }
        : { multi_select: [{ name: person }] };
    }
    if (s.conti && contoId) props[s.conti.name] = { relation: [{ id: contoId }] };

    const budgetId = await this.findBudget(date.slice(0, 7), signal);
    if (budgetId && s.budget) props[s.budget.name] = { relation: [{ id: budgetId }] };
    else warnings.push(`Budget Mensile ${date.slice(0, 7)} non trovato: la voce potrebbe non comparire nelle viste filtrate.`);

    const page = await this._req('POST', '/v1/pages', {
      parent: { type: 'data_source_id', data_source_id: s.dataSourceId },
      properties: props,
    }, signal);

    let categoria = null;
    let tipo = null;
    try {
      const full = await this._req('GET', `/v1/pages/${page.id}`, null, signal);
      categoria = formulaText(full.properties?.[s.categoria?.name]);
      tipo = formulaText(full.properties?.[s.tipo?.name]);
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    return { pageId: page.id, url: page.url, categoria, tipo, budgetLinked: !!budgetId, warnings };
  }

  async test(signal) {
    const s = await this.schema(signal);
    const conti = await this.listConti(signal).catch(() => []);
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const budget = await this.findBudget(month, signal).catch(() => null);
    return { dataSourceId: s.dataSourceId, missing: s.missing, contiCount: conti.length, month, budgetFound: !!budget };
  }
}

module.exports = { Notion, NOTION_VERSION };
