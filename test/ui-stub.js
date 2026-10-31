// Finta di window.api per provare l'interfaccia in un browser normale (nessun accesso a rete o file).
(() => {
  const handlers = {};
  const calls = [];
  window.__calls = calls;
  window.__emit = (ev, p) => (handlers[ev] || []).forEach((f) => f(p));
  const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const day = (d) => iso(d).slice(0, 10);
  const mk = (id, over) => ({ id, status: 'pending', person: 'Daniele', source: 'dropbox', fileName: `IMG_${id}.jpg`, hash: id, warnings: [], createdAt: iso(1) + id, updatedAt: iso(1),
    data: { store: 'Eurospin', date: day(1), amount: 23.47 }, extracted: { store: 'EUROSPIN ITALIA S.P.A.', model: 'qwen/qwen3.8-27b' }, autoStore: 'Eurospin', ...over });
  let items = [
    mk('a1', { warnings: [{ level: 'info', text: 'Negozio fuori lista: la Categoria in Notion potrebbe restare vuota' }], data: { store: 'Panificio Rossi', date: day(2), amount: 6.2 }, extracted: { store: 'PANIFICIO ROSSI SRL', model: 'qwen/qwen3.8-27b' } }),
    mk('a2'),
    mk('a3', { person: 'Ettore', data: { store: 'Lidl', date: day(300), amount: 612.9 }, warnings: [{ level: 'warn', text: 'Data di oltre 4 mesi fa: controlla l\'anno' }, { level: 'warn', text: 'Importo insolitamente alto' }] }),
    mk('a4', { status: 'processing', data: { store: '', date: null, amount: null } }),
    mk('a5', { status: 'error', error: 'Groq 429: limite giornaliero raggiunto', data: { store: '', date: null, amount: null }, extracted: null }),
    mk('d1', { status: 'done', confirmedAt: iso(3), data: { store: 'Conad', date: day(4), amount: 41.8 }, notion: { url: 'https://www.notion.so/x', categoria: 'Spesa alimentare' } }),
    mk('d2', { status: 'done', confirmedAt: iso(5), person: 'Ettore', data: { store: 'MD', date: day(6), amount: 12.35 }, notion: { url: 'https://www.notion.so/y', categoria: 'Spesa alimentare' } }),
    mk('d3', { status: 'discarded', data: { store: 'Sconosciuto', date: day(9), amount: 1 } }),
  ];
  const K = '__keep__';
  let settings = {
    people: [{ name: 'Daniele', folder: '/Daniele' }, { name: 'Ettore', folder: '/Ettore' }],
    dropbox: { appKey: 'abc123', appSecret: K, refreshToken: K },
    notion: { apiKey: K, databaseId: '2e02578e062981789226e195cf01af61', budgetDatabaseId: '2e02578e0629814bb5c7fa8bfb7cdd39' },
    providers: [{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: K }],
    models: [
      { id: 'm1', providerId: 'groq', model: 'qwen/qwen3.8-27b', enabled: true, jsonMode: true },
      { id: 'm2', providerId: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', enabled: true, jsonMode: true },
    ],
    knownStores: ['Conad', 'Eurospin', 'Lidl', 'MD'], aliases: { 'sup. tiziano': 'Conad' }, maxMegapixels: 2, maxWaitSeconds: 120,
  };
  const wait = (v, ms = 5) => new Promise((r) => setTimeout(() => r(structuredClone(v)), ms));
  const rec = (name, ...a) => calls.push([name, ...a]);
  const jpeg = (() => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 520;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 520);
    x.fillStyle = '#222'; x.font = 'bold 20px monospace'; x.fillText('EUROSPIN ITALIA', 40, 40);
    x.font = '14px monospace';
    for (let i = 0; i < 18; i++) x.fillText(`ARTICOLO ${i + 1}          ${(i * 1.37 + 0.5).toFixed(2)}`, 20, 80 + i * 22);
    x.font = 'bold 18px monospace'; x.fillText('TOTALE EURO        23,47', 20, 500);
    return c.toDataURL('image/jpeg', 0.8);
  })();
  window.quadra = {
    settings: {
      get: () => wait({ settings, secureStorage: false, version: '1.0.0' }),
      save: (s) => { rec('save', s); settings = structuredClone(s); return wait(settings); },
      presets: () => wait([{ key: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' }, { key: 'ollama', label: 'Ollama (sul PC)', baseUrl: 'http://localhost:11434/v1' }, { key: 'custom', label: 'Personalizzato (compatibile OpenAI)', baseUrl: '' }]),
      testNotion: () => wait({ contiCount: 3, month: '2026-10', budgetFound: true, missing: [] }),
      testDropbox: () => wait({ name: 'Daniele', email: 'd@x.it' }),
      testModel: (m) => { rec('testModel', m); return wait({ ms: 1300, reply: 'ok' }); },
      listModels: () => wait(['llama-3.3-70b-versatile', 'qwen/qwen3.8-27b']),
      dropboxAuthUrl: () => wait('https://www.dropbox.com/x'),
      dropboxExchange: (c) => { rec('exchange', c); return wait(true); },
    },
    scan: { start: () => wait({ added: 2, duplicates: 0, errors: 0, found: 2 }), cancel: () => wait(true) },
    pickFiles: () => wait([]),
    importPaths: (p, who) => { rec('import', p, who); return wait({ added: 1, duplicates: 0, errors: 0, found: 1 }); },
    pathForFile: () => '/tmp/x.jpg',
    items: {
      list: () => wait(items),
      update: (id, data, conto) => {
        rec('update', id, data, conto);
        const it = items.find((i) => i.id === id);
        if (data) it.data = { store: data.store, date: data.date || null, amount: parseFloat(String(data.amount).replace(',', '.')) || null };
        if (conto !== undefined) it.contoId = conto;
        setTimeout(() => window.__emit('evt:item', structuredClone(it)), 5);
        return wait(it);
      },
      confirm: (id, data, conto) => {
        rec('confirm', id, data, conto);
        const it = items.find((i) => i.id === id);
        Object.assign(it, { status: 'done', confirmedAt: new Date().toISOString(), notion: { url: 'https://www.notion.so/z', categoria: 'Spesa alimentare' } });
        if (data) it.data = { store: data.store, date: data.date, amount: parseFloat(String(data.amount).replace(',', '.')) };
        setTimeout(() => window.__emit('evt:item', structuredClone(it)), 5);
        return wait(it);
      },
      confirmMany: (ids) => { rec('confirmMany', ids); return wait(ids.map((id) => ({ id, ok: true }))); },
      discard: (id) => { rec('discard', id); const it = items.find((i) => i.id === id); it.status = 'discarded'; return wait(it); },
      reextract: (id) => { rec('reextract', id); return wait(items.find((i) => i.id === id)); },
      image: () => wait(jpeg),
      openNotion: (id) => { rec('openNotion', id); return wait(true); },
    },
    conti: { list: () => wait([{ id: 'c1', name: 'Postepay' }, { id: 'c2', name: 'Conto Intesa' }, { id: 'c3', name: 'Contanti' }]) },
    on: (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); return () => {}; },
  };
})();
