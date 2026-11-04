'use strict';
/* Impostazioni: lavorano su una bozza (S.draft) che si salva con il pulsante "Salva". */

let presets = [];
let settingsDirty = false;

const markDirty = () => {
  settingsDirty = true;
  const b = $('#btn-save');
  if (b) { b.disabled = false; b.textContent = 'Salva modifiche'; }
};

async function saveDraft() {
  S.settings = await api.settings.save(S.draft);
  S.draft = clone(S.settings);
  settingsDirty = false;
  const b = $('#btn-save');
  if (b) { b.disabled = true; b.textContent = 'Salvato'; }
  return S.settings;
}

async function ensureSaved() {
  if (settingsDirty) await saveDraft();
}

// Campo segreto: se resta vuoto si conserva il valore già salvato.
function secretInput(obj, key, placeholder) {
  const original = obj[key];
  const saved = original === KEEP;
  return h('input', {
    type: 'password', autocomplete: 'off', spellcheck: false, value: saved ? '' : original || '',
    placeholder: saved ? '•••••••• (salvata)' : placeholder || '',
    oninput: (e) => { obj[key] = e.target.value || (saved ? KEEP : ''); markDirty(); },
  });
}

function textInput(obj, key, opts = {}) {
  return h('input', {
    type: opts.type || 'text', value: obj[key] ?? '', placeholder: opts.placeholder || '', spellcheck: false, list: opts.list,
    min: opts.min, max: opts.max, step: opts.step,
    oninput: (e) => { obj[key] = opts.number ? parseFloat(e.target.value) : e.target.value; markDirty(); },
  });
}

const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null);

function section(title, desc, ...kids) {
  return h('section', { class: 'card' }, h('h2', { text: title }), desc ? h('p', { class: 'muted', text: desc }) : null, ...kids);
}

async function runTest(btn, fn, fmt) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Provo…';
  try {
    await ensureSaved();
    const r = await fn();
    toast(fmt ? fmt(r) : 'OK', 'ok');
  } catch (e) { toast(errMsg(e), 'error'); }
  btn.disabled = false;
  btn.textContent = label;
}

function dropboxCard() {
  const d = S.draft.dropbox;
  const code = h('input', { type: 'text', placeholder: 'Incolla qui il codice di Dropbox', autocomplete: 'off', spellcheck: false });
  const connected = d.refreshToken === KEEP;
  return section('Dropbox', 'Da qui l\'app legge le foto nelle cartelle delle persone e poi le sposta in Elaborati o Scartati.',
    h('div', { class: 'status-line' }, badge(connected ? 'collegato' : 'non collegato', connected ? 'ok' : 'warn')),
    h('div', { class: 'grid2' }, field('App key', textInput(d, 'appKey')), field('App secret', secretInput(d, 'appSecret'))),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try { await ensureSaved(); await api.settings.dropboxAuthUrl(); toast('Ho aperto Dropbox nel browser: autorizza e copia il codice.', 'ok'); } catch (err) { toast(errMsg(err), 'error'); }
        b.disabled = false;
      } }, '1. Apri Dropbox e autorizza'),
      code,
      h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try { await api.settings.dropboxExchange(code.value.trim()); await loadSettings(); toast('Dropbox collegato.', 'ok'); renderSettings(); } catch (err) { toast(errMsg(err), 'error'); b.disabled = false; }
      } }, '2. Collega'),
      h('button', { class: 'btn ghost', type: 'button', onclick: (e) => runTest(e.currentTarget, () => api.settings.testDropbox(), (r) => `Dropbox OK · ${r.name || r.email}`) }, 'Prova')),
    h('p', { class: 'hint', text: 'Il codice dura pochi minuti: incollalo subito dopo averlo copiato.' }));
}

function notionCard() {
  const n = S.draft.notion;
  return section('Notion', 'Chiave dell\'integrazione (deve essere collegata al database Uscite e a Budget Mensile).',
    field('Chiave API', secretInput(n, 'apiKey', 'ntn_… oppure secret_…')),
    h('div', { class: 'grid2' }, field('ID database Uscite', textInput(n, 'databaseId')), field('ID database Budget Mensile', textInput(n, 'budgetDatabaseId'))),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', onclick: (e) => runTest(e.currentTarget, () => api.settings.testNotion(), (r) =>
        `Notion OK · ${r.contiCount} conti · budget ${r.month} ${r.budgetFound ? 'trovato' : 'NON trovato'}${r.missing.length ? ` · colonne mancanti: ${r.missing.join(', ')}` : ''}`) }, 'Prova la connessione')));
}

