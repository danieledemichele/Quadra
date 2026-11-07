'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setup } = require('./helpers');
const { buildStats } = require('../src/core/stats');
const { ExpenseService } = require('../src/core/expenses');
const { Updater, cmpVersion } = require('../src/core/updater');

const E = (id, date, store, amount, categoria, people = ['Daniele']) => ({ id, date, store, amount, categoria, people });
const DATA = [
  E('1', '2026-11-02', 'Conad', -20, 'Spesa alimentare'),
  E('2', '2026-11-02', 'Lidl', -10, 'Spesa alimentare', ['Ettore']),
  E('3', '2026-11-05', 'Cena', -50, '—'),
  E('4', '2026-10-27', 'Conad', -40, 'Spesa alimentare'),
  E('5', '2026-10-30', 'Conad', -20, 'Spesa alimentare'),
  E('6', '2026-10-15', 'Bolletta', -100, 'Casa'),
  E('7', '2026-11-01', 'Stipendio', 1000, null),
];
const TODAY = '2026-11-07'; // sabato

test('statistiche settimana: totali, confronto, categorie, giorni', () => {
  const s = buildStats(DATA, { period: 'week', today: TODAY });
  assert.equal(s.range.from, '2026-11-02');
  assert.equal(s.range.to, '2026-11-08');
  assert.equal(s.range.label, '2 – 8 nov 2026');
  assert.equal(s.total, 80);
  assert.equal(s.count, 3);
  assert.equal(s.elapsedDays, 6);
  assert.equal(s.avgPerDay, 13.33);
  assert.deepEqual(s.comparison, { prevTotal: 60, prevToDate: 60, delta: 0.33, partial: true });
  assert.deepEqual(s.daily.map((d) => d.label), ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom']);
  assert.equal(s.daily[0].total, 30);
  assert.equal(s.daily[3].total, 50);
  assert.deepEqual(s.daily.map((d) => d.future), [false, false, false, false, false, false, true]);
  assert.deepEqual(s.byCategory.map((c) => [c.name, c.total]), [['Senza categoria', 50], ['Spesa alimentare', 30]]);
  assert.equal(Math.round(s.byCategory[0].pct * 100), 63);
  assert.deepEqual(s.topStores.map((x) => x.name), ['Cena', 'Conad', 'Lidl']);
  assert.deepEqual(s.biggest, { date: '2026-11-05', store: 'Cena', amount: 50 });
  assert.equal(s.recent[0].store, 'Cena');
  assert.equal(s.weeks8.length, 8);
  assert.equal(s.weeks8.at(-1).total, 80);
  assert.deepEqual(s.people, ['Daniele', 'Ettore']);
  assert.equal(s.minDate, '2026-10-15', 'le entrate non contano');
});

test('statistiche mese: ritmo cumulato, periodo passato, persona, navigazione', () => {
  const m = buildStats(DATA, { period: 'month', today: TODAY });
  assert.equal(m.range.label, 'novembre 2026');
  assert.equal(m.daily.length, 30);
  assert.equal(m.total, 80);
  assert.equal(m.cumulative[6], 80);
  assert.equal(m.cumulative[7], null);
  assert.equal(m.prevCumulative.length, 31);
  assert.equal(m.prevCumulative.at(-1), 160);
  assert.equal(m.comparison.delta, null);
  assert.equal(m.months12.length, 12);
  assert.deepEqual(m.months12.slice(-2).map((x) => [x.key, x.total, x.current]), [['2026-10', 160, false], ['2026-11', 80, true]]);

  const oct = buildStats(DATA, { period: 'month', anchor: '2026-10-10', today: TODAY });
  assert.equal(oct.total, 160);
  assert.equal(oct.range.isCurrent, false);
  assert.equal(oct.comparison.partial, false);
  assert.equal(oct.avgPerDay, 5.16); // 160 / 31 giorni

  const et = buildStats(DATA, { period: 'week', person: 'Ettore', today: TODAY });
  assert.equal(et.total, 10);
  const prevWeek = buildStats(DATA, { period: 'week', anchor: '2026-10-28', today: TODAY });
  assert.equal(prevWeek.total, 60);
  assert.equal(prevWeek.range.label, '26 ott – 1 nov 2026');
  assert.equal(buildStats([], { today: TODAY }).hasAny, false);
});

test('spese da Notion: lettura righe, copia locale, dati vecchi', async () => {
  const t = await setup();
  try {
    t.state.expenseRows = [
      { id: 'p1', properties: { Descrizione: { type: 'title', title: [{ plain_text: 'Conad' }] }, Data: { date: { start: '2026-11-02T10:00:00+01:00' } }, Importo: { number: -20 },
        Tags: { multi_select: [{ name: 'Daniele' }] }, Categoria: { formula: { string: 'Spesa alimentare' } } } },
      { id: 'p2', properties: { Descrizione: { type: 'title', title: [{ plain_text: 'Senza data' }] }, Data: { date: null }, Importo: { number: -5 } } },
      { id: 'p3', properties: { Descrizione: { type: 'title', title: [{ plain_text: 'Stipendio' }] }, Data: { date: { start: '2026-11-01' } }, Importo: { number: 900 }, Categoria: { formula: { string: '' } } } },
    ];
    let clock = 1000;
    const file = path.join(t.dir, 'expenses.json');
    const svc = new ExpenseService({ notion: t.notion, file, now: () => clock, today: () => TODAY });
    assert.equal(svc.view({ period: 'week' }).stale, true);
    await svc.refresh();
    assert.equal(svc.items.length, 2);
    assert.deepEqual(svc.items[0], { id: 'p1', date: '2026-11-02', store: 'Conad', amount: -20, categoria: 'Spesa alimentare', people: ['Daniele'] });
    const v = svc.view({ period: 'week' });
    assert.equal(v.stats.total, 20);
    assert.equal(v.stale, false);
    clock += 11 * 60 * 1000;
    assert.equal(svc.view({ period: 'week' }).stale, true);
    // riapertura: la copia su disco è disponibile subito
    const again = new ExpenseService({ notion: t.notion, file, now: () => clock, today: () => TODAY });
    assert.equal(again.view({ period: 'week' }).hasCache, true);
    assert.equal(again.view({ period: 'week' }).stats.total, 20);
    svc.markStale();
    assert.equal(svc.view({ period: 'week' }).stale, true);
  } finally { await t.mock.close(); }
});

// ---------- aggiornamento in un clic ----------

async function updaterSetup(version = '1.1.0', bytes = Buffer.from('contenuto-deb-finto')) {
  const t = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  t.state.assetBytes = bytes;
  t.state.release = { tag_name: 'v1.2.0', body: 'Novità: panoramica', html_url: 'https://github.com/x/y/releases/v1.2.0',
    assets: [{ id: 7, name: 'quadra_1.2.0_amd64.deb', size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') }] };
  const runs = [];
  const run = async (cmd, args) => { runs.push([cmd, ...args]); if (t.state.runError) throw t.state.runError; };
  const up = new Updater({ config: t.config, currentVersion: version, dir, apiBase: t.mock.base, run, arch: 'x64' });
  const states = [];
  up.on('state', (s) => states.push(s.phase));
  return { t, up, dir, runs, states };
}

test('versioni: confronto numerico', () => {
  assert.equal(cmpVersion('1.10.0', '1.9.9'), 1);
  assert.equal(cmpVersion('v1.1.0', '1.1.0'), 0);
  assert.equal(cmpVersion('1.0.9', '1.1.0'), -1);
});

test('aggiornamento: controllo, download verificato, installazione con pkexec', async () => {
  const { t, up, dir, runs, states } = await updaterSetup();
  try {
    t.config.applyPublic({ ...t.config.getPublic(), update: { repo: 'x/y', token: 'tok123', autoCheck: true } });
    const st = await up.check();
    assert.equal(st.phase, 'available');
    assert.equal(st.latest, '1.2.0');
    assert.match(st.notes, /panoramica/);
    await up.update();
    assert.deepEqual(states.filter((s, i) => states.indexOf(s) === i), ['checking', 'available', 'downloading', 'installing', 'installed']);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].slice(0, 5), ['pkexec', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install']);
    assert.equal(runs[0].at(-1), path.join(dir, 'quadra_1.2.0_amd64.deb'));
    assert.equal(fs.existsSync(runs[0].at(-1)), false, 'il pacchetto scaricato viene rimosso dopo l\'installazione');
    assert.equal(t.state.assetAuth, 'Bearer tok123');
  } finally { await t.mock.close(); }
});

test('aggiornamento: nessuna novità, firma errata, autorizzazione negata, repository privato', async () => {
  let x = await updaterSetup('1.2.0');
  try {
    assert.equal((await x.up.check()).phase, 'none');
  } finally { await x.t.mock.close(); }

  x = await updaterSetup();
  try {
    x.t.state.release.assets[0].digest = 'sha256:' + '0'.repeat(64);
    await x.up.check();
    await assert.rejects(() => x.up.update(), /sha256/);
    assert.equal(x.up.state.phase, 'error');
    assert.equal(x.runs.length, 0, 'nulla viene installato se la firma non torna');
    assert.deepEqual(fs.readdirSync(x.dir), []);
  } finally { await x.t.mock.close(); }

  x = await updaterSetup();
  try {
    await x.up.check();
    x.t.state.runError = Object.assign(new Error('Command failed'), { code: 126 });
    await assert.rejects(() => x.up.update(), /Autorizzazione annullata/);
    assert.equal(x.up.busy, false);
  } finally { await x.t.mock.close(); }

  x = await updaterSetup();
  try {
    x.t.state.releaseStatus = 404;
    const st = await x.up.check();
    assert.equal(st.phase, 'error');
    assert.match(st.error, /privato/);
    x.t.state.releaseStatus = 0;
    x.t.state.release.assets = [];
    assert.match((await x.up.check()).error, /non contiene il pacchetto/);
    await assert.rejects(() => x.up.update(), /controlla prima/);
  } finally { await x.t.mock.close(); }
});
