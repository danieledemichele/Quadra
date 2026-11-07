'use strict';
/* Panoramica: spese della settimana o del mese, con grafici e statistiche (dati da Notion). */

const eur0 = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const isoAddDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmtShort = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

function niceMax(v) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function gridLines(W, H, padL, padR, padT, padB, max) {
  const ih = H - padT - padB;
  return [0, 0.5, 1].flatMap((f) => {
    const y = padT + ih - f * ih;
    return [
      h('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: f === 0 ? 'axis' : 'grid' }),
      h('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' }, eur0.format(max * f)),
    ];
  });
}

/** data: [{ label, sub, value, title, dim, current }] */
function barChart(data, aria) {
  const W = 640, H = 210, padL = 52, padR = 8, padT = 18, padB = 34;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const iw = W - padL - padR, ih = H - padT - padB, bw = iw / data.length;
  const step = data.length > 16 ? Math.ceil(data.length / 12) : 1;
  const parts = gridLines(W, H, padL, padR, padT, padB, max);
  data.forEach((d, i) => {
    const bh = (d.value / max) * ih;
    const x = padL + i * bw + bw * 0.16;
    const w = bw * 0.68;
    const y = padT + ih - bh;
    parts.push(h('rect', { x: x.toFixed(1), y: (d.value > 0 ? y : padT + ih - 2).toFixed(1), width: w.toFixed(1), height: Math.max(d.value > 0 ? bh : 2, 2).toFixed(1), rx: Math.min(5, w / 2).toFixed(1),
      class: `cbar${d.dim ? ' dim' : ''}${d.current ? ' cur' : ''}${d.value === 0 ? ' zero' : ''}` }, h('title', {}, d.title)));
    if (data.length <= 9 && d.value > 0) parts.push(h('text', { x: (x + w / 2).toFixed(1), y: (y - 5).toFixed(1), 'text-anchor': 'middle', class: 'val' }, eur0.format(d.value)));
    if (i % step === 0) {
      parts.push(h('text', { x: (x + w / 2).toFixed(1), y: H - (d.sub ? 17 : 10), 'text-anchor': 'middle', class: 'lab' }, d.label));
      if (d.sub) parts.push(h('text', { x: (x + w / 2).toFixed(1), y: H - 5, 'text-anchor': 'middle', class: 'lab sub' }, d.sub));
    }
  });
  return h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria }, ...parts);
}

function lineChart(cur, prev, aria) {
  const W = 640, H = 210, padL = 52, padR = 8, padT = 18, padB = 28;
  const n = Math.max(cur.length, prev.length);
  const max = niceMax(Math.max(0, ...cur.filter((v) => v != null), ...prev));
  const iw = W - padL - padR, ih = H - padT - padB;
  const X = (i) => padL + (n > 1 ? (i / (n - 1)) * iw : 0);
  const Y = (v) => padT + ih - (v / max) * ih;
  const pts = (arr) => arr.map((v, i) => (v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  const parts = gridLines(W, H, padL, padR, padT, padB, max);
  [1, 8, 15, 22, 29].filter((d) => d <= n).forEach((d) => parts.push(h('text', { x: X(d - 1).toFixed(1), y: H - 8, 'text-anchor': 'middle', class: 'lab' }, String(d))));
  parts.push(h('polyline', { points: pts(prev), class: 'line prev' }));
  parts.push(h('polyline', { points: pts(cur), class: 'line cur' }));
  const last = cur.map((v, i) => [v, i]).filter(([v]) => v != null).pop();
  if (last) parts.push(h('circle', { cx: X(last[1]).toFixed(1), cy: Y(last[0]).toFixed(1), r: 4.5, class: 'dot' }));
  return h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria }, ...parts);
}

const dashOpts = () => ({ period: S.dash.period, anchor: S.dash.anchor || undefined, person: S.dash.person });

async function dashLoad() {
  const d = S.dash;
  d.loading = true;
  d.error = null;
  try {
    d.data = await api.stats.get(dashOpts());
    if (d.data.stale && !d.refreshing) dashRefresh();
  } catch (e) { d.error = errMsg(e); }
  d.loading = false;
  if (S.tab === 'dash') paintDash();
}

async function dashRefresh() {
  const d = S.dash;
  if (d.refreshing) return;
  d.refreshing = true;
  d.error = null;
  if (S.tab === 'dash') paintDash();
  try {
    d.data = await api.stats.refresh(dashOpts());
  } catch (e) { d.error = errMsg(e); }
  d.refreshing = false;
  if (S.tab === 'dash') paintDash();
}

