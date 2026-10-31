'use strict';
/* Avvio, barra superiore, pannello di scansione, eventi dal processo principale. */

const TABS = [['review', 'Da rivedere'], ['history', 'Storico'], ['settings', 'Impostazioni']];
let ticker = null;

function reviewCount() { return reviewItems().filter((i) => i.status !== 'processing').length; }

function renderTabs() {
  $('#tabs').replaceChildren(...TABS.map(([key, label]) => {
    const n = key === 'review' ? reviewCount() : 0;
    return h('button', { class: `tab ${S.tab === key ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': S.tab === key ? 'true' : 'false', onclick: () => setTab(key) },
      label, n ? h('span', { class: 'count', text: String(n) }) : null);
  }));
}

function renderActions() {
  const box = $('#actions');
  if (S.job) {
    box.replaceChildren(h('button', { class: 'btn danger', type: 'button', onclick: () => api.scan.cancel().catch(() => {}) }, 'Annulla'));
    return;
  }
  box.replaceChildren(
    h('button', { class: 'btn', type: 'button', onclick: importFlow }, 'Importa foto…'),
    h('button', { class: 'btn primary', type: 'button', id: 'btn-scan', onclick: startScan }, 'Scansiona Dropbox'));
}

function updateChrome() {
  renderTabs();
  renderActions();
}

function setTab(tab) {
  if (S.tab === 'settings' && tab !== 'settings' && !S.draft) return;
  S.tab = tab;
  updateChrome();
  renderView();
}

function renderView() {
  if (S.tab === 'review') renderReview();
  else if (S.tab === 'history') renderHistory();
  else renderSettings();
}

// ---------- scansione / importazione ----------

function ring(sec) {
  const C = 2 * Math.PI * 26;
  const frac = (sec % 60) / 60;
  return h('svg', { class: 'ring', viewBox: '0 0 64 64', role: 'img', 'aria-label': `${Math.floor(sec)} secondi trascorsi` },
    h('circle', { cx: 32, cy: 32, r: 26, class: 'ring-bg' }),
    h('circle', { cx: 32, cy: 32, r: 26, class: 'ring-fg', 'stroke-dasharray': `${(C * frac).toFixed(1)} ${C.toFixed(1)}`, transform: 'rotate(-90 32 32)' }),
    h('text', { x: 32, y: 37, 'text-anchor': 'middle', class: 'ring-t' }, `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`));
}

function renderScanPanel() {
  const p = $('#scanpanel');
  if (!S.job) { p.hidden = true; p.replaceChildren(); return; }
  p.hidden = false;
  const sec = (Date.now() - S.job.startedAt) / 1000;
  const pr = S.progress;
  let line = S.job.kind === 'reextract' ? 'Rilettura in corso…' : 'Cerco gli scontrini…';
  if (pr?.phase === 'item') line = `Leggo ${pr.current} (${pr.done + 1} di ${pr.total})`;
  const frac = pr?.phase === 'item' && pr.total ? pr.done / pr.total : 0;
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(frac * 100) }, h('div', { class: 'bar-fill' }));
  bar.firstChild.style.width = `${Math.round(frac * 100)}%`;
  p.replaceChildren(ring(sec), h('div', { class: 'scan-text' },
    h('div', { class: 'scan-line', text: line }),
    bar,
    S.statusMsg ? h('div', { class: 'muted', text: S.statusMsg }) : null));
}

function startTicker() {
  stopTicker();
  ticker = setInterval(renderScanPanel, 500);
}
function stopTicker() { if (ticker) clearInterval(ticker); ticker = null; }

function summaryToast(s) {
  if (!s) return;
  if (s.cancelled) { toast('Operazione annullata.', 'warn'); return; }
  const parts = [`${s.added} nuovi da rivedere`];
  if (s.duplicates) parts.push(`${s.duplicates} doppi scartati`);
  if (s.errors) parts.push(`${s.errors} con errore`);
  toast(parts.join(' · '), s.errors ? 'warn' : 'ok');
  if (s.stopped === 'models') toast(`Scansione interrotta: ${(s.lastError || 'i modelli non rispondono').slice(0, 260)}. Restano ${s.remaining} foto da leggere.`, 'error');
  if (s.missingFolders?.length) toast(`Cartella non trovata su Dropbox: ${s.missingFolders.join(', ')}`, 'warn');
  if (!s.found && !s.added && !s.errors) toast('Nessuna nuova foto trovata nelle cartelle.', 'ok');
}

async function startScan() {
  if (!S.settings?.dropbox?.refreshToken) {
    toast('Collega prima Dropbox nelle Impostazioni.', 'warn');
    setTab('settings');
    return;
  }
  const needsKey = (S.settings.models || []).filter((m) => m.enabled).every((m) => {
    const p = S.settings.providers.find((x) => x.id === m.providerId);
    return !p || (!p.apiKey && !/localhost|127\.0\.0\.1/.test(p.baseUrl));
  });
  if (needsKey) {
    toast('Manca la chiave API del modello (es. Groq): inseriscila in Impostazioni → Modelli di lettura e salva.', 'warn');
    setTab('settings');
    return;
  }
  if (!S.settings.notion?.apiKey) {
    toast('Manca la chiave di Notion: inseriscila in Impostazioni.', 'warn');
    setTab('settings');
    return;
  }
  try { summaryToast(await api.scan.start()); } catch (e) { toast(errMsg(e), 'error'); }
}

async function importPaths(paths) {
  if (!paths.length) return;
  const person = await askPerson();
  if (!person) return;
  try { summaryToast(await api.importPaths(paths, person)); } catch (e) { toast(errMsg(e), 'error'); }
}

async function importFlow() {
  try { await importPaths(await api.pickFiles()); } catch (e) { toast(errMsg(e), 'error'); }
}

// ---------- barra di stato (quota del provider) ----------

function renderStatusbar() {
  const q = Object.values(S.quota);
  $('#statusbar').replaceChildren(...(q.length
    ? q.map((x) => h('span', {}, h('strong', { text: x.provider }), ' · ',
        x.remainingRequests != null ? `richieste rimaste ${fmtNum(x.remainingRequests)}${x.limitRequests ? `/${fmtNum(x.limitRequests)}` : ''}` : '',
        x.remainingTokens != null ? ` · token ${fmtNum(x.remainingTokens)}${x.limitTokens ? `/${fmtNum(x.limitTokens)}` : ''}` : ''))
    : [h('span', { class: 'muted', text: 'Le foto restano sul tuo computer e su Dropbox; al modello va solo la foto ridotta di ogni scontrino.' })]));
}

// ---------- eventi ----------

async function refreshItems() {
  const list = await api.items.list();
  S.items = new Map(list.map((i) => [i.id, i]));
  if (!S.items.has(S.selected) || !REVIEW_STATES.includes(S.items.get(S.selected).status)) {
    const q = reviewItems();
    S.selected = (q.find((i) => i.status === 'pending') || q.find((i) => i.status === 'error'))?.id || null;
  }
  updateChrome();
  if (S.tab === 'review') { renderList(); renderDetail(); }
  else if (S.tab === 'history') renderHistoryBody();
}

function onItem(item) {
  const prev = S.items.get(item.id);
  S.items.set(item.id, item);
  updateChrome();
  if (S.tab === 'history') { renderHistoryBody(); return; }
  if (S.tab !== 'review') return;
  if (!S.selected && ['pending', 'error'].includes(item.status)) S.selected = item.id;

  if (item.id === S.selected && !REVIEW_STATES.includes(item.status)) {
    // lo scontrino selezionato è stato inviato o scartato: passo al prossimo
    const next = reviewItems().find((x) => x.status === 'pending') || reviewItems()[0];
    S.selected = next ? next.id : null;
    renderList();
    renderDetail();
    return;
  }
  renderList();
  if (item.id !== S.selected) return;
  if ($('#form') && prev && prev.status === item.status) renderWarnings(item); // non tocco i campi mentre scrivi
  else renderDetail();
}

function wireEvents() {
  api.on('evt:item', onItem);
  api.on('evt:removed', (id) => { S.items.delete(id); if (S.selected === id) S.selected = null; updateChrome(); if (S.tab === 'review') { renderList(); renderDetail(); } });
  api.on('evt:progress', (p) => { S.progress = p; renderScanPanel(); });
  api.on('evt:quota', (q) => { S.quota[q.provider] = q; renderStatusbar(); });
  api.on('evt:status', (s) => {
    S.statusMsg = s.type === 'wait' ? `Limite di velocità di ${s.model}: attendo ${Math.ceil(s.ms / 1000)} s…`
      : s.type === 'fallback' ? `${s.model} non disponibile, passo al modello successivo…` : '';
    renderScanPanel();
  });
  api.on('evt:job', (j) => {
    if (j.running) { S.job = { kind: j.kind, startedAt: Date.now() }; S.progress = null; S.statusMsg = ''; startTicker(); }
    else { S.job = null; S.progress = null; S.statusMsg = ''; stopTicker(); }
    updateChrome();
    renderScanPanel();
    if (!j.running) refreshItems().catch(() => {});
    if (S.tab === 'review' && $('#detail')) renderDetail();
  });
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if ($('#modal-root').firstChild) return;
    if (S.tab !== 'review') return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.selected) { e.preventDefault(); doConfirm(S.selected); return; }
    if (inField) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); neighbour(1); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); neighbour(-1); }
    else if (e.key === 'Delete' && S.selected) { e.preventDefault(); doDiscard(S.selected); }
  });
  let depth = 0;
  const dz = $('#dropzone');
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; dz.hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dz.hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    dz.hidden = true;
    const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
    importPaths(paths);
  });
}

async function init() {
  wireEvents();
  wireKeys();
  renderStatusbar();
  try {
    await Promise.all([loadSettings(), initSettings()]);
    const list = await api.items.list();
    S.items = new Map(list.map((i) => [i.id, i]));
  } catch (e) { toast(errMsg(e), 'error'); }
  const needsSetup = !S.settings?.notion?.apiKey || !S.settings?.dropbox?.refreshToken || !S.settings?.providers?.some((p) => p.apiKey || /localhost|127\.0\.0\.1/.test(p.baseUrl));
  S.tab = needsSetup && ![...S.items.values()].length ? 'settings' : 'review';
  updateChrome();
  renderView();
  if (needsSetup && S.tab === 'settings') toast('Benvenuto! Inserisci le chiavi di Dropbox, Notion e Groq per iniziare.', 'ok');
  api.conti.list().then((c) => { S.conti = c; S.contiError = null; if (S.tab === 'review') renderDetail(); }).catch((e) => { S.contiError = errMsg(e); });
}

document.addEventListener('DOMContentLoaded', init);
