(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  let user;
  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json' } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Serverfel.');
    return body;
  }
  async function perform(button, action) {
    button.disabled = true;
    $('#security-error').textContent = '';
    try { await action(); }
    catch (error) { $('#security-error').textContent = error.message; }
    finally { button.disabled = false; }
  }
  function showRecovery(codes) {
    $('#recovery-codes').value = codes.join('\n');
    $('#recovery-result').hidden = false;
    $('#factor-actions').hidden = true;
    $('#setup-details').hidden = true;
    $('#setup-secret').value = '';
    $('#setup-qr').removeAttribute('src');
    $('#recovery-result').scrollIntoView({ block: 'nearest' });
  }
  async function load() {
    $('#security-content').hidden = true;
    user = (await api('/me')).user;
    if (!user) {
      $('#security-status').textContent = 'Logga in på startsidan för att hantera kontosäkerheten.';
      return;
    }
    const state = await api('/security');
    $('#security-status').textContent = user.email;
    $('#security-content').hidden = false;
    $('#two-factor-description').textContent = state.enabled
      ? 'Tvåstegsverifiering är aktiverad. Vid inloggning behöver du även en appkod eller återställningskod.'
      : state.required ? 'Du är administratör och måste aktivera tvåstegsverifiering innan du kan administrera konton.'
        : 'Tvåstegsverifiering är valfri för ditt konto och ger extra skydd.';
    $('#setup-form').hidden = state.enabled;
    $('#verify-form').hidden = !state.enabled || state.verified;
    $('#factor-actions').hidden = !state.enabled || !state.verified || !$('#recovery-result').hidden;
    $('#disable-factor').hidden = state.required;
    $('#recovery-count').textContent = `${state.recoveryRemaining} återställningskoder kvar.`;
    $('#security-admin-link').hidden = !state.required || !state.enabled || !state.verified;
    $('#sessions-section').hidden = state.enabled && !state.verified;
    if (!$('#sessions-section').hidden) await loadSessions();
  }
  async function loadSessions() {
    const { sessions } = await api('/security/sessions');
    $('#session-list').replaceChildren();
    for (const session of sessions) {
      const card = document.createElement('article');
      card.className = 'item-card';
      const title = document.createElement('h3');
      title.textContent = session.current ? 'Den här enheten' : 'Annan inloggning';
      const detail = document.createElement('p');
      detail.textContent = `${session.device} · Inloggad ${new Date(session.createdAt).toLocaleString('sv-SE')} · Gäller till ${new Date(session.expiresAt).toLocaleString('sv-SE')}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary-button';
      button.textContent = session.current ? 'Logga ut här' : 'Avsluta inloggning';
      button.addEventListener('click', () => {
        if (!confirm(session.current ? 'Logga ut från den här enheten?' : 'Avsluta den här inloggningen?')) return;
        perform(button, async () => {
          await api(`/security/sessions/${session.id}`, { method: 'DELETE' });
          if (session.current) {
            $('#recovery-codes').value = '';
            $('#setup-secret').value = '';
            $('#setup-qr').removeAttribute('src');
          }
          await load();
        });
      });
      card.append(title, detail, button);
      $('#session-list').append(card);
    }
  }
  $('#setup-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    perform(form.querySelector('button'), async () => {
      const result = await api('/security/setup', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      $('#setup-secret').value = result.secret;
      $('#setup-qr').src = result.qrCode;
      $('#setup-details').hidden = false;
    });
  });
  $('#enable-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    perform(form.querySelector('button'), async () => {
      const result = await api('/security/enable', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      showRecovery(result.recoveryCodes);
      await load();
    });
  });
  $('#verify-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    perform(form.querySelector('button'), async () => {
      await api('/security/verify', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      await load();
    });
  });
  $('#factor-actions').addEventListener('submit', event => {
    event.preventDefault();
    const action = event.submitter.value;
    if (!confirm(action === 'disable' ? 'Stänga av tvåstegsverifiering?'
      : action === 'setup' ? 'Skapa en ny autentiseringsnyckel? Den gamla fungerar tills den nya har bekräftats.'
        : 'Ersätta alla tidigare återställningskoder?')) return;
    const form = event.currentTarget;
    perform(event.submitter, async () => {
      const result = await api(`/security/${action}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      if (result.recoveryCodes) showRecovery(result.recoveryCodes);
      if (result.secret) {
        $('#setup-secret').value = result.secret;
        $('#setup-qr').src = result.qrCode;
        $('#setup-details').hidden = false;
      }
      await load();
    });
  });
  $('#acknowledge-codes').addEventListener('click', event => {
    perform(event.currentTarget, async () => {
      $('#recovery-codes').value = '';
      $('#recovery-result').hidden = true;
      await load();
    });
  });
  $('#download-codes').addEventListener('click', () => {
    const blob = new Blob([`Hem & vardag – ${user.email}\nFörvara privat. Varje kod fungerar en gång.\n\n${$('#recovery-codes').value}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hem-vardag-aterstallningskoder.txt';
    link.click();
    URL.revokeObjectURL(url);
  });
  $('#revoke-others').addEventListener('click', event => {
    if (!confirm('Logga ut alla andra enheter?')) return;
    perform(event.currentTarget, async () => {
      await api('/security/sessions/revoke-others', { method: 'POST' });
      await loadSessions();
      $('#security-status').textContent = 'Alla andra enheter är utloggade.';
    });
  });
  window.addEventListener('beforeunload', event => {
    if ($('#recovery-result').hidden) return;
    event.preventDefault();
    event.returnValue = '';
  });
  load().catch(error => { $('#security-error').textContent = error.message; });
})();
