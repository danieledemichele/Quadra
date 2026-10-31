'use strict';
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { sha256, toIsoDate, toNumberLoose, isAbort } = require('./util');
const { normalizeStoreName, matchKnownStore } = require('./normalize');
const { IMG_EXT } = require('./dropbox');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CONTI_TTL = 10 * 60 * 1000;

class Pipeline extends EventEmitter {
  constructor({ config, store, dropbox, notion, extractor, prepareImage, cacheDir }) {
    super();
    this.config = config;
    this.store = store;
    this.dropbox = dropbox;
    this.notion = notion;
    this.extractor = extractor;
    this.prepareImage = prepareImage;
    this.cacheDir = cacheDir;
    this.busy = new Set();
    this.conti = null;
    this.contiAt = 0;
  }

  // ---------- utilità interne ----------

  _patch(id, patch) {
    const item = this.store.update(id, patch);
    this.emit('item', { ...item });
    return item;
  }

  _warnings(item) {
    const cfg = this.config.get();
    const d = item.data || {};
    const w = [];
    if (!d.store) w.push({ level: 'warn', text: 'Negozio non letto' });
    if (!d.date) w.push({ level: 'warn', text: 'Data non letta' });
    if (!(d.amount > 0)) w.push({ level: 'warn', text: 'Importo non letto' });
    if (d.date) {
      const days = (Date.now() - Date.parse(`${d.date}T00:00:00Z`)) / 86400000;
      if (days < -1) w.push({ level: 'warn', text: 'La data è nel futuro' });
      else if (days > 120) w.push({ level: 'warn', text: 'Data di oltre 4 mesi fa: controlla l\'anno' });
    }
    if (d.amount > 500) w.push({ level: 'warn', text: 'Importo insolitamente alto' });
    if (d.store && !matchKnownStore(d.store, cfg.knownStores)) {
      w.push({ level: 'info', text: 'Negozio fuori lista: la Categoria in Notion potrebbe restare vuota' });
    }
    const dup = this.store.findLikeData(item.id, d);
    if (dup) w.push({ level: 'warn', text: `Sembra già presente (stesso negozio, data e importo): ${dup.fileName}` });
    return w;
  }

  _applyData(item, data) {
    const store = String(data?.store ?? '').replace(/\s+/g, ' ').trim();
    const date = data?.date ? toIsoDate(String(data.date)) : null;
    const n = toNumberLoose(data?.amount);
    const amount = Number.isFinite(n) && n !== 0 ? Math.round(Math.abs(n) * 100) / 100 : null;
    item.data = { store, date, amount };
  }

  _cachePath(hash) { return path.join(this.cacheDir, `${hash}.jpg`); }

  async _extractInto(id, jpeg, signal) {
    const cfg = this.config.get();
    const res = await this.extractor.extract(jpeg, {
      signal,
      onQuota: (q) => this.emit('quota', q),
      onStatus: (s) => this.emit('status', { id, ...s }),
    });
    const store = normalizeStoreName(res.store, { knownStores: cfg.knownStores, aliases: cfg.aliases });
    const item = this.store.get(id);
    item.data = { store, date: res.date, amount: res.amount };
    const warnings = this._warnings(item);
    return this._patch(id, {
      extracted: { store: res.store, date: res.date, amount: res.amount, model: res.model, provider: res.provider },
      autoStore: store,
      data: item.data,
      warnings,
      status: 'pending',
      error: null,
    });
  }

  async _ingest(item, buf, signal) {
    const hash = sha256(buf);
    const dup = this.store.findByHash(hash, item.id);
    if (dup) {
      return this._patch(item.id, {
        hash,
        status: 'discarded',
        duplicateOf: dup.id,
        warnings: [{ level: 'info', text: `Stessa foto già presente: ${dup.fileName}` }],
      });
    }
    this._patch(item.id, { hash });
    const jpeg = await this.prepareImage(buf, this.config.get().maxMegapixels);
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(this._cachePath(hash), jpeg);
    return this._extractInto(item.id, jpeg, signal);
  }

  _personFolder(item) {
    const p = this.config.get().people.find((x) => x.name === item.person);
    if (p) return p.folder;
    return path.posix.dirname(item.dropbox.path);
  }

  async _moveBestEffort(item, sub, signal) {
    if (!item.dropbox || item.dropbox.moved) return item;
    try {
      const to = await this.dropbox.moveToSub({ id: item.dropbox.id, name: item.fileName }, this._personFolder(item), sub, signal);
      return this._patch(item.id, { dropbox: { ...item.dropbox, moved: true, movedTo: to } });
    } catch (e) {
      if (isAbort(e)) throw e;
      const warnings = [...(item.warnings || []), { level: 'warn', text: `File non spostato in ${sub}: ${e.message}` }];
      return this._patch(item.id, { warnings });
    }
  }

