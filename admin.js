(() => {
  'use strict';
  const status = document.querySelector('#admin-status');
  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json' } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Serverfel.');
    return body;
  }
  async function load() {
    try {
      const { user } = await api('/me');
      if (user?.role !== 'admin') {
        status.textContent = 'Logga in som administratör på startsidan för att hantera konton.';
        return;
      }
      const { users } = await api('/admin/users');
      for (const account of users) {
        const card = document.createElement('article');
        card.className = 'item-card';
        const title = document.createElement('h2');
        title.textContent = account.email;
        const detail = document.createElement('p');
        detail.textContent = `${account.role === 'admin' ? 'Administratör' : 'Användare'} · Skapad ${new Date(account.created_at).toLocaleDateString('sv-SE')}`;
        card.append(title, detail);
        document.querySelector('#admin-users').append(card);
        document.querySelector('#user-select').add(new Option(account.email, account.id));
      }
      status.textContent = `${users.length} konton`;
      document.querySelector('#admin-password-form').hidden = false;
    } catch (error) { status.textContent = error.message; }
  }
  document.querySelector('#admin-password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api(`/admin/users/${encodeURIComponent(values.get('userId'))}/password`, {
        method: 'POST', body: JSON.stringify({ newPassword: values.get('newPassword') })
      });
      form.reset();
      document.querySelector('#admin-error').textContent = 'Lösenordet ändrat. Kontots tidigare sessioner är utloggade.';
    } catch (error) { document.querySelector('#admin-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  load();
})();
