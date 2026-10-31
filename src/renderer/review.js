'use strict';
/* Schermata "Da rivedere": lista a sinistra, foto + modulo a destra. */

const REVIEW_STATES = ['pending', 'processing', 'error'];

function reviewItems() {
  return [...S.items.values()].filter((i) => REVIEW_STATES.includes(i.status)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

const hasWarn = (i) => (i.warnings || []).some((w) => w.level === 'warn');
const isReady = (i) => i.status === 'pending' && !hasWarn(i) && i.data?.store && i.data?.date && i.data?.amount > 0;

function renderReview() {
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'split' },
    h('aside', { class: 'list-pane', id: 'list', 'aria-label': 'Scontrini da rivedere' }),
    h('section', { class: 'detail-pane', id: 'detail' })));
  const list = reviewItems();
  if (!S.selected || !S.items.has(S.selected) || !REVIEW_STATES.includes(S.items.get(S.selected).status)) {
    S.selected = (list.find((i) => i.status === 'pending') || list[0])?.id || null;
  }
  renderList();
  renderDetail();
}

function renderList() {
  const box = $('#list');
  if (!box) return;
  const list = reviewItems();
  const ready = list.filter(isReady);
  const head = h('div', { class: 'list-head' },
    h('span', { class: 'muted', text: list.length ? `${list.length} in coda` : '' }),
    ready.length ? h('button', { class: 'btn small primary', type: 'button', title: 'Invia in Notion tutti gli scontrini senza avvisi', onclick: sendAllReady }, ready.length === 1 ? 'Invia 1 pronto' : `Invia i ${ready.length} pronti`) : null);

  if (!list.length) {
    box.replaceChildren(head, h('div', { class: 'empty' },
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }),
      h('p', { class: 'empty-title', text: 'Tutto in ordine' }),
      h('p', { class: 'muted', text: 'Nessuno scontrino da rivedere. Scatta le foto, mettile nella cartella Dropbox e premi «Scansiona Dropbox», oppure trascina qui dei file.' })));
    return;
  }
  const rows = list.map((i) => {
    const d = i.data || {};
    const warn = i.status === 'pending' && hasWarn(i);
    return h('button', {
      class: `row ${i.id === S.selected ? 'selected' : ''} ${i.status}`, type: 'button', dataset: { id: i.id }, title: i.error || null,
      'aria-current': i.id === S.selected ? 'true' : null,
      onclick: () => selectItem(i.id),
    },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: d.store || (i.status === 'processing' ? 'Lettura in corso…' : i.fileName) }),
        h('div', { class: 'row-meta' }, fmtDate(d.date), ' · ', i.person, i.status === 'error' ? badge('errore', 'err') : null, warn ? badge('da controllare', 'warn') : null)),
      h('div', { class: 'row-amount', text: i.status === 'processing' ? '' : fmtMoney(d.amount) }));
  });
  box.replaceChildren(head, h('div', { class: 'rows', role: 'list' }, rows));
}

function selectItem(id) {
  S.selected = id;
  S.zoom = false;
  renderList();
  renderDetail();
}

function neighbour(delta) {
  const list = reviewItems();
  const i = list.findIndex((x) => x.id === S.selected);
  const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
  if (next) selectItem(next.id);
}

