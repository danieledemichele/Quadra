'use strict';
/* Schermata di blocco: è l'unica cosa mostrata finché la password non è corretta. */

function showLockScreen(st) {
  document.body.classList.add('is-locked');
  const root = $('#lockroot');
  const input = h('input', { type: 'password', id: 'lock-pw', autocomplete: 'current-password', spellcheck: 'false', maxlength: '256', 'aria-label': 'Password di Quadra', placeholder: 'Password' });
  const msg = h('p', { class: 'lock-msg', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sblocca');
  let timer = null;
  let busy = false;

  const wait = (secs) => {
    clearInterval(timer);
    let left = secs;
    const tick = () => {
      if (left <= 0) { clearInterval(timer); btn.disabled = false; input.disabled = false; msg.textContent = ''; input.focus(); return; }
      btn.disabled = true; input.disabled = true;
      msg.textContent = `Troppi tentativi: riprova tra ${left} s.`;
      left--;
    };
    tick();
    if (left > 0) timer = setInterval(tick, 1000);
  };

  const form = h('form', { class: 'lock-card', autocomplete: 'off', onsubmit: async (e) => {
    e.preventDefault();
    if (busy || !input.value) return;
    busy = true; btn.disabled = true; msg.textContent = '';
    const pw = input.value;
    input.value = '';
    try {
      await api.lock.unlock(pw);
      clearInterval(timer);
      root.hidden = true;
      root.replaceChildren();
      document.body.classList.remove('is-locked');
      init(); // la pagina era vuota: ora si carica tutto
      return;
    } catch (err) {
      const m = /riprova tra (\d+)/i.exec(errMsg(err));
      if (m) wait(parseInt(m[1], 10)); else { msg.textContent = errMsg(err); input.focus(); }
    }
    busy = false;
    if (!input.disabled) btn.disabled = false;
  } },
  h('span', { class: 'brand-mark big', 'aria-hidden': 'true' }),
  h('h1', { text: 'Quadra è bloccata' }),
  h('p', { class: 'muted', text: 'Inserisci la password per continuare.' }),
  input, msg, btn);
  root.replaceChildren(form);
  root.hidden = false;
  if (st?.retryInS > 0) wait(st.retryInS); else input.focus();
}