  // ---------- avvio ----------

  recover() {
    for (const i of this.store.all()) {
      if (i.status === 'processing') this.store.update(i.id, { status: 'error', error: 'Interrotto da una chiusura improvvisa.' });
    }
  }

  list() {
    return this.store.all().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // ---------- acquisizione ----------

  async scanDropbox({ signal } = {}) {
    const cfg = this.config.get();
    const summary = { found: 0, added: 0, duplicates: 0, errors: 0, stopped: null, remaining: 0, missingFolders: [], lastError: null };
    this.emit('progress', { phase: 'list' });
    const queue = [];
    for (const person of cfg.people) {
      let files;
      try {
        files = await this.dropbox.listImages(person.folder, signal);
      } catch (e) {
        if (isAbort(e) || !/Cartella Dropbox non trovata/.test(e.message)) throw e;
        summary.missingFolders.push(person.folder);
        continue;
      }
      summary.found += files.length;
      for (const file of files) {
        const known = this.store.findByDropboxId(file.id);
        if (known && known.status !== 'error') continue;
        queue.push({ person, file, known });
      }
    }
    const total = queue.length;
    let failStreak = 0;

    for (let i = 0; i < total; i++) {
      const { person, file, known } = queue[i];
      this.emit('progress', { phase: 'item', done: i, total, current: file.name, person: person.name });
      const item = known
        ? this._patch(known.id, { status: 'processing', error: null })
        : (() => {
            const created = this.store.add({
              source: 'dropbox',
              person: person.name,
              fileName: file.name,
              dropbox: { id: file.id, path: file.path },
              status: 'processing',
              data: { store: '', date: null, amount: null },
            });
            this.emit('item', { ...created });
            return created;
          })();
      try {
        const buf = await this.dropbox.download(file.id, signal);
        const out = await this._ingest(item, buf, signal);
        if (out.status === 'discarded') {
          summary.duplicates++;
          await this._moveBestEffort(out, 'Scartati', signal);
        } else {
          summary.added++;
        }
        failStreak = 0;
      } catch (e) {
        if (isAbort(e)) {
          if (known) this._patch(item.id, { status: 'error', error: 'Interrotto.' });
          else {
            this.store.remove(item.id);
            this.emit('removed', item.id);
          }
          throw e;
        }
        this._patch(item.id, { status: 'error', error: e.message });
        summary.errors++;
        summary.lastError = e.message;
        if (e.kind === 'all-failed') failStreak++;
        if (failStreak >= 2 || /chiave API/i.test(e.message)) {
          summary.stopped = 'models';
          summary.remaining = total - i - 1;
          break;
        }
      }
    }
    this.emit('progress', { phase: 'end', total, summary });
    return summary;
  }

  async importLocal(files, person, { signal } = {}) {
    const cfg = this.config.get();
    if (!cfg.people.some((p) => p.name === person)) throw new Error('Scegli per chi sono questi scontrini.');
    const summary = { found: files.length, added: 0, duplicates: 0, errors: 0, stopped: null, remaining: 0, lastError: null };
    let failStreak = 0;
    for (let i = 0; i < files.length; i++) {
      const fp = files[i];
      const name = path.basename(fp);
      this.emit('progress', { phase: 'item', done: i, total: files.length, current: name, person });
      if (!IMG_EXT.test(name)) {
        summary.errors++;
        const bad = this.store.add({ source: 'local', person, fileName: name, localPath: fp, status: 'error', error: 'Formato non supportato (usa JPG, PNG o WebP).', data: { store: '', date: null, amount: null } });
        this.emit('item', { ...bad });
        continue;
      }
      const item = this.store.add({ source: 'local', person, fileName: name, localPath: fp, status: 'processing', data: { store: '', date: null, amount: null } });
      this.emit('item', { ...item });
      try {
        const st = fs.statSync(fp);
        if (st.size > MAX_FILE_BYTES) throw new Error('File troppo grande (oltre 25 MB).');
        const out = await this._ingest(item, fs.readFileSync(fp), signal);
        if (out.status === 'discarded') summary.duplicates++;
        else summary.added++;
        failStreak = 0;
      } catch (e) {
        if (isAbort(e)) {
          this.store.remove(item.id);
          this.emit('removed', item.id);
          throw e;
        }
        this._patch(item.id, { status: 'error', error: e.message });
        summary.errors++;
        summary.lastError = e.message;
        if (e.kind === 'all-failed') failStreak++;
        if (failStreak >= 2 || /chiave API/i.test(e.message)) {
          summary.stopped = 'models';
          summary.remaining = files.length - i - 1;
          break;
        }
      }
    }
    this.emit('progress', { phase: 'end', total: files.length, summary });
    return summary;
  }

  async imageFor(id, signal) {
    const item = this.store.get(id);
    if (!item) return null;
    if (item.hash && fs.existsSync(this._cachePath(item.hash))) return fs.readFileSync(this._cachePath(item.hash));
    return null;
  }

  async reextract(id, signal) {
    const item = this.store.get(id);
    if (!item) throw new Error('Scontrino non trovato.');
    if (!['pending', 'error'].includes(item.status)) throw new Error('Questo scontrino non è più modificabile.');
    if (this.busy.has(id)) throw new Error('Operazione già in corso.');
    this.busy.add(id);
    try {
      this._patch(id, { status: 'processing', error: null });
      let jpeg = await this.imageFor(id);
      if (!jpeg) {
        const raw = item.dropbox ? await this.dropbox.download(item.dropbox.id, signal)
          : item.localPath ? fs.readFileSync(item.localPath) : null;
        if (!raw) throw new Error('Immagine non più disponibile.');
        jpeg = await this.prepareImage(raw, this.config.get().maxMegapixels);
        if (item.hash) {
          fs.mkdirSync(this.cacheDir, { recursive: true });
          fs.writeFileSync(this._cachePath(item.hash), jpeg);
        }
      }
      return await this._extractInto(id, jpeg, signal);
    } catch (e) {
      this._patch(id, { status: isAbort(e) ? 'pending' : 'error', error: isAbort(e) ? null : e.message });
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }

  // ---------- revisione ----------

  async listConti(refresh = false) {
    if (!refresh && this.conti && Date.now() - this.contiAt < CONTI_TTL) return this.conti;
    this.conti = await this.notion.listConti();
    this.contiAt = Date.now();
    return this.conti;
  }

  updateEdits(id, data, contoId) {
    const item = this.store.get(id);
    if (!item) throw new Error('Scontrino non trovato.');
    if (!['pending', 'error'].includes(item.status)) throw new Error('Questo scontrino non è più modificabile.');
    const copy = { ...item };
    if (data) this._applyData(copy, data);
    const patch = { data: copy.data };
    if (contoId !== undefined) {
      patch.contoId = contoId || null;
      patch.contoName = (this.conti || []).find((c) => c.id === contoId)?.name || null;
    }
    copy.data = copy.data || item.data;
    patch.warnings = this._warnings({ ...copy, id });
    return this._patch(id, patch);
  }

  async confirm(id, { data, contoId } = {}, signal) {
    const item0 = this.store.get(id);
    if (!item0) throw new Error('Scontrino non trovato.');
    if (!['pending', 'error'].includes(item0.status)) throw new Error('Questo scontrino è già stato elaborato.');
    if (this.busy.has(id)) throw new Error('Operazione già in corso.');
    this.busy.add(id);
    try {
      if (data || contoId !== undefined) this.updateEdits(id, data, contoId);
      const item = this.store.get(id);
      const d = item.data || {};
      if (!d.store) throw new Error('Manca il nome del negozio.');
      if (!d.date) throw new Error('Manca una data valida.');
      if (!(d.amount > 0)) throw new Error('Manca l\'importo.');

      const res = await this.notion.createExpense(
        { store: d.store, date: d.date, amount: d.amount, person: item.person, contoId: item.contoId },
        signal,
      );

      const raw = item.extracted?.store?.trim().toLowerCase();
      if (raw && item.autoStore && d.store !== item.autoStore && raw !== d.store.toLowerCase()) {
        this.config.addAlias(raw, d.store);
      }

      const warnings = (res.warnings || []).map((text) => ({ level: 'warn', text }));
      const done = this._patch(id, {
        status: 'done',
        error: null,
        confirmedAt: new Date().toISOString(),
        notion: { pageId: res.pageId, url: res.url, categoria: res.categoria, tipo: res.tipo },
        warnings,
      });
      await this._moveBestEffort(done, 'Elaborati', signal);
      return this.store.get(id);
    } finally {
      this.busy.delete(id);
    }
  }

  async confirmMany(ids, signal) {
    const results = [];
    for (const id of ids) {
      try {
        await this.confirm(id, {}, signal);
        results.push({ id, ok: true });
      } catch (e) {
        if (isAbort(e)) throw e;
        results.push({ id, ok: false, error: e.message });
      }
    }
    return results;
  }

  async discard(id, signal) {
    const item = this.store.get(id);
    if (!item) throw new Error('Scontrino non trovato.');
    if (item.status === 'done') throw new Error('Già inserito in Notion: eliminalo da Notion se serve.');
    if (this.busy.has(id)) throw new Error('Operazione in corso.');
    const out = this._patch(id, { status: 'discarded', error: null });
    await this._moveBestEffort(out, 'Scartati', signal);
    return this.store.get(id);
  }
}

module.exports = { Pipeline };