function renderDetail() {
  const box = $('#detail');
  if (!box) return;
  const item = S.items.get(S.selected);
  if (!item) {
    box.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'muted', text: 'Seleziona uno scontrino dalla lista.' })));
    return;
  }
  const busy = item.status === 'processing';
  const d = item.data || {};
  const stores = h('datalist', { id: 'stores-list' }, (S.settings?.knownStores || []).map((s) => h('option', { value: s })));

  const img = h('img', { alt: `Foto dello scontrino ${item.fileName}`, class: 'photo-img' });
  const fig = h('figure', { class: `photo ${S.zoom ? 'zoom' : ''}` },
    h('div', { class: 'photo-scroll', onclick: () => { S.zoom = !S.zoom; fig.classList.toggle('zoom', S.zoom); } }, img),
    h('figcaption', {}, h('span', { class: 'mono', text: item.fileName }), h('span', { class: 'muted', text: S.zoom ? ' · clic per adattare' : ' · clic per ingrandire' })));
  api.items.image(item.id).then((src) => {
    if (S.selected !== item.id) return;
    if (src) img.src = src;
    else fig.querySelector('.photo-scroll').replaceChildren(h('p', { class: 'muted pad', text: 'Anteprima non disponibile.' }));
  }).catch(() => {});

  const contoSel = h('select', { id: 'f-conto', disabled: busy, onchange: () => pushEdits(0) },
    h('option', { value: '', text: '— lo scelgo io in Notion —' }),
    S.conti.map((c) => h('option', { value: c.id, text: c.name })));
  contoSel.value = item.contoId || '';

  const raw = item.extracted?.store;
  const hint = raw && raw !== d.store ? h('div', { class: 'hint' }, 'Sullo scontrino: ', h('span', { class: 'mono', text: raw })) : null;

  const form = h('form', { class: 'receipt', id: 'form', onsubmit: (e) => { e.preventDefault(); doConfirm(item.id); } },
    h('div', { class: 'receipt-head' },
      h('span', { class: 'chip', text: item.person }),
      item.extracted?.model ? h('span', { class: 'muted mono', text: item.extracted.model }) : null),
    h('label', { class: 'field' }, h('span', { text: 'Negozio' }),
      h('input', { id: 'f-store', type: 'text', value: d.store || '', autocomplete: 'off', list: 'stores-list', disabled: busy, oninput: () => pushEdits(350) }), stores, hint),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', { text: 'Data' }),
        h('input', { id: 'f-date', type: 'date', value: d.date || '', disabled: busy, oninput: () => pushEdits(350) })),
      h('label', { class: 'field' }, h('span', { text: 'Importo' }),
        h('div', { class: 'money' }, h('span', { text: '€', 'aria-hidden': 'true' }),
          h('input', { id: 'f-amount', type: 'text', inputMode: 'decimal', class: 'mono', value: fmtAmountInput(d.amount), disabled: busy, oninput: () => pushEdits(350) })))),
    h('label', { class: 'field' }, h('span', { text: 'Conto' }), contoSel,
      S.contiError ? h('div', { class: 'hint err' }, 'Elenco conti non disponibile: ', S.contiError, ' ', h('button', { class: 'link', type: 'button', onclick: reloadConti, text: 'riprova' })) : null),
    h('div', { id: 'warnings' }),
    item.status === 'error' ? h('div', { class: 'banner err', role: 'alert' }, h('strong', { text: 'Lettura non riuscita. ' }), (item.error || '').replace(/[.\s]*$/, '. '), 'Puoi compilare i campi a mano oppure riprovare.') : null,
    busy ? h('div', { class: 'banner', text: 'Lettura in corso…' }) : null,
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn primary', type: 'submit', id: 'btn-send', disabled: busy, title: 'Ctrl+Invio' }, 'Invia a Notion', h('kbd', { text: 'Ctrl+↵' })),
      h('button', { class: 'btn', type: 'button', disabled: busy || !!S.job, onclick: () => doReextract(item.id) }, 'Rileggi'),
      h('button', { class: 'btn ghost danger', type: 'button', disabled: busy, onclick: () => doDiscard(item.id), title: 'Canc' }, 'Scarta')));

  box.replaceChildren(h('div', { class: 'detail-grid' }, fig, form));
  renderWarnings(item);
}

function renderWarnings(item) {
  const box = $('#warnings');
  if (!box) return;
  const ws = item.warnings || [];
  box.replaceChildren(...ws.map((w) => h('div', { class: `note ${w.level}`, role: w.level === 'warn' ? 'alert' : null },
    h('span', { class: 'note-ico', 'aria-hidden': 'true', text: w.level === 'warn' ? '⚠' : 'ℹ' }), w.text)));
}

