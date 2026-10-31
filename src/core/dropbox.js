'use strict';
const { withTimeout, abortError, shorten } = require('./util');

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const SKIP_DIRS = new Set(['elaborati', 'scartati']);
const DEFAULT_ENDPOINTS = { api: 'https://api.dropboxapi.com', content: 'https://content.dropboxapi.com' };

// L'header Dropbox-API-Arg deve essere ASCII puro.
const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

class Dropbox {
  constructor({ config, fetch = globalThis.fetch, endpoints = DEFAULT_ENDPOINTS }) {
    this.config = config;
    this.fetch = fetch;
    this.ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this.token = null;
    this.tokenExp = 0;
    config.onChange?.(() => { this.token = null; });
  }

  authUrl() {
    const { appKey } = this.config.get().dropbox;
    if (!appKey) throw new Error('Inserisci prima la App key di Dropbox.');
    return `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(appKey)}&response_type=code&token_access_type=offline`;
  }

  async _fetch(url, init, signal) {
    try {
      return await this.fetch(url, { ...init, signal: withTimeout(signal, 60000) });
    } catch (e) {
      if (signal?.aborted) throw abortError();
      throw new Error(`Dropbox non raggiungibile: ${e.message}`);
    }
  }

  async _oauth(params, signal) {
    const { appKey, appSecret } = this.config.get().dropbox;
    if (!appKey || !appSecret) throw new Error('App key e App secret di Dropbox sono obbligatorie.');
    const res = await this._fetch(`${this.ep.api}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: appKey, client_secret: appSecret }).toString(),
    }, signal);
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* ignora */ }
    if (!res.ok) {
      const why = json.error_description || json.error || shorten(text);
      throw new Error(json.error === 'invalid_grant'
        ? 'Codice o token Dropbox non valido o scaduto: rifai il collegamento in Impostazioni.'
        : `Dropbox (autorizzazione): ${why}`);
    }
    return json;
  }

  async exchangeCode(code, signal) {
    const json = await this._oauth({ grant_type: 'authorization_code', code: String(code || '').trim() }, signal);
    if (!json.refresh_token) throw new Error('Dropbox non ha restituito un refresh token (serve token_access_type=offline).');
    this.config.setDropboxRefreshToken(json.refresh_token);
    this.token = json.access_token;
    this.tokenExp = Date.now() + (json.expires_in || 14400) * 1000;
    return true;
  }

  async accessToken(signal, force = false) {
    if (!force && this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const rt = this.config.get().dropbox.refreshToken;
    if (!rt) throw new Error('Dropbox non è collegato: completa il collegamento in Impostazioni.');
    const json = await this._oauth({ grant_type: 'refresh_token', refresh_token: rt }, signal);
    this.token = json.access_token;
    this.tokenExp = Date.now() + (json.expires_in || 14400) * 1000;
    return this.token;
  }

  async _call(kind, path, { body, arg, signal }, retried = false) {
    const token = await this.accessToken(signal);
    const headers = { Authorization: `Bearer ${token}` };
    const init = { method: 'POST', headers };
    if (kind === 'api') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? null);
    } else {
      headers['Dropbox-API-Arg'] = asciiJson(arg);
    }
    const res = await this._fetch(`${this.ep[kind]}${path}`, init, signal);
    if (res.status === 401 && !retried) {
      this.token = null;
      await this.accessToken(signal, true);
      return this._call(kind, path, { body, arg, signal }, true);
    }
    if (!res.ok) {
      const text = await res.text();
      let summary = shorten(text);
      try { summary = JSON.parse(text).error_summary || summary; } catch { /* ignora */ }
      const e = new Error(`Dropbox ${res.status}: ${summary}`);
      e.status = res.status;
      e.summary = summary;
      throw e;
    }
    return res;
  }

  async test(signal) {
    const res = await this._call('api', '/2/users/get_current_account', { body: null, signal });
    const j = await res.json();
    return { name: j.name?.display_name || '', email: j.email || '' };
  }

  async listImages(folder, signal) {
    const out = [];
    let res;
    try {
      res = await this._call('api', '/2/files/list_folder', { body: { path: folder, recursive: true, limit: 2000 }, signal });
    } catch (e) {
      if (/not_found/.test(e.summary || '')) throw new Error(`Cartella Dropbox non trovata: ${folder}`);
      throw e;
    }
    let j = await res.json();
    for (;;) {
      for (const en of j.entries) {
        if (en['.tag'] !== 'file' || !IMG_EXT.test(en.name)) continue;
        const parts = (en.path_lower || '').split('/').slice(0, -1);
        if (parts.some((p) => SKIP_DIRS.has(p))) continue;
        out.push({ id: en.id, name: en.name, path: en.path_display, size: en.size, modified: en.server_modified });
      }
      if (!j.has_more) break;
      res = await this._call('api', '/2/files/list_folder/continue', { body: { cursor: j.cursor }, signal });
      j = await res.json();
    }
    return out;
  }

  async download(id, signal) {
    const res = await this._call('content', '/2/files/download', { arg: { path: id }, signal });
    return Buffer.from(await res.arrayBuffer());
  }

  // sub = 'Elaborati' | 'Scartati'; il nome si adatta se esiste già un file uguale.
  async moveToSub(file, personFolder, sub, signal) {
    const to = `${personFolder.replace(/\/+$/, '')}/${sub}/${file.name}`;
    const res = await this._call('api', '/2/files/move_v2', {
      body: { from_path: file.id, to_path: to, autorename: true },
      signal,
    });
    const j = await res.json();
    return j.metadata?.path_display || to;
  }
}

module.exports = { Dropbox, IMG_EXT };
