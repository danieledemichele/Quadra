'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/core/config');
const { Store } = require('../src/core/store');
const { Dropbox } = require('../src/core/dropbox');
const { Notion } = require('../src/core/notion');
const { Extractor } = require('../src/core/extractor');
const { Pipeline } = require('../src/core/pipeline');

// Server finto che imita Dropbox, Notion e un provider compatibile OpenAI.
async function startMock(state) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const url = req.url;
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    state.log.push(`${req.method} ${url}`);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* form o binario */ }

    // --- Dropbox ---
    if (url === '/oauth2/token') return send(200, { access_token: 'AT', expires_in: 14400, refresh_token: 'RT-NEW' });
    if (url === '/2/files/list_folder') {
      const entries = state.files.filter((f) => f.path.startsWith(body.path + '/') && !state.moved.has(f.id))
        .map((f) => ({ '.tag': 'file', id: f.id, name: f.name, path_display: f.path, path_lower: f.path.toLowerCase(), size: f.data.length }));
      if (!entries.length && !state.files.some((f) => f.path.startsWith(body.path))) {
        return send(409, { error_summary: 'path/not_found/..' });
      }
      return send(200, { entries, has_more: false, cursor: 'c' });
    }
    if (url === '/2/files/download') return (res.writeHead(200), res.end(state.files.find((f) => f.id === JSON.parse(req.headers['dropbox-api-arg']).path).data));
    if (url === '/2/files/move_v2') { state.moved.set(body.from_path, body.to_path); return send(200, { metadata: { path_display: body.to_path } }); }
    if (url === '/2/users/get_current_account') return send(200, { name: { display_name: 'Test' }, email: 'a@b.c' });

    // --- Notion ---
    if (url.startsWith('/v1/databases/')) return send(200, { data_sources: [{ id: url.includes('budgetdb') ? 'ds-budget' : 'ds-uscite' }] });
    if (url === '/v1/data_sources/ds-uscite') {
      return send(200, { properties: {
        Descrizione: { type: 'title' }, Data: { type: 'date' }, Importo: { type: 'number' },
        Tags: { type: 'multi_select' }, Conti: { type: 'relation', relation: { data_source_id: 'ds-conti' } },
        'Budget Mensile': { type: 'relation', relation: { data_source_id: 'ds-budget' } },
        Categoria: { type: 'formula' }, Tipo: { type: 'formula' },
      } });
    }
    if (url === '/v1/data_sources/ds-conti/query') return send(200, { results: [{ id: 'conto-1', properties: { Nome: { type: 'title', title: [{ plain_text: 'Postepay' }] } } }], has_more: false });
    if (url === '/v1/data_sources/ds-budget/query') {
      const m = body.filter.rich_text.equals;
      return send(200, { results: m === '2026-10' ? [{ id: 'budget-oct' }] : [] });
    }
    if (url === '/v1/pages' && req.method === 'POST') { state.pages.push(body); return send(200, { id: 'page-' + state.pages.length, url: 'https://notion.so/p' }); }
    if (url.startsWith('/v1/pages/')) return send(200, { properties: { Categoria: { formula: { string: 'Spesa alimentare' } }, Tipo: { formula: { string: 'Necessità' } } } });

    // --- Provider LLM ---
    if (url === '/llm/models') return send(200, { data: [{ id: 'b-model' }, { id: 'a-model' }] });
    if (url === '/llm/chat/completions') {
      state.llmCalls.push(body);
      const step = state.llm.shift();
      if (!step) return send(500, { error: { message: 'script finito' } });
      return send(step.status || 200, step.body, step.headers || {});
    }
    send(404, { error: 'unknown ' + url });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const ok = (obj) => ({ body: { choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] } });

async function setup(overrides = {}) {
  const state = { files: [], moved: new Map(), pages: [], log: [], llm: [], llmCalls: [] };
  const mock = await startMock(state);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scontrini-'));
  const config = new ConfigStore(path.join(dir, 'settings.json'));
  config.applyPublic({
    ...config.getPublic(),
    dropbox: { appKey: 'k', appSecret: 's', refreshToken: 'rt' },
    notion: { apiKey: 'nk', databaseId: 'uscitedb', budgetDatabaseId: 'budgetdb' },
    providers: [{ id: 'groq', label: 'Groq', baseUrl: mock.base + '/llm', apiKey: 'gk' }],
    models: [
      { id: 'm1', providerId: 'groq', model: 'primary', enabled: true, jsonMode: true },
      { id: 'm2', providerId: 'groq', model: 'reserve', enabled: true, jsonMode: true },
    ],
    maxWaitSeconds: 10,
    ...overrides,
  });
  const store = new Store(path.join(dir, 'items.json'));
  const dropbox = new Dropbox({ config, endpoints: { api: mock.base, content: mock.base } });
  const notion = new Notion({ config, baseUrl: mock.base });
  const extractor = new Extractor({ config });
  extractor._spacing = () => 0; // niente attese nei test
  const pipeline = new Pipeline({ config, store, dropbox, notion, extractor, prepareImage: async (b) => b, cacheDir: path.join(dir, 'cache') });
  return { state, mock, dir, config, store, dropbox, notion, extractor, pipeline };
}

module.exports = { setup, ok };
