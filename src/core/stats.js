'use strict';
/* Statistiche delle spese: funzioni pure (date in formato AAAA-MM-GG, calcoli in UTC per non dipendere dal fuso). */

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => iso(new Date(parse(s).getTime() + n * DAY));
const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / DAY);
const weekStart = (s) => addDays(s, -((parse(s).getUTCDay() + 6) % 7)); // lunedì
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const addMonths = (s, n) => {
  const d = parse(monthStart(s));
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d);
};
const daysInMonth = (s) => {
  const d = parse(monthStart(s));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
};

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const MON3 = MONTHS.map((m) => m.slice(0, 3));
const DOW = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
const round2 = (n) => Math.round(n * 100) / 100;

function todayLocal(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function rangeLabel(period, from, to) {
  const a = parse(from);
  const b = parse(to);
  if (period === 'month') return `${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  return sameMonth
    ? `${a.getUTCDate()} – ${b.getUTCDate()} ${MON3[b.getUTCMonth()]} ${b.getUTCFullYear()}`
    : `${a.getUTCDate()} ${MON3[a.getUTCMonth()]} – ${b.getUTCDate()} ${MON3[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

const NO_CAT = 'Senza categoria';
const catName = (c) => (!c || /^[—–-]+$/.test(String(c).trim()) ? NO_CAT : String(c).trim());

function group(list, keyFn, labelFn) {
  const m = new Map();
  for (const e of list) {
    const k = keyFn(e);
    const g = m.get(k) || { name: labelFn(e), total: 0, count: 0 };
    g.total += e.spend;
    g.count += 1;
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ ...g, total: round2(g.total) })).sort((a, b) => b.total - a.total);
}

/**
 * expenses: [{ id, date, store, amount, categoria, people[] }] (importo negativo = spesa)
 * opts: { period: 'week'|'month', anchor, person, today }
 */
function buildStats(expenses, opts = {}) {
  const today = opts.today || todayLocal();
  const period = opts.period === 'month' ? 'month' : 'week';
  const anchor = opts.anchor || today;
  const person = opts.person || '';

  const all = expenses.filter((e) => e.amount < 0).map((e) => ({ ...e, spend: -e.amount }));
  const people = [...new Set(all.flatMap((e) => e.people || []))].sort();
  const list = person ? all.filter((e) => (e.people || []).includes(person)) : all;
  const minDate = list.reduce((m, e) => (!m || e.date < m ? e.date : m), null);

  const rangeOf = (a) => {
    if (period === 'month') {
      const from = monthStart(a);
      return { from, to: addDays(from, daysInMonth(from) - 1) };
    }
    const from = weekStart(a);
    return { from, to: addDays(from, 6) };
  };
  const range = rangeOf(anchor);
  const prevRange = period === 'month' ? rangeOf(addMonths(range.from, -1)) : rangeOf(addDays(range.from, -7));
  const inRange = (r) => list.filter((e) => e.date >= r.from && e.date <= r.to);
  const sum = (xs) => round2(xs.reduce((s, e) => s + e.spend, 0));

  const items = inRange(range);
  const prevItems = inRange(prevRange);
  const total = sum(items);
  const prevTotal = sum(prevItems);

  const lastDay = range.to < today ? range.to : today;
  const elapsed = Math.max(0, Math.min(diffDays(lastDay, range.from) + 1, diffDays(range.to, range.from) + 1));
  const partial = range.to >= today && range.from <= today;
  const prevToDate = partial ? sum(prevItems.filter((e) => diffDays(e.date, prevRange.from) < elapsed)) : prevTotal;
  const delta = prevToDate > 0 ? round2((total - prevToDate) / prevToDate) : null;

  const nDays = diffDays(range.to, range.from) + 1;
  const byDate = new Map();
  for (const e of items) byDate.set(e.date, (byDate.get(e.date) || 0) + e.spend);
  const daily = [];
  for (let i = 0; i < nDays; i++) {
    const date = addDays(range.from, i);
    const d = parse(date);
    daily.push({
      date,
      label: period === 'week' ? DOW[i] : String(d.getUTCDate()),
      sub: period === 'week' ? String(d.getUTCDate()) : '',
      total: round2(byDate.get(date) || 0),
      future: date > today,
    });
  }

  let run = 0;
  const cumulative = daily.map((d) => (d.future ? null : (run = round2(run + d.total))));
  const prevByDate = new Map();
  for (const e of prevItems) prevByDate.set(e.date, (prevByDate.get(e.date) || 0) + e.spend);
  let prun = 0;
  const prevCumulative = [];
  for (let i = 0; i <= diffDays(prevRange.to, prevRange.from); i++) {
    prun = round2(prun + (prevByDate.get(addDays(prevRange.from, i)) || 0));
    prevCumulative.push(prun);
  }

  const biggestE = items.reduce((m, e) => (!m || e.spend > m.spend ? e : m), null);

  const months12 = [];
  const curMonth = monthStart(anchor);
  for (let i = 11; i >= 0; i--) {
    const f = addMonths(curMonth, -i);
    const t = addDays(f, daysInMonth(f) - 1);
    months12.push({ key: f.slice(0, 7), label: MON3[parse(f).getUTCMonth()], total: sum(list.filter((e) => e.date >= f && e.date <= t)), current: i === 0 });
  }
  const weeks8 = [];
  const curWeek = weekStart(anchor);
  for (let i = 7; i >= 0; i--) {
    const f = addDays(curWeek, -7 * i);
    const t = addDays(f, 6);
    const d = parse(f);
    weeks8.push({ key: f, label: `${d.getUTCDate()} ${MON3[d.getUTCMonth()]}`, total: sum(list.filter((e) => e.date >= f && e.date <= t)), current: i === 0 });
  }

  return {
    period,
    range: { ...range, label: rangeLabel(period, range.from, range.to), isCurrent: partial },
    today,
    minDate,
    people,
    hasAny: list.length > 0,
    total,
    count: items.length,
    avgPerDay: elapsed > 0 ? round2(total / elapsed) : 0,
    elapsedDays: elapsed,
    comparison: { prevTotal, prevToDate, delta, partial },
    daily,
    cumulative: period === 'month' ? cumulative : null,
    prevCumulative: period === 'month' ? prevCumulative : null,
    byCategory: group(items, (e) => catName(e.categoria).toLowerCase(), (e) => catName(e.categoria)).map((g) => ({ ...g, pct: total > 0 ? g.total / total : 0 })),
    topStores: group(items, (e) => (e.store || '—').trim().toLowerCase(), (e) => (e.store || '—').trim()).slice(0, 6),
    biggest: biggestE ? { date: biggestE.date, store: biggestE.store, amount: round2(biggestE.spend) } : null,
    recent: [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.spend - a.spend)).slice(0, 40)
      .map((e) => ({ id: e.id, date: e.date, store: e.store, spend: round2(e.spend), categoria: catName(e.categoria), people: e.people || [] })),
    months12,
    weeks8,
  };
}

module.exports = { buildStats, todayLocal, addDays, addMonths, monthStart, weekStart };
