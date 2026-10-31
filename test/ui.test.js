'use strict';
// Prova l'interfaccia in Chromium con una finta window.api. Salta se Playwright non è installato.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
  await page.addInitScript({ content: fs.readFileSync(path.join(__dirname, 'ui-stub.js'), 'utf8') });
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href);

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

  // tema scuro
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('.tab:has-text("Da rivedere")');
  await page.waitForSelector('#f-store');
  await shot(page, '8-dark');

  assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