function modelsCard() {
  const d = S.draft;
  const providerRow = (p) => h('div', { class: 'prow' },
    h('input', { type: 'text', value: p.label, 'aria-label': 'Nome provider', oninput: (e) => { p.label = e.target.value; markDirty(); } }),
    h('input', { type: 'text', value: p.baseUrl, 'aria-label': 'Indirizzo API', placeholder: 'https://…/v1', spellcheck: false, oninput: (e) => { p.baseUrl = e.target.value; markDirty(); } }),
    secretInput(p, 'apiKey', 'chiave API (vuota per Ollama)'),
    h('button', { class: 'btn small', type: 'button', onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await ensureSaved();
        S.modelLists[p.id] = await api.settings.listModels(p.id);
        toast(`${S.modelLists[p.id].length} modelli trovati.`, 'ok');
        renderSettings();
      } catch (err) { toast(errMsg(err), 'error'); b.disabled = false; }
    } }, 'Elenca modelli'),
    h('button', { class: 'btn small ghost danger', type: 'button', 'aria-label': `Rimuovi ${p.label}`, onclick: async () => {
      const used = d.models.filter((m) => m.providerId === p.id).length;
      if (used && !(await confirmBox('Rimuovere il provider?', `Verranno rimossi anche i ${used} modelli collegati.`, 'Rimuovi'))) return;
      d.providers = d.providers.filter((x) => x.id !== p.id);
      d.models = d.models.filter((m) => m.providerId !== p.id);
      markDirty();
      renderSettings();
    } }, '✕'));

  const move = (i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= d.models.length) return;
    [d.models[i], d.models[j]] = [d.models[j], d.models[i]];
    markDirty();
    renderSettings();
  };
  const modelRow = (m, i) => {
    const listId = `models-${m.id}`;
    return h('div', { class: 'mrow' },
      h('span', { class: 'order mono', text: String(i + 1) }),
      h('input', { type: 'checkbox', checked: m.enabled, 'aria-label': 'Attivo', title: 'Attivo', onchange: (e) => { m.enabled = e.target.checked; markDirty(); } }),
      h('select', { 'aria-label': 'Provider', value: m.providerId, onchange: (e) => { m.providerId = e.target.value; markDirty(); renderSettings(); } },
        d.providers.map((p) => h('option', { value: p.id, text: p.label }))),
      h('input', { type: 'text', value: m.model, list: listId, placeholder: 'nome del modello', 'aria-label': 'Modello', spellcheck: false, oninput: (e) => { m.model = e.target.value; markDirty(); } }),
      h('datalist', { id: listId }, (S.modelLists[m.providerId] || []).map((x) => h('option', { value: x }))),
      h('label', { class: 'check', title: 'Chiede al modello di rispondere in JSON (se dà errore, disattivalo)' }, h('input', { type: 'checkbox', checked: m.jsonMode, onchange: (e) => { m.jsonMode = e.target.checked; markDirty(); } }), 'JSON'),
      h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Sposta su', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
      h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Sposta giù', disabled: i === d.models.length - 1, onclick: () => move(i, 1) }, '↓'),
      h('button', { class: 'btn small', type: 'button', onclick: (e) => runTest(e.currentTarget, () => api.settings.testModel({ providerId: m.providerId, model: m.model }), (r) => `${m.model}: risponde in ${(r.ms / 1000).toFixed(1)} s`) }, 'Prova'),
      h('button', { class: 'btn small ghost danger', type: 'button', 'aria-label': 'Rimuovi modello', onclick: () => { d.models = d.models.filter((x) => x.id !== m.id); markDirty(); renderSettings(); } }, '✕'));
  };

  const presetSel = h('select', { 'aria-label': 'Tipo di provider' }, presets.map((p) => h('option', { value: p.key, text: p.label })));
  return section('Modelli di lettura', 'Devono supportare le immagini. Sono provati nell\'ordine: se uno è esaurito o non risponde, si passa al successivo. Groq è il predefinito.',
    h('h3', { text: 'Provider' }),
    h('div', { class: 'prows' }, d.providers.map(providerRow)),
    h('div', { class: 'row-actions' }, presetSel,
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        const pr = presets.find((x) => x.key === presetSel.value);
        d.providers.push({ id: uid('p'), label: pr.label.replace(/ \(.*/, ''), baseUrl: pr.baseUrl, apiKey: '' });
        markDirty();
        renderSettings();
      } }, '+ Aggiungi provider')),
    h('h3', { text: 'Modelli (in ordine di priorità)' }),
    h('div', { class: 'mrows' }, d.models.map(modelRow)),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', type: 'button', disabled: !d.providers.length, onclick: () => {
        d.models.push({ id: uid('m'), providerId: d.providers[0].id, model: '', enabled: true, jsonMode: true });
        markDirty();
        renderSettings();
      } }, '+ Aggiungi modello')));
}

