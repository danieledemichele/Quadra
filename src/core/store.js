'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Archivio locale in un solo file JSON (scrittura atomica). Per qualche centinaio di
// scontrini all'anno è più che sufficiente e non richiede moduli nativi da compilare.
class Store {
  constructor(file) {
    this.file = file;
    this.items = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw.items)) this.items = raw.items;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignora */ }
      }
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  all() { return this.items.map((i) => ({ ...i })); }

  get(id) { return this.items.find((i) => i.id === id) || null; }

  add(item) {
    const now = new Date().toISOString();
    const full = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, warnings: [], ...item };
    this.items.push(full);
    this._save();
    return full;
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) throw new Error('Scontrino non trovato');
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    this._save();
    return item;
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i >= 0) {
      this.items.splice(i, 1);
      this._save();
    }
  }

  findByHash(hash, excludeId) {
    if (!hash) return null;
    return this.items.find((i) => i.hash === hash && i.id !== excludeId && i.status !== 'discarded') || null;
  }

  findByDropboxId(dropboxId) {
    return this.items.find((i) => i.dropbox?.id === dropboxId) || null;
  }

  // Stesso negozio, stessa data, stesso importo (già confermato o in attesa).
  findLikeData(excludeId, d) {
    if (!d?.store || !d?.date || !(d?.amount > 0)) return null;
    return (
      this.items.find(
        (i) =>
          i.id !== excludeId &&
          (i.status === 'done' || i.status === 'pending') &&
          i.data?.store?.toLowerCase() === d.store.toLowerCase() &&
          i.data?.date === d.date &&
          Math.abs((i.data?.amount ?? -1) - d.amount) < 0.005
      ) || null
    );
  }
}

module.exports = { Store };
