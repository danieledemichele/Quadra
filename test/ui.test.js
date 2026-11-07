'use strict';
// Prova l'interfaccia in Chromium con una finta window.api. Salta se Playwright non è installato.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildStats } = require('../src/core/stats');

const STORES = [['Conad', 'Spesa alimentare'], ['Lidl', 'Spesa alimentare'], ['Eurospin', 'Spesa alimentare'], ['Bar Centrale', 'Svago'], ['Farmacia', 'Salute'], ['Benzina', null], ['Cinema', 'Svago']];
const DATA = [];
for (let i = 0; i < 160; i++) {
  const d = new Date(Date.UTC(2026, 10, 7) - i * 86400000 * 1.3).toISOString().slice(0, 10);
  const [store, cat] = STORES[(i * 3) % STORES.length];
  DATA.push({ id: 'e' + i, date: d, store, amount: -(8 + ((i * 37) % 60) + (i % 5)), categoria: cat, people: [i % 3 ? 'Daniele' : 'Ettore'] });
}
DATA.push({ id: 'in', date: '2026-11-01', store: 'Stipendio', amount: 1500, categoria: null, people: [] });

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* opzionale */ }

const shots = process.env.UI_SHOTS;
const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name + '.png') }); } };

test('interfaccia: revisione, modifica, invio, storico, impostazioni', { skip: !chromium && 'playwright non installato' }, async () => {
  const browser = await chromium.launch();
  try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
  page.setDefaultTimeout(8000);
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`console.${m.type()}: ${m.text()}`); });
  await page.exposeFunction('nodeStats', (o) => ({ stats: buildStats(DATA, { ...o, today: '2026-11-07' }), fetchedAt: Date.now(), stale: false, hasCache: true }));
  await page.addInitScript({ content: fs.readFileSync(path.join(__dirname, 'ui-stub.js'), 'utf8') });
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href);

  // panoramica (pagina iniziale)
  await page.waitForSelector('.dash .kpi');
  assert.match(await page.locator('.tab.active').innerText(), /Panoramica/);
  assert.equal(await page.locator('.kpi').count(), 4);
  assert.equal(await page.locator('.range').innerText(), '2 – 8 nov 2026');
  const dailySvg = page.locator('.dcard:has(h3:text-is("Spesa giornaliera")) svg.chart');
  await dailySvg.waitFor();
  assert.equal(await dailySvg.locator('text.lab:not(.sub)').count(), 7);
  assert.ok(await dailySvg.locator('rect.seg-p').count() >= 4, 'grafico diviso per persona');
  assert.equal(await page.locator('.pitem').count(), 2, 'una scheda per persona');
  assert.match(await page.locator('.pdiff').innerText(), /ha speso .* in più di|identica/);
  // schermo intero: il grafico si allarga insieme alla finestra
  const w1 = await dailySvg.evaluate((e) => e.getBoundingClientRect().width);
  await page.setViewportSize({ width: 1900, height: 1000 });
  await page.waitForFunction((w) => { const e = document.querySelector('.dcard svg.chart'); const b = e.parentElement.clientWidth; return Math.abs(e.getBoundingClientRect().width - b) < 2 && Math.abs(b - w) > 20; }, w1);
  await shot(page, '0-dashboard-fullscreen');
  await page.setViewportSize({ width: 1280, height: 860 });
  assert.ok(await page.locator('.blist-row').count() >= 2);
  assert.ok(await page.locator('.move').count() >= 1);
  const weekTotal = await page.locator('.kpi-v').first().innerText();
  await shot(page, '0-dashboard-week');
  await page.click('.seg-btn:has-text("Mese")');
  await page.waitForFunction(() => document.querySelector('.range').textContent === 'novembre 2026');
  await page.waitForSelector('polyline.line.cur');
  assert.ok(await page.locator('polyline.line.cur').count() === 1, 'ritmo del mese');
  await page.waitForSelector('polyline.line.cur');
  assert.ok(await page.locator('.dcard:has(h3:text-is("Spesa giornaliera")) text.lab:not(.sub)').count() >= 8);
  await shot(page, '0b-dashboard-month');
  await page.click('button[aria-label="Periodo precedente"]');
  await page.waitForFunction(() => document.querySelector('.range').textContent === 'ottobre 2026');
  assert.equal(await page.isDisabled('button[aria-label="Periodo successivo"]'), false);
  await page.click('button:has-text("Questo mese")');
  await page.waitForFunction(() => document.querySelector('.range').textContent === 'novembre 2026');
  assert.equal(await page.isDisabled('button[aria-label="Periodo successivo"]'), true);
  await page.selectOption('select[aria-label="Persona"]', 'Ettore');
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'stats' && c[1].person === 'Ettore'));
  await page.click('.seg-btn:has-text("Settimana")');
  await page.waitForFunction(() => document.querySelector('.range').textContent === '2 – 8 nov 2026');
  assert.notEqual(await page.locator('.kpi-v').first().innerText(), weekTotal, 'il filtro persona cambia il totale');
  await page.selectOption('select[aria-label="Persona"]', '');

  // aggiornamento in un clic
  assert.match(await page.locator('#updatebar').innerText(), /1\.2\.0 è disponibile/);
  await shot(page, '0c-update-banner');
  await page.click('#updatebar button:has-text("Aggiorna ora")');
  await page.waitForFunction(() => document.querySelector('#updatebar').textContent.includes('riavvio'));
  assert.ok(await page.evaluate(() => window.__calls.some((c) => c[0] === 'install')));

  await page.click('.tab:has-text("Da rivedere")');
  await page.waitForSelector('.row');
  assert.equal(await page.locator('.row').count(), 5);
  assert.match(await page.locator('.tab.active').innerText(), /Da rivedere/);
  assert.equal((await page.locator('.tab.active .count').innerText()).trim(), '4'); // il "processing" non conta
  await page.waitForSelector('#f-store');
  assert.equal(await page.inputValue('#f-store'), 'Panificio Rossi');
  await page.waitForSelector('.photo-img[src^="data:"]');
  assert.ok(await page.locator('#warnings .note.info').count() >= 1);
  await shot(page, '1-review');

  // modifica negozio: salvataggio con debounce, avvisi aggiornati senza perdere il testo
  await page.fill('#f-store', 'Conad');
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'update' && c[2]?.store === 'Conad'));
  assert.equal(await page.inputValue('#f-store'), 'Conad');
  await page.selectOption('#f-conto', 'c1');
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'update' && c[3] === 'c1'));

  // scontrino con avvisi
  await page.locator('.row', { hasText: 'Lidl' }).click();
  await page.waitForFunction(() => document.querySelector('#f-store').value === 'Lidl');
  assert.equal(await page.locator('#warnings .note.warn').count(), 2);
  await shot(page, '2-warnings');

  // invio con Ctrl+Invio dal primo scontrino
  await page.locator('.row', { hasText: 'Conad' }).click();
  await page.waitForFunction(() => document.querySelector('#f-store').value === 'Conad');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.toast');
  assert.match(await page.locator('.toast').first().innerText(), /Inserito in Notion/);
  const confirm = await page.evaluate(() => window.__calls.find((c) => c[0] === 'confirm'));
  assert.equal(confirm[2].store, 'Conad');
  assert.equal(confirm[3], 'c1');
  await page.waitForFunction(() => document.querySelectorAll('.row').length === 4);

  // errore: campi compilabili a mano
  await page.locator('.row', { hasText: 'IMG_a5' }).click();
  await page.waitForSelector('.banner.err');
  assert.equal(await page.isDisabled('#f-store'), false);
  await shot(page, '3-error');

  // scansione in corso
  await page.evaluate(() => { window.__emit('evt:job', { running: true, kind: 'scan' }); window.__emit('evt:progress', { phase: 'item', done: 2, total: 6, current: 'IMG_20261030.jpg', person: 'Daniele' }); window.__emit('evt:quota', { provider: 'Groq', remainingRequests: 812, limitRequests: 1000, remainingTokens: 6100, limitTokens: 8000 }); window.__emit('evt:status', { type: 'wait', ms: 12000, model: 'qwen/qwen3.8-27b' }); });
  await page.waitForSelector('#scanpanel:not([hidden]) .ring');
  assert.match(await page.locator('.scan-line').innerText(), /3 di 6/);
  assert.match(await page.locator('#statusbar').innerText(), /812\/1\.?000/);
  await shot(page, '4-scanning');
  await page.evaluate(() => window.__emit('evt:job', { running: false, kind: 'scan' }));
  await page.waitForSelector('#scanpanel', { state: 'hidden' });

  // storico
  await page.click('.tab:has-text("Storico")');
  await page.waitForSelector('.table');
  assert.equal(await page.locator('.table tbody tr').count(), 3); // 2 + quello appena inviato
  assert.match(await page.locator('#hist-sum').innerText(), /totale/);
  await page.fill('input[type=search]', 'lidl');
  assert.equal(await page.locator('.table tbody tr').count(), 0);
  await page.fill('input[type=search]', 'md');
  assert.equal(await page.locator('.table tbody tr').count(), 1);
  await page.fill('input[type=search]', '');
  await shot(page, '5-history');

  // impostazioni: aggiunta modello, salvataggio, test modello
  await page.click('.tab:has-text("Impostazioni")');
  await page.waitForSelector('.settings');
  // personalizzazione: tema scuro, sezione nascosta, ripristino
  await page.click('#card-aspetto .seg-btn:has-text("Scuro")');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.click('#card-aspetto .swatch[title="Arancio"]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#ff9f0a');
  await page.click('#card-aspetto .seg-btn:has-text("Molto grande")');
  await page.locator('#card-aspetto .checks label:has-text("Elenco movimenti")').click({ timeout: 3000 }).catch((e) => { throw new Error(e.message.slice(0, 600)); });
  await shot(page, '5b-appearance');
  await page.click('.tab:has-text("Panoramica")');
  await page.waitForSelector('.dash .kpi');
  assert.equal(await page.locator('.dcard:has(h3:has-text("Movimenti"))').count(), 0, 'sezione nascosta');
  await shot(page, '5c-dashboard-custom');
  await page.click('.tab:has-text("Impostazioni")');
  // password di accesso: attivazione con conferma, poi blocco manuale
  await page.fill('#card-sicurezza input >> nth=0', 'abc');
  await page.fill('#card-sicurezza input >> nth=1', 'diversa');
  await page.click('#card-sicurezza button:has-text("Attiva")');
  assert.equal(await page.locator('#card-sicurezza h3').count(), 0, 'password non coincidenti: non si attiva');
  await page.fill('#card-sicurezza input >> nth=0', 'una-password-lunga');
  await page.fill('#card-sicurezza input >> nth=1', 'una-password-lunga');
  await page.click('#card-sicurezza button:has-text("Attiva")');
  await page.waitForSelector('#card-sicurezza h3:has-text("Cambia password")');
  assert.ok(await page.locator('#actions button:has-text("Blocca")').count() === 1, 'pulsante Blocca nella barra');
  assert.ok(!/null/.test(await page.locator('#actions').innerText()), 'nessun "null" nella barra');
  await shot(page, '5d-security');
  await page.click('#card-aspetto button:has-text("Ripristina")');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme || 'auto'), 'auto');
  assert.equal(await page.locator('.mrow').count(), 2);
  await page.click('button:has-text("+ Aggiungi modello")');
  assert.equal(await page.locator('.mrow').count(), 3);
  await page.locator('.mrow').nth(2).locator('input[type=text]').fill('llama-3.3-70b-versatile');
  assert.equal(await page.locator('#btn-save').isDisabled(), false);
  await page.locator('.mrow').nth(2).locator('button:has-text("Prova")').click();
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'testModel'));
  const saved = await page.evaluate(() => window.__calls.find((c) => c[0] === 'save'));
  assert.equal(saved[1].models.length, 3, 'prima del test le modifiche vengono salvate');
  assert.equal(saved[1].notion.apiKey, '__keep__', 'i segreti già salvati non vengono riscritti');
  await shot(page, '6-settings');
  await page.mouse.wheel(0, 1500);
  await shot(page, '7-settings-bottom');

  assert.ok(await page.locator('h2:has-text("Aggiornamenti")').count() === 1);
  assert.equal(await page.locator('.settings input[placeholder="utente/nome"]').inputValue(), 'danieledemichele/quadra');

  // tema scuro
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('.tab:has-text("Panoramica")');
  await page.waitForSelector('.dash .kpi');
  await page.waitForTimeout(400);
  await shot(page, '8-dark');

  assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test('interfaccia: con la password attiva si vede solo la schermata di blocco', { skip: !chromium && 'playwright non installato' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
    page.setDefaultTimeout(8000);
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    await page.addInitScript(() => { window.__startLocked = true; });
    await page.addInitScript({ content: fs.readFileSync(path.join(__dirname, 'ui-stub.js'), 'utf8') });
    await page.addInitScript(() => { /* la finta app dà la password giusta */ });
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href);
    await page.waitForSelector('#lock-pw');
    assert.equal(await page.locator('.tab').count(), 0, 'nessuna scheda caricata');
    assert.equal(await page.locator('.dash, .kpi, .item').count(), 0, 'nessun dato nella pagina');
    assert.equal(await page.isVisible('header.top'), false);
    await page.fill('#lock-pw', 'sbagliata');
    await page.press('#lock-pw', 'Enter');
    await page.waitForFunction(() => /errata/.test(document.querySelector('.lock-msg').textContent));
    assert.equal(await page.inputValue('#lock-pw'), '', 'il campo si svuota dopo il tentativo');
    for (let i = 0; i < 2; i++) {
      await page.fill('#lock-pw', 'x'); await page.press('#lock-pw', 'Enter');
      await page.waitForFunction(() => !document.querySelector('#lock-pw').value);
      await page.waitForTimeout(100);
    }
    await page.waitForFunction(() => document.querySelector('.lock-msg').textContent.includes('30'));
    await page.waitForFunction(() => document.querySelector('#lock-pw').disabled, null, { timeout: 4000 });
    await shot(page, '9-lock');
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