function renderDashboard() {
  $('#view').replaceChildren(h('div', { class: 'dash', id: 'dash' }));
  paintDash();
  dashLoad();
}

function kpi(title, value, sub, chip) {
  return h('div', { class: 'kpi' }, h('div', { class: 'kpi-t', text: title }), h('div', { class: 'kpi-v', text: value }), h('div', { class: 'kpi-s' }, chip || null, sub ? h('span', { text: sub }) : null));
}

function barList(rows, max, fmtRight) {
  return h('div', { class: 'blist' }, rows.map((r) => {
    const fill = h('div', { class: 'blist-fill' });
    fill.style.width = `${Math.max(2, (r.value / max) * 100)}%`;
    return h('div', { class: 'blist-row' },
      h('div', { class: 'blist-top' }, h('span', { class: 'blist-name', text: r.name }), h('span', { class: 'blist-val', text: fmtRight(r) })),
      h('div', { class: 'blist-track' }, fill));
  }));
}

function paintDash() {
  const root = $('#dash');
  if (!root) return;
  const d = S.dash;
  const st = d.data?.stats;

  if (!S.settings?.notion?.apiKey) {
    root.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-art', 'aria-hidden': 'true' }), h('p', { class: 'empty-title', text: 'Collega Notion per vedere le spese' }),
      h('p', { class: 'muted', text: 'La panoramica legge le uscite dal tuo database Notion.' }), h('button', { class: 'btn primary', type: 'button', onclick: () => setTab('settings'), text: 'Apri Impostazioni' })));
    return;
  }
  if (!st) {
    root.replaceChildren(d.error
      ? h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: 'Non riesco a leggere le spese' }), h('p', { class: 'muted', text: d.error }), h('button', { class: 'btn primary', type: 'button', onclick: dashRefresh, text: 'Riprova' }))
      : h('div', { class: 'empty' }, h('p', { class: 'muted', text: 'Carico le spese da Notion…' })));
    return;
  }

  const wk = st.period === 'week';
  const cmpName = wk ? 'settimana scorsa' : 'mese scorso';
  const time = d.data.fetchedAt ? new Date(d.data.fetchedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;

  const toolbar = h('div', { class: 'dash-bar' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Periodo' },
      [['week', 'Settimana'], ['month', 'Mese']].map(([k, l]) => h('button', { type: 'button', class: `seg-btn ${d.period === k ? 'active' : ''}`, 'aria-pressed': String(d.period === k), onclick: () => { d.period = k; d.anchor = null; dashLoad(); } }, l))),
    h('div', { class: 'nav' },
      h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Periodo precedente', disabled: !!(st.minDate && st.range.from <= st.minDate), onclick: () => { d.anchor = isoAddDays(st.range.from, -1); dashLoad(); } }, '‹'),
      h('h2', { class: 'range', text: st.range.label }),
      h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Periodo successivo', disabled: st.range.to >= st.today, onclick: () => { d.anchor = isoAddDays(st.range.to, 1); dashLoad(); } }, '›'),
      st.range.isCurrent ? null : h('button', { class: 'btn small', type: 'button', onclick: () => { d.anchor = null; dashLoad(); } }, wk ? 'Questa settimana' : 'Questo mese')),
    h('div', { class: 'dash-right' },
      st.people.length > 1 ? h('select', { 'aria-label': 'Persona', value: d.person, onchange: (e) => { d.person = e.target.value; dashLoad(); } },
        h('option', { value: '', text: 'Tutti' }), st.people.map((p) => h('option', { value: p, text: p }))) : null,
      h('span', { class: 'muted small-t', text: d.refreshing ? 'Aggiorno da Notion…' : time ? `Aggiornato alle ${time}` : '' }),
      h('button', { class: 'btn small', type: 'button', disabled: d.refreshing, onclick: dashRefresh }, 'Aggiorna')));

  const errBar = d.error ? h('div', { class: 'banner err', role: 'alert' }, `Aggiornamento non riuscito: ${d.error}${d.data.hasCache ? ' — mostro i dati salvati.' : ''}`) : null;

  if (!st.hasAny && !d.refreshing) {
    root.replaceChildren(...[toolbar, errBar].filter(Boolean), h('div', { class: 'empty' }, h('div', { class: 'empty-art', 'aria-hidden': 'true' }), h('p', { class: 'empty-title', text: 'Ancora nessuna spesa' }),
      h('p', { class: 'muted', text: 'Non trovo uscite (importi negativi) nel database Notion negli ultimi due anni.' })));
    return;
  }

  const c = st.comparison;
  let chip = null;
  if (c.delta != null) {
    const pct = Math.round(c.delta * 100);
    const up = pct > 0;
    chip = pct === 0 ? h('span', { class: 'delta' }, '= invariato')
      : h('span', { class: `delta ${up ? 'up' : 'down'}`, title: 'Meno è meglio: una spesa che scende è verde' }, `${up ? '▲' : '▼'} ${Math.abs(pct)}%`);
  }
  const kpis = h('div', { class: 'kpis' },
    kpi('Speso', fmtMoney(st.total), c.delta != null ? `rispetto a ${cmpName}${c.partial ? ' (stesso punto)' : ''}` : c.prevTotal ? `${cmpName}: ${fmtMoney(c.prevTotal)}` : `nessun dato per ${cmpName}`, chip),
    kpi('Media al giorno', fmtMoney(st.avgPerDay), `su ${st.elapsedDays} ${st.elapsedDays === 1 ? 'giorno' : 'giorni'}`),
    kpi('Spese', String(st.count), st.count ? `${fmtMoney(st.total / st.count)} in media` : ''),
    kpi('La più alta', st.biggest ? fmtMoney(st.biggest.amount) : '—', st.biggest ? `${st.biggest.store || 'senza nome'} · ${fmtShort(st.biggest.date)}` : ''));

  const dailyData = st.daily.map((x) => ({ label: x.label, sub: x.sub, value: x.total, dim: x.future, current: x.date === st.today,
    title: `${fmtDate(x.date)} · ${fmtMoney(x.total)}` }));
  const cards = [
    h('section', { class: 'dcard wide' }, h('h3', { text: 'Spesa giornaliera' }), barChart(dailyData, `Spesa giornaliera, totale ${fmtMoney(st.total)}`)),
  ];
  if (!wk) {
    cards.push(h('section', { class: 'dcard wide' }, h('h3', { text: 'Ritmo del mese' }),
      h('div', { class: 'legend' }, h('span', { class: 'lg cur' }, 'Questo mese'), h('span', { class: 'lg prev' }, 'Mese scorso')),
      lineChart(st.cumulative, st.prevCumulative, `Spesa cumulata del mese, ${fmtMoney(st.total)} finora`)));
  }
  cards.push(h('section', { class: 'dcard' }, h('h3', { text: 'Per categoria' }),
    st.byCategory.length ? barList(st.byCategory.map((x) => ({ name: x.name, value: x.total, pct: x.pct })), st.byCategory[0].total, (r) => `${fmtMoney(r.value)} · ${Math.round(r.pct * 100)}%`) : h('p', { class: 'muted', text: 'Nessuna spesa nel periodo.' })));
  cards.push(h('section', { class: 'dcard' }, h('h3', { text: 'Dove hai speso di più' }),
    st.topStores.length ? barList(st.topStores.map((x) => ({ name: x.name, value: x.total, count: x.count })), st.topStores[0].total, (r) => `${fmtMoney(r.value)} · ${r.count}×`) : h('p', { class: 'muted', text: 'Nessuna spesa nel periodo.' })));
  const trend = wk ? st.weeks8 : st.months12;
  cards.push(h('section', { class: 'dcard wide' }, h('h3', { text: wk ? 'Ultime 8 settimane' : 'Ultimi 12 mesi' }),
    barChart(trend.map((x) => ({ label: x.label, value: x.total, current: x.current, title: `${x.label} · ${fmtMoney(x.total)}` })), wk ? 'Spesa delle ultime 8 settimane' : 'Spesa degli ultimi 12 mesi')));
  cards.push(h('section', { class: 'dcard wide' }, h('h3', { text: `Movimenti${st.recent.length ? ` (${st.count})` : ''}` }),
    st.recent.length ? h('div', { class: 'moves' }, st.recent.map((m) => h('div', { class: 'move' },
      h('span', { class: 'mono mv-d', text: fmtShort(m.date) }), h('span', { class: 'mv-s', text: m.store || '—' }),
      h('span', { class: 'badge', text: m.categoria }), h('span', { class: 'muted mv-p', text: m.people.join(', ') }), h('span', { class: 'mono mv-a', text: fmtMoney(m.spend) }))))
      : h('p', { class: 'muted', text: 'Nessuna spesa nel periodo.' })));

  root.replaceChildren(...[toolbar, errBar].filter(Boolean), kpis, h('div', { class: 'dgrid' }, cards));
}
