'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');

const MIN_LEN = 8;
const MAX_LEN = 256;
const FREE_TRIES = 5; // tentativi sbagliati consecutivi prima del blocco temporaneo
const BASE_DELAY_S = 30;
const MAX_DELAY_S = 900;
const KEYLEN = 32;
const DEFAULT_PARAMS = { N: 1 << 15, r: 8, p: 1 };
const AUTOLOCK_CHOICES = [0, 1, 5, 15, 30, 60];

const scrypt = (pw, salt, { N, r, p }) => new Promise((resolve, reject) => {
  crypto.scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r }, (e, key) => (e ? reject(e) : resolve(key)));
});

// Password di accesso a Quadra. Salvata solo come hash scrypt (con sale casuale) in un file leggibile solo dall'utente.
// Protegge l'apertura dell'app; non sostituisce la cifratura del disco o il blocco dello schermo del sistema.
class AppLock extends EventEmitter {
  constructor({ file, now = Date.now, params = DEFAULT_PARAMS }) {
    super();
    this.file = file;
    this.now = now;
    this.params = params;
    this.data = this._read();
    this.locked = !!this.data?.hash; // all'avvio è bloccata se c'è una password
    this._chain = Promise.resolve();
  }

  _read() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && j.v === 1 && typeof j.hash === 'string' && typeof j.salt === 'string') return j;
    } catch { /* nessuna password */ }
    return null;
  }

  _write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.data = data;
  }

  // una verifica alla volta: i tentativi in parallelo non aggirano il limite
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  isSet() { return !!this.data?.hash; }
  isLocked() { return this.isSet() && this.locked; }

  status() {
    const until = this.data?.until || 0;
    return {
      enabled: this.isSet(),
      locked: this.isLocked(),
      retryInS: until > this.now() ? Math.ceil((until - this.now()) / 1000) : 0,
      autoLockMin: this.data?.autoLockMin ?? 15,
    };
  }

  async _check(pw) {
    if (typeof pw !== 'string' || pw.length === 0 || pw.length > MAX_LEN) return false;
    const d = this.data;
    const want = Buffer.from(d.hash, 'hex');
    const got = await scrypt(pw, Buffer.from(d.salt, 'hex'), d.params);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  // Controlla la password con limite ai tentativi. Lancia un errore chiaro se sbagliata o se si deve attendere.
  _verify(pw) {
    return this._serial(async () => {
      const d = this.data;
      if (!d) return true;
      const wait = (d.until || 0) - this.now();
      if (wait > 0) throw Object.assign(new Error(`Troppi tentativi: riprova tra ${Math.ceil(wait / 1000)} secondi.`), { retryInS: Math.ceil(wait / 1000) });
      if (await this._check(pw)) {
        if (d.fails || d.until) this._write({ ...d, fails: 0, until: 0 });
        return true;
      }
      const fails = (d.fails || 0) + 1;
      const delay = fails >= FREE_TRIES ? Math.min(MAX_DELAY_S, BASE_DELAY_S * 2 ** (fails - FREE_TRIES)) : 0;
      this._write({ ...d, fails, until: delay ? this.now() + delay * 1000 : 0 });
      throw Object.assign(new Error(delay ? `Password errata. Riprova tra ${delay} secondi.` : `Password errata (${FREE_TRIES - fails} tentativi prima del blocco temporaneo).`), { retryInS: delay });
    });
  }

  async unlock(pw) {
    await this._verify(pw);
    this.locked = false;
    this.emit('change', this.status());
    return this.status();
  }

  lock() {
    if (!this.isSet()) return this.status();
    this.locked = true;
    this.emit('change', this.status());
    return this.status();
  }

  async setPassword(newPw, currentPw) {
    if (this.isLocked()) throw new Error('Quadra è bloccata.');
    if (this.isSet()) await this._verify(currentPw);
    if (typeof newPw !== 'string' || newPw.length < MIN_LEN) throw new Error(`La password deve avere almeno ${MIN_LEN} caratteri.`);
    if (newPw.length > MAX_LEN) throw new Error(`La password può avere al massimo ${MAX_LEN} caratteri.`);
    if (/^\s|\s$/.test(newPw)) throw new Error('La password non può iniziare o finire con uno spazio.');
    const salt = crypto.randomBytes(16);
    const hash = (await scrypt(newPw, salt, this.params)).toString('hex');
    this._write({ v: 1, salt: salt.toString('hex'), hash, params: this.params, fails: 0, until: 0, autoLockMin: this.data?.autoLockMin ?? 15 });
    this.locked = false;
    this.emit('change', this.status());
    return this.status();
  }

  async removePassword(pw) {
    if (this.isLocked()) throw new Error('Quadra è bloccata.');
    if (!this.isSet()) return this.status();
    await this._verify(pw);
    fs.rmSync(this.file, { force: true });
    this.data = null;
    this.locked = false;
    this.emit('change', this.status());
    return this.status();
  }

  setAutoLock(min) {
    if (this.isLocked()) throw new Error('Quadra è bloccata.');
    if (!this.isSet()) throw new Error('Imposta prima una password.');
    if (!AUTOLOCK_CHOICES.includes(min)) throw new Error('Valore non valido.');
    this._write({ ...this.data, autoLockMin: min });
    return this.status();
  }
}

module.exports = { AppLock, MIN_LEN, MAX_LEN, AUTOLOCK_CHOICES };
