'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildStats, todayLocal, addMonths, monthStart } = require('./stats');

const STALE_MS = 10 * 60 * 1000;
const MONTHS_BACK = 24;

// Copia locale delle uscite lette da Notion, così la panoramica si apre subito.
class ExpenseService {
  constructor({ notion, file, now = () => Date.now(), today = () => todayLocal() }) {
    this.notion = notion;
    this.file = file;
    this.now = now;
    this.today = today;
    this.items = [];
    this.fetchedAt = 0;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw.items)) { this.items = raw.items; this.fetchedAt = raw.fetchedAt || 0; }
    } catch { /* nessuna copia */ }
  }

  markStale() { this.fetchedAt = 0; }

  async refresh(signal) {
    const from = addMonths(monthStart(this.today()), -MONTHS_BACK);
    const items = await this.notion.listExpenses(from, signal);
    this.items = items;
    this.fetchedAt = this.now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ fetchedAt: this.fetchedAt, items }));
  }

  view(opts) {
    return {
      stats: buildStats(this.items, { ...opts, today: this.today() }),
      fetchedAt: this.fetchedAt,
      stale: !this.fetchedAt || this.now() - this.fetchedAt > STALE_MS,
      hasCache: this.items.length > 0 || this.fetchedAt > 0,
    };
  }
}

module.exports = { ExpenseService };
