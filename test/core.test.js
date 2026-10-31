'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup, ok } = require('./helpers');
const { normalizeStoreName } = require('../src/core/normalize');
const { parseDurationMs, toNumberLoose, toIsoDate } = require('../src/core/util');
const { parseModelJson } = require('../src/core/extractor');
const { SECRET_KEEP } = require('../src/core/config');

const today = new Date().toISOString().slice(0, 10);
const octDate = '2026-10-29';

test('util: durate, numeri, date', () => {
  assert.equal(parseDurationMs('1m59.34s'), 119340);
  assert.equal(parseDurationMs('250ms'), 250);
  assert.equal(parseDurationMs('49.567s'), 49567);
  assert.equal(toNumberLoose('€ 1.234,56'), 1234.56);
  assert.equal(toNumberLoose('5,83'), 5.83);
  assert.equal(toIsoDate('30/10/26'), '2026-10-30');
  assert.equal(toIsoDate('31/02/2026'), null);
});

test('normalize: negozi noti, alias, suffissi, maiuscolo', () => {
  const o = { knownStores: ['Eurospin', 'MD', 'Acqua e Sapone'], aliases: { 'sup. tiziano': 'Conad' } };
  assert.equal(normalizeStoreName('EUROSPIN ITALIA S.P.A.', o), 'Eurospin');
  assert.equal(normalizeStoreName('Medical Center', o), 'Medical Center'); // "MD" non scatta dentro altre parole
  assert.equal(normalizeStoreName('MD SPA', o), 'MD');
  assert.equal(normalizeStoreName('Sup. Tiziano', o), 'Conad');
  assert.equal(normalizeStoreName('PANIFICIO ROSSI SRL', o), 'Panificio Rossi');
});