let editTimer = null;
function readForm() {
  return {
    data: { store: $('#f-store').value, date: $('#f-date').value, amount: $('#f-amount').value },
    contoId: $('#f-conto').value || null,
  };
}

function pushEdits(delay) {
  const id = S.selected;
  clearTimeout(editTimer);
  const run = () => {
    if (!$('#form') || S.selected !== id) return;
    const f = readForm();
    api.items.update(id, f.data, f.contoId).catch(() => {});
  };
  if (delay) editTimer = setTimeout(run, delay);
  else run();
}

async function doConfirm(id) {
  const btn = $('#btn-send');
  if (btn) btn.disabled = true;
  clearTimeout(editTimer);
  try {
    const f = readForm();
    const it = await api.items.confirm(id, f.data, f.contoId);
    const cat = it.notion?.categoria;
    toast(cat ? `Inserito in Notion · ${cat}` : 'Inserito in Notion · categoria non riconosciuta (controlla il nome del negozio)', cat ? 'ok' : 'warn');
    if (it.warnings?.length) toast(it.warnings[0].text, 'warn');
    const list = reviewItems().filter((x) => x.id !== id);
    S.items.set(it.id, it);
    selectAfterRemoval(id, list);
  } catch (e) {
    toast(errMsg(e), 'error');
    if (btn) btn.disabled = false;
  }
}

function selectAfterRemoval(id, listBefore) {
  const all = reviewItems();
  const next = all.find((x) => x.id !== id && x.status === 'pending') || all[0];
  S.selected = next ? next.id : null;
  updateChrome();
  renderList();
  renderDetail();
}

async function doDiscard(id) {
  try {
    const it = await api.items.discard(id);
    S.items.set(it.id, it);
    toast('Scartato (la foto va nella cartella Scartati).', 'ok');
    selectAfterRemoval(id);
  } catch (e) { toast(errMsg(e), 'error'); }
}

async function doReextract(id) {
  try {
    const r = await api.items.reextract(id);
    if (r && r.cancelled) toast('Lettura annullata.', 'warn');
  } catch (e) { toast(errMsg(e), 'error'); }
}

async function sendAllReady() {
  const ready = reviewItems().filter(isReady);
  if (!ready.length) return;
  let contoId = '';
  const sel = h('select', {}, h('option', { value: '', text: '— lo scelgo io in Notion —' }), S.conti.map((c) => h('option', { value: c.id, text: c.name })));
  const ok = await modal({
    title: `Inviare ${ready.length} scontrini a Notion?`,
    body: h('div', {}, h('p', { class: 'muted', text: 'Verranno inviati solo quelli senza avvisi, così come sono letti. Puoi applicare lo stesso Conto a tutti.' }),
      h('label', { class: 'field' }, h('span', { text: 'Conto' }), sel)),
    actions: [{ label: 'Annulla', value: false }, { label: 'Invia', value: () => { contoId = sel.value; return true; }, kind: 'primary' }],
  });
  if (ok !== true) return;
  if (contoId) await Promise.all(ready.map((i) => api.items.update(i.id, undefined, contoId).catch(() => {})));
  try {
    const res = await api.items.confirmMany(ready.map((i) => i.id));
    const okN = res.filter((r) => r.ok).length;
    const bad = res.filter((r) => !r.ok);
    toast(`${okN} inseriti in Notion.`, 'ok');
    if (bad.length) toast(`${bad.length} non inviati: ${bad[0].error}`, 'error');
    await refreshItems();
  } catch (e) { toast(errMsg(e), 'error'); }
}

async function reloadConti() {
  try {
    S.conti = await api.conti.list(true);
    S.contiError = null;
  } catch (e) { S.contiError = errMsg(e); }
  if (S.tab === 'review') renderDetail();
}
