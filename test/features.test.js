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
    assert.deepEqual(runs[0].slice(0, 3), ['pkexec', '/bin/sh', '-c']);
    assert.match(runs[0][3], /sha256sum -c/, 'la verifica avviene dentro lo script eseguito da root');
    assert.deepEqual(runs[0].slice(4, 5), ['quadra-update']);
    assert.equal(runs[0][5], path.join(dir, 'quadra_1.2.0_amd64.deb'));
    assert.match(runs[0][6], /^[0-9a-f]{64}$/);
    assert.deepEqual(runs[0].slice(7), ['1.2.0', 'quadra']);
    assert.equal(fs.existsSync(runs[0][5]), false, 'il pacchetto scaricato viene rimosso dopo l\'installazione');
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

test('statistiche: ripartizione per persona (spese condivise divise a metà, senza Tag = Non assegnato)', () => {
  const { buildStats } = require('../src/core/stats');
  const ex = [
    { id: 1, date: '2026-11-03', store: 'A', amount: -100, people: ['Daniele'] },
    { id: 2, date: '2026-11-04', store: 'B', amount: -60, people: ['Ettore'] },
    { id: 3, date: '2026-11-05', store: 'C', amount: -20, people: ['Daniele', 'Ettore'] },
    { id: 4, date: '2026-11-05', store: 'D', amount: -10, people: [] },
    { id: 5, date: '2026-10-28', store: 'E', amount: -50, people: ['Ettore'] },
  ];
  const s = buildStats(ex, { period: 'week', today: '2026-11-07' });
  const by = Object.fromEntries(s.byPerson.map((p) => [p.name, p]));
  assert.equal(s.total, 190);
  assert.equal(by.Daniele.total, 110);
  assert.equal(by.Ettore.total, 70);
  assert.equal(by['Non assegnato'].total, 10);
  assert.equal(by.Ettore.prevTotal, 50);
  assert.deepEqual(s.daily[3].byPerson, { Daniele: 10, Ettore: 10, 'Non assegnato': 10 });
  assert.equal(s.byPerson.reduce((a, p) => a + p.total, 0), s.total);
  const d = buildStats(ex, { period: 'week', today: '2026-11-07', person: 'Daniele' });
  assert.equal(d.total, 110);
});

test('aggiornamento: rifiuta repository malformati, pacchetti senza firma o con nome estraneo', async () => {
  const x = await updaterSetup();
  try {
    x.t.config.set?.({});
    const orig = x.t.config.get;
    x.t.config.get = () => ({ ...orig.call(x.t.config), update: { ...orig.call(x.t.config).update, repo: '../etc/passwd' } });
    assert.equal((await x.up.check()).phase, 'error');
    x.t.config.get = orig;
    x.t.state.release.assets[0].digest = null;
    const s = await x.up.check();
    assert.equal(s.phase, 'error');
    assert.match(s.error, /firma/);
    x.t.state.release.assets[0].digest = 'sha256:' + '1'.repeat(64);
    x.t.state.release.assets[0].name = 'altro_1.2.0_amd64.deb';
    assert.equal((await x.up.check()).phase, 'error');
    assert.equal(x.runs.length, 0);
  } finally { await x.t.mock.close?.(); }
});

test('aggiornamento: lo script da root copia, verifica sha256 e nome/versione prima di installare', () => {
  const { execFileSync } = require('node:child_process');
  const { ROOT_SCRIPT } = require('../src/core/updater');
  const d = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qroot-'));
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  // finti dpkg-deb e apt-get: registrano cosa succede
  fs.writeFileSync(path.join(bin, 'dpkg-deb'), '#!/bin/sh\n[ "$3" = Package ] && echo "${FAKE_PKG:-quadra}" || echo "${FAKE_VER:-1.2.0}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'apt-get'), '#!/bin/sh\necho "$@" >> "$LOG"\n', { mode: 0o755 });
  const pkg = path.join(d, 'p.deb'); fs.writeFileSync(pkg, 'contenuto');
  const sha = crypto.createHash('sha256').update('contenuto').digest('hex');
  const run = (extra, sh = sha, ver = '1.2.0') => execFileSync('/bin/sh', ['-c', ROOT_SCRIPT, 'x', pkg, sh, ver, 'quadra'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: path.join(d, 'log'), ...extra }, stdio: 'pipe' });
  run({});
  assert.match(fs.readFileSync(path.join(d, 'log'), 'utf8'), /install -y \/var\/tmp\/quadra-update\./);
  fs.rmSync(path.join(d, 'log'));
  assert.throws(() => run({}, '0'.repeat(64)), 'sha256 errata');
  assert.throws(() => run({ FAKE_PKG: 'altro' }), 'nome pacchetto diverso');
  assert.throws(() => run({ FAKE_VER: '9.9.9' }), 'versione diversa da quella annunciata');
  assert.equal(fs.existsSync(path.join(d, 'log')), false, 'nessuna installazione in caso di errore');
  assert.deepEqual(fs.readdirSync('/var/tmp').filter((n) => n.startsWith('quadra-update.')), [], 'cartella temporanea ripulita');
});

// ---------- password di accesso ----------

test('blocco: hash scrypt, nessuna password in chiaro, permessi 0600, cambio e rimozione', async () => {
  const { AppLock } = require('../src/core/lock');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'lock.json');
  const L = new AppLock({ file: f, params: { N: 1024, r: 8, p: 1 } });
  assert.equal(L.isLocked(), false);
  await assert.rejects(L.setPassword('corta'), /almeno 8/);
  await L.setPassword('una-password-lunga');
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!raw.includes('una-password-lunga'));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  L.lock();
  assert.equal(L.isLocked(), true);
  await assert.rejects(L.unlock('sbagliata'), /errata/);
  await L.unlock('una-password-lunga');
  assert.equal(L.isLocked(), false);
  // riavvio: parte bloccata
  const L2 = new AppLock({ file: f, params: { N: 1024, r: 8, p: 1 } });
  assert.equal(L2.isLocked(), true);
  await L2.unlock('una-password-lunga');
  await assert.rejects(L2.setPassword('nuova-password-1', 'sbagliata'), /errata/);
  await L2.setPassword('nuova-password-1', 'una-password-lunga');
  await assert.rejects(L2.removePassword('una-password-lunga'), /errata/);
  await L2.removePassword('nuova-password-1');
  assert.equal(L2.isSet(), false);
  assert.equal(fs.existsSync(f), false);
});

test('blocco: dopo 5 errori scatta l\'attesa crescente, anche dopo il riavvio e con tentativi in parallelo', async () => {
  const { AppLock } = require('../src/core/lock');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'lock.json');
  let t = 1_000_000;
  const mk = () => new AppLock({ file: f, now: () => t, params: { N: 1024, r: 8, p: 1 } });
  const L = mk();
  await L.setPassword('una-password-lunga');
  L.lock();
  const res = await Promise.allSettled(Array.from({ length: 8 }, () => L.unlock('no')));
  assert.ok(res.every((r) => r.status === 'rejected'));
  assert.match(res[7].reason.message, /Troppi tentativi/);
  assert.equal(L.isLocked(), true);
  await assert.rejects(mk().unlock('una-password-lunga'), /Troppi tentativi/, 'il riavvio non azzera l\'attesa');
  t += 31_000;
  await assert.rejects(L.unlock('no'), /Riprova tra 60/, 'attesa raddoppiata');
  t += 61_000;
  await L.unlock('una-password-lunga');
  assert.equal(L.status().retryInS, 0);
});
