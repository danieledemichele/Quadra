'use strict';
/* Storico: scontrini già inseriti o scartati. */

function renderHistory() {
  const view = $('#view');
  const all = [...S.items.values()].filter((i) => ['done', 'discarded'].includes(i.status));
  const q = S.hist.q.trim().toLowerCase();
  const rows = all
    .filter((i) => (S.hist.status === 'all' ? true : i.status === S.hist.status))
    .filter((i) => !q || `${i.data?.store || ''} ${i.fileName} ${i.person} ${i.notion?.categoria || ''}`.toLowerCase().includes(q))
    .sort((a, b) => ((b.confirmedAt || b.updatedAt) > (a.confirmedAt || a.updatedAt) ? 1 : -1));
  const total = rows.filter((i) => i.status === 'done').reduce((s, i) => s + (i.data?.amount || 0), 0);

  const bar = h('div', { class: 'toolbar' },
    h('input', { type: 'search', placeholder: 'Cerca negozio, persona, categoria…', value: S.hist.q, 'aria-label': 'Cerca', oninput: (e) => { S.hist.q = e.target.value; renderHistoryBody(); } }),
    h('select', { 'aria-label': 'Stato', value: S.hist.status, onchange: (e) => { S.hist.status = e.target.value; renderHistory(); } },
      h('option', { value: 'done', text: 'Inseriti in Notion' }), h('option', { value: 'discarded', text: 'Scartati' }), h('option', { value: 'all', text: 'Tutti' })),
    h('span', { class: 'muted', id: 'hist-sum' }));
  view.replaceChildren(h('div', { class: 'history' }, bar, h('div', { id: 'hist-body', class: 'table-wrap' })));
  renderHistoryBody();
}

function renderHistoryBody() {
  const body = $('#hist-body');
  if (!body) return;
  const q = S.hist.q.trim().toLowerCase();
  const rows = [...S.items.values()]
    .filter((i) => ['done', 'discarded'].includes(i.status))
    .filter((i) => (S.hist.status === 'all' ? true : i.status === S.hist.status))
    .filter((i) => !q || `${i.data?.store || ''} ${i.fileName} ${i.person} ${i.notion?.categoria || ''}`.toLowerCase().includes(q))
    .sort((a, b) => ((b.confirmedAt || b.updatedAt) > (a.confirmedAt || a.updatedAt) ? 1 : -1));
  const total = rows.filter((i) => i.status === 'done').reduce((s, i) => s + (i.data?.amount || 0), 0);
  const sum = $('#hist-sum');
  if (sum) sum.textContent = `${rows.length} voci${S.hist.status !== 'discarded' ? ` · totale ${fmtMoney(total)}` : ''}`;
  if (!rows.length) {
    body.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'muted', text: 'Nessuna voce.' })));
    return;
  }
  body.replaceChildren(h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ['Data', 'Negozio', 'Importo', 'Persona', 'Categoria', 'Stato', ''].map((t) => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, rows.map((i) => h('tr', { class: i.status },
      h('td', { class: 'mono', text: fmtDate(i.data?.date) }),
      h('td', { text: i.data?.store || i.fileName }),
      h('td', { class: 'mono num', text: fmtMoney(i.data?.amount) }),
      h('td', { text: i.person }),
      h('td', { text: i.notion?.categoria || '—' }),
      h('td', {}, i.status === 'done' ? badge('in Notion', 'ok') : badge('scartato', '')),
      h('td', {}, i.notion?.url ? h('button', { class: 'link', type: 'button', onclick: () => api.items.openNotion(i.id).catch((e) => toast(errMsg(e), 'error')) }, 'Apri') : null))))));
}
