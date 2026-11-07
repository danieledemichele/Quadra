'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { withTimeout, abortError, shorten } = require('./util');

const API = 'https://api.github.com';
const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const PKG = 'quadra';

// Eseguito da root (tramite pkexec) su una COPIA del pacchetto in una cartella di root: così nessun
// altro processo dell'utente può sostituire il file tra la verifica e l'installazione.
const ROOT_SCRIPT = [
  'set -eu',
  'umask 077',
  'T=$(mktemp -d /var/tmp/quadra-update.XXXXXX)',
  "trap 'rm -rf \"$T\"' EXIT",
  'cp -- "$1" "$T/pkg.deb"',
  'echo "$2  $T/pkg.deb" | sha256sum -c --status',
  '[ "$(dpkg-deb -f "$T/pkg.deb" Package)" = "$4" ]',
  '[ "$(dpkg-deb -f "$T/pkg.deb" Version)" = "$3" ]',
  'chmod 0644 "$T/pkg.deb"; chmod 0755 "$T"',
  'DEBIAN_FRONTEND=noninteractive apt-get install -y "$T/pkg.deb"',
].join('\n');

const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' };

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

// Aggiornamento in un clic: legge l'ultima release su GitHub, scarica il .deb e lo installa con pkexec (finestra della password di sistema).
class Updater extends EventEmitter {
  constructor({ config, currentVersion, dir, fetch = globalThis.fetch, run, arch = process.arch, apiBase = API }) {
    super();
    this.config = config;
    this.current = currentVersion;
    this.dir = dir;
    this.fetch = fetch;
    this.run = run;
    this.arch = DEB_ARCH[arch] || 'amd64';
    this.api = apiBase;
    this.state = { phase: 'idle', current: currentVersion };
    this.info = null;
    this.busy = false;
  }

  _set(patch) {
    this.state = { current: this.current, ...patch };
    this.emit('state', this.state);
  }

  _headers(accept) {
    const { token } = this.config.get().update;
    return { Accept: accept, 'User-Agent': 'Quadra-updater', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  async _get(url, accept, signal, ms = 20000) {
    try {
      return await this.fetch(url, { headers: this._headers(accept), signal: withTimeout(signal, ms) });
    } catch (e) {
      if (signal?.aborted) throw abortError();
      throw new Error(`GitHub non raggiungibile: ${e.message}`);
    }
  }

  async check({ silent = false, signal } = {}) {
    if (this.busy) return this.state;
    if (!silent) this._set({ phase: 'checking' });
    const repo = this.config.get().update.repo;
    try {
      if (!REPO_RE.test(repo || '')) throw new Error('Repository degli aggiornamenti non valido: deve essere nel formato utente/nome.');
      const res = await this._get(`${this.api}/repos/${repo}/releases/latest`, 'application/vnd.github+json', signal);
      if (res.status === 404) throw new Error('Release non trovata. Se il repository è privato inserisci un token GitHub (permesso Contents: sola lettura) in Impostazioni → Aggiornamenti.');
      if (res.status === 401 || res.status === 403) throw new Error('GitHub ha rifiutato la richiesta: controlla il token (deve avere il permesso Contents: sola lettura) oppure riprova più tardi.');
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${shorten(await res.text(), 160)}`);
      const j = await res.json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('Release con numero di versione non valido.');
      const available = cmpVersion(latest, this.current) > 0;
      const asset = (j.assets || []).find((a) => new RegExp(`^${PKG}_[0-9][0-9A-Za-z.+~-]*_${this.arch}\\.deb$`).test(a.name));
      if (available && !asset) throw new Error(`La release ${latest} non contiene il pacchetto .deb per ${this.arch}.`);
      if (available && !/^sha256:[0-9a-f]{64}$/i.test(asset.digest || '')) throw new Error('GitHub non ha fornito la firma (sha256) del pacchetto: per sicurezza non lo installo.');
      this.info = { latest, available, notes: j.body || '', htmlUrl: j.html_url, asset: asset ? { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest || null } : null };
      this._set({ phase: available ? 'available' : 'none', latest, notes: this.info.notes, checkedAt: Date.now() });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      this.info = null;
      if (silent) this._set({ phase: 'idle' });
      else this._set({ phase: 'error', error: e.message });
    }
    return this.state;
  }

  async download(signal) {
    const a = this.info?.asset;
    if (!a) throw new Error('Nessun aggiornamento da scaricare: controlla prima gli aggiornamenti.');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, path.basename(a.name));
    const repo = this.config.get().update.repo;
    const res = await this._get(`${this.api}/repos/${repo}/releases/assets/${a.id}`, 'application/octet-stream', signal, 600000);
    if (!res.ok || !res.body) throw new Error(`Download non riuscito (GitHub ${res.status}).`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let got = 0;
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        this._set({ phase: 'downloading', latest: this.info.latest, progress: a.size ? Math.min(1, got / a.size) : 0 });
      }
      await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
    } catch (e) {
      out.destroy();
      fs.rmSync(file, { force: true });
      if (signal?.aborted) throw abortError();
      throw new Error(`Download interrotto: ${e.message}`);
    }
    if (a.size && got !== a.size) { fs.rmSync(file, { force: true }); throw new Error('File scaricato incompleto: riprova.'); }
    const want = /^sha256:([0-9a-f]{64})$/i.exec(a.digest || '')?.[1]?.toLowerCase();
    if (!want || want !== hash.digest('hex')) { fs.rmSync(file, { force: true }); throw new Error('Il file scaricato non corrisponde alla firma (sha256) pubblicata da GitHub: aggiornamento annullato.'); }
    return file;
  }

  async install(file) {
    const sha = /^sha256:([0-9a-f]{64})$/i.exec(this.info?.asset?.digest || '')?.[1]?.toLowerCase();
    if (!sha || !this.info?.latest) throw new Error('Mancano i dati di verifica del pacchetto: controlla di nuovo gli aggiornamenti.');
    this._set({ phase: 'installing', latest: this.info.latest });
    try {
      // La password di sistema la chiede pkexec/polkit in una finestra del sistema: Quadra non la vede mai.
      await this.run('pkexec', ['/bin/sh', '-c', ROOT_SCRIPT, 'quadra-update', file, sha, this.info.latest, PKG]);
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`pkexec non trovato. Installa a mano con: sudo apt install ${file}`);
      if (e.code === 126 || e.code === 127) throw new Error('Autorizzazione annullata: l\'aggiornamento non è stato installato.');
      throw new Error(`Installazione non riuscita: ${shorten(e.stderr || e.message, 240)}`);
    }
    fs.rmSync(file, { force: true });
  }

  // Scarica e installa l'ultima versione trovata da check().
  async update({ signal } = {}) {
    if (this.busy) throw new Error('Aggiornamento già in corso.');
    this.busy = true;
    try {
      const file = await this.download(signal);
      await this.install(file);
      this._set({ phase: 'installed', latest: this.info.latest });
    } catch (e) {
      this._set(e.name === 'AbortError' ? { phase: 'available', latest: this.info?.latest } : { phase: 'error', error: e.message, latest: this.info?.latest });
      throw e;
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Updater, cmpVersion, REPO_RE, ROOT_SCRIPT };