test('extractor: parsing tollerante', () => {
  assert.deepEqual(parseModelJson('<think>x</think>```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseModelJson('<think>mai chiuso'), null);
  assert.equal(parseModelJson('Ecco: {"store":"Lidl","date":"01/02/2026","total":"3,50"} fine').store, 'Lidl');
  assert.equal(parseModelJson('{"store": "Lidl", "total": 3.5, rotto').store, 'Lidl');
  assert.equal(parseModelJson('niente'), null);
});

test('config: segreti cifrati/mascherati e conservati', () => {
  const dir = fs.mkdtempSync(require('node:os').tmpdir() + '/cfg-');
  const { ConfigStore } = require('../src/core/config');
  const enc = { encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };
  const c = new ConfigStore(dir + '/s.json', enc);
  const pub = c.getPublic();
  pub.notion.apiKey = 'secret-notion';
  pub.providers[0].apiKey = 'gsk_abc';
  c.applyPublic(pub);
  const onDisk = fs.readFileSync(dir + '/s.json', 'utf8');
  assert.ok(!onDisk.includes('secret-notion') && !onDisk.includes('gsk_abc'));
  const again = c.getPublic();
  assert.equal(again.notion.apiKey, SECRET_KEEP);
  c.applyPublic(again); // rinvio mascherato: i valori restano
  assert.equal(c.get().notion.apiKey, 'secret-notion');
  assert.equal(new ConfigStore(dir + '/s.json', enc).get().providers[0].apiKey, 'gsk_abc');
});

test('flusso completo: scan → revisione → conferma su Notion → file in Elaborati', async () => {
  const t = await setup();
  try {
    t.state.files.push({ id: 'id:1', name: 'sc1.jpg', path: '/Daniele/2026-10/sc1.jpg', data: Buffer.from('foto-uno') });
    t.state.files.push({ id: 'id:2', name: 'vecchio.jpg', path: '/Daniele/Elaborati/vecchio.jpg', data: Buffer.from('x') });
    t.state.files.push({ id: 'id:3', name: 'e.jpg', path: '/Ettore/e.jpg', data: Buffer.from('foto-due') });
    t.state.llm.push(ok({ store: 'EUROSPIN ITALIA S.P.A.', date: '29/10/2026', total: '5,83' }));
    t.state.llm.push(ok({ store: 'Panificio Mario', date: octDate, total: 2 }));

    const events = [];
    t.pipeline.on('item', (i) => events.push(i.status));
    const sum = await t.pipeline.scanDropbox();
    assert.equal(sum.added, 2);
    assert.equal(sum.found, 2, 'Elaborati escluso');
    const items = t.pipeline.list();
    const a = items.find((i) => i.fileName === 'sc1.jpg');
    assert.equal(a.status, 'pending');
    assert.deepEqual(a.data, { store: 'Eurospin', date: octDate, amount: 5.83 });
    assert.ok(a.warnings.every((w) => w.level === 'info' || w.text), 'warnings ben formati');
    assert.ok(fs.existsSync(t.dir + '/cache/' + a.hash + '.jpg'));

    const conti = await t.pipeline.listConti();
    assert.deepEqual(conti, [{ id: 'conto-1', name: 'Postepay' }]);

    // il revisore corregge l'importo e sceglie il conto
    const done = await t.pipeline.confirm(a.id, { data: { store: 'Eurospin', date: octDate, amount: '5,90' }, contoId: 'conto-1' });
    assert.equal(done.status, 'done');
    assert.equal(done.notion.categoria, 'Spesa alimentare');
    const page = t.state.pages[0];
    assert.equal(page.parent.type, 'data_source_id');
    assert.equal(page.parent.data_source_id, 'ds-uscite');
    assert.equal(page.properties.Importo.number, -5.9);
    assert.deepEqual(page.properties.Tags, { multi_select: [{ name: 'Daniele' }] });
    assert.deepEqual(page.properties['Budget Mensile'], { relation: [{ id: 'budget-oct' }] });
    assert.deepEqual(page.properties.Conti, { relation: [{ id: 'conto-1' }] });
    assert.equal(page.properties.Descrizione.title[0].text.content, 'Eurospin');
    assert.equal(t.state.moved.get('id:1'), '/Daniele/Elaborati/sc1.jpg');

    // doppia conferma rifiutata
    await assert.rejects(() => t.pipeline.confirm(a.id), /già stato elaborato/);

    // nuova scansione: niente di nuovo
    const again = await t.pipeline.scanDropbox();
    assert.equal(again.added, 0);

    // l'altro scontrino è di Ettore e fuori lista -> alias appreso alla correzione
    const b = items.find((i) => i.fileName === 'e.jpg');
    assert.equal(b.person, 'Ettore');
    await t.pipeline.confirm(b.id, { data: { store: 'Conad', date: octDate, amount: 2 } });
    assert.equal(t.config.get().aliases['panificio mario'], 'Conad');
    assert.deepEqual(t.state.pages[1].properties.Tags, { multi_select: [{ name: 'Ettore' }] });
  } finally { await t.mock.close(); }
});

test('rate limit lungo: passa al modello di riserva; JSON non valido: ritenta senza json_mode', async () => {
  const t = await setup();
  try {
    t.state.files.push({ id: 'id:1', name: 'a.jpg', path: '/Daniele/a.jpg', data: Buffer.from('aaa') });
    t.state.llm.push({ status: 429, headers: { 'retry-after': '3600' }, body: { error: { message: 'limit per day' } } });
    t.state.llm.push({ status: 400, body: { error: { message: 'Failed to validate JSON' } } });
    t.state.llm.push(ok('{"store":"Lidl","date":"2026-10-28","total":9.99}'));
    const sum = await t.pipeline.scanDropbox();
    assert.equal(sum.added, 1);
    const it = t.pipeline.list()[0];
    assert.equal(it.extracted.model, 'reserve');
    assert.equal(t.state.llmCalls[1].response_format.type, 'json_object');
    assert.equal(t.state.llmCalls[2].response_format, undefined);
    // il primo modello resta in pausa nelle chiamate successive
    t.state.files.push({ id: 'id:2', name: 'b.jpg', path: '/Daniele/b.jpg', data: Buffer.from('bbb') });
    t.state.llm.push(ok({ store: 'Lidl', date: '2026-10-28', total: 1 }));
    await t.pipeline.scanDropbox();
    assert.equal(t.state.llmCalls.at(-1).model, 'reserve');
  } finally { await t.mock.close(); }
});

test('duplicati: stessa foto scartata e spostata; errori non bloccano gli altri', async () => {
  const t = await setup();
  try {
    t.state.files.push({ id: 'id:1', name: 'a.jpg', path: '/Daniele/a.jpg', data: Buffer.from('stessa') });
    t.state.files.push({ id: 'id:2', name: 'copia.jpg', path: '/Daniele/copia.jpg', data: Buffer.from('stessa') });
    t.state.llm.push(ok({ store: 'Lidl', date: '2026-10-28', total: 3 }));
    const sum = await t.pipeline.scanDropbox();
    assert.equal(sum.added, 1);
    assert.equal(sum.duplicates, 1);
    assert.equal(t.state.moved.get('id:2'), '/Daniele/Scartati/copia.jpg');

    // importo/negozio uguale in un'altra foto -> avviso "già presente"
    t.state.files.push({ id: 'id:3', name: 'c.jpg', path: '/Daniele/c.jpg', data: Buffer.from('diversa') });
    t.state.llm.push(ok({ store: 'LIDL', date: '28/10/2026', total: '3,00' }));
    await t.pipeline.scanDropbox();
    const c = t.pipeline.list().find((i) => i.fileName === 'c.jpg');
    assert.ok(c.warnings.some((w) => w.level === 'warn' && /già presente/.test(w.text)));
  } finally { await t.mock.close(); }
});

test('modelli inutilizzabili: la scansione si ferma dopo due falliti e riprende dopo', async () => {
  const t = await setup();
  try {
    for (let i = 1; i <= 4; i++) t.state.files.push({ id: 'id:' + i, name: `f${i}.jpg`, path: `/Daniele/f${i}.jpg`, data: Buffer.from('x' + i) });
    for (let i = 0; i < 8; i++) t.state.llm.push({ status: 500, body: { error: { message: 'giù' } } });
    const sum = await t.pipeline.scanDropbox();
    assert.equal(sum.stopped, 'models');
    assert.equal(sum.errors, 2);
    assert.equal(sum.remaining, 2);
  } finally { await t.mock.close(); }
});

test('Dropbox: scambio codice salva il refresh token; cartella mancante → errore chiaro', async () => {
  const t = await setup();
  try {
    await t.dropbox.exchangeCode('CODICE');
    assert.equal(t.config.get().dropbox.refreshToken, 'RT-NEW');
    await assert.rejects(() => t.dropbox.listImages('/Nulla'), /Cartella Dropbox non trovata/);
    assert.deepEqual(await t.extractor.listModels('groq'), ['a-model', 'b-model']);
  } finally { await t.mock.close(); }
});

test('scarta e annulla', async () => {
  const t = await setup();
  try {
    t.state.files.push({ id: 'id:1', name: 'a.jpg', path: '/Daniele/a.jpg', data: Buffer.from('q') });
    t.state.llm.push(ok({ store: 'Lidl', date: today, total: 3 }));
    await t.pipeline.scanDropbox();
    const it = t.pipeline.list()[0];
    const d = await t.pipeline.discard(it.id);
    assert.equal(d.status, 'discarded');
    assert.equal(t.state.moved.get('id:1'), '/Daniele/Scartati/a.jpg');
    const ac = new AbortController();
    t.state.files.push({ id: 'id:2', name: 'b.jpg', path: '/Daniele/b.jpg', data: Buffer.from('w') });
    ac.abort();
    await assert.rejects(() => t.pipeline.scanDropbox({ signal: ac.signal }), /annullata|abort/i);
  } finally { await t.mock.close(); }
});