function peopleCard() {
  const d = S.draft;
  return section('Persone e cartelle', 'Ogni persona ha una cartella Dropbox e un Tag in Notion con lo stesso nome.',
    h('div', { class: 'prows' }, d.people.map((p) => h('div', { class: 'prow two' },
      h('input', { type: 'text', value: p.name, 'aria-label': 'Nome', oninput: (e) => { p.name = e.target.value; markDirty(); } }),
      h('input', { type: 'text', value: p.folder, 'aria-label': 'Cartella Dropbox', placeholder: '/Nome', spellcheck: false, oninput: (e) => { p.folder = e.target.value; markDirty(); } }),
      h('button', { class: 'btn small ghost danger', type: 'button', 'aria-label': 'Rimuovi persona', onclick: () => { d.people = d.people.filter((x) => x !== p); markDirty(); renderSettings(); } }, '✕')))),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => { d.people.push({ name: '', folder: '' }); markDirty(); renderSettings(); } }, '+ Aggiungi persona')));
}

function storesCard() {
  const d = S.draft;
  const ta = h('textarea', { rows: 8, spellcheck: false, 'aria-label': 'Negozi riconosciuti', value: d.knownStores.join('\n'),
    oninput: (e) => { d.knownStores = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); markDirty(); } });
  const aliases = Object.entries(d.aliases || {});
  return section('Negozi e correzioni', 'I negozi della lista sono quelli che la formula Categoria di Notion riconosce: un nome per riga, scritto come nella formula.',
    ta,
    h('h3', { text: 'Correzioni imparate' }),
    aliases.length
      ? h('div', { class: 'aliases' }, aliases.map(([k, v]) => h('div', { class: 'alias' },
          h('span', { class: 'mono', text: k }), h('span', { 'aria-hidden': 'true', text: '→' }), h('strong', { text: v }),
          h('button', { class: 'btn small ghost danger', type: 'button', 'aria-label': `Dimentica ${k}`, onclick: () => { delete d.aliases[k]; markDirty(); renderSettings(); } }, '✕'))))
      : h('p', { class: 'muted', text: 'Quando correggi il nome di un negozio prima di inviare, l\'app se lo ricorda per le volte successive.' }));
}

function advancedCard() {
  const d = S.draft;
  return section('Avanzate', null,
    h('label', { class: 'check big' }, h('input', { type: 'checkbox', checked: d.attachPhotos !== false, onchange: (e) => { d.attachPhotos = e.target.checked; markDirty(); } }),
      h('span', {}, 'Allega la foto dello scontrino alla riga di Notion ', h('span', { class: 'muted', text: '(colonna «Allegati»; la foto è quella ridotta, leggibile e leggera)' }))),
    h('div', { class: 'grid2' },
      field('Dimensione massima foto inviata al modello (megapixel)', textInput(d, 'maxMegapixels', { type: 'number', number: true, min: 0.5, max: 8, step: 0.5 }), 'Più basso = più veloce e meno token.'),
      field('Attesa massima per un limite di velocità (secondi)', textInput(d, 'maxWaitSeconds', { type: 'number', number: true, min: 10, max: 600, step: 10 }), 'Oltre questo tempo si passa al modello successivo.')),
    h('p', { class: 'muted', text: `Versione ${S.version}. I dati sono in ~/.config/quadra.` }));
}

function renderSettings() {
  const y = $('#view')?.firstElementChild?.scrollTop || 0;
  const view = $('#view');
  const save = h('button', { id: 'btn-save', class: 'btn primary', type: 'button', disabled: !settingsDirty, onclick: async (e) => {
    e.currentTarget.disabled = true;
    try { await saveDraft(); toast('Impostazioni salvate.', 'ok'); renderSettings(); } catch (err) { toast(errMsg(err), 'error'); e.currentTarget.disabled = false; }
  } }, settingsDirty ? 'Salva modifiche' : 'Salvato');
  view.replaceChildren(h('div', { class: 'settings' },
    S.secure ? null : h('div', { class: 'banner warn', role: 'alert' }, 'Il portachiavi di sistema non è disponibile: le chiavi sono salvate in un file leggibile solo da te (permessi 600).'),
    dropboxCard(), notionCard(), modelsCard(), peopleCard(), storesCard(), advancedCard(),
    h('div', { class: 'savebar' }, save)));
  if (y) view.firstElementChild.scrollTop = y;
}

async function loadSettings() {
  const r = await api.settings.get();
  S.settings = r.settings;
  S.draft = clone(r.settings);
  S.secure = r.secureStorage;
  S.version = r.version;
  settingsDirty = false;
}

async function initSettings() {
  try { presets = await api.settings.presets(); } catch { presets = []; }
}
