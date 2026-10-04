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
    document.querySelector('#admin-users').replaceChildren();
    document.querySelector('#user-select').replaceChildren();
    document.querySelector('#admin-password-form').hidden = true;
    document.querySelector('#admin-mode').hidden = true;
    try {
      const { user } = await api('/me');
      if (user?.role !== 'admin') {
        status.textContent = 'Logga in som administratör på startsidan för att hantera konton.';
        return;
      }
      const { users, allUsersAdmin } = await api('/admin/users');
      document.querySelector('#admin-mode').hidden = !allUsersAdmin;
      for (const account of users) {
        const card = document.createElement('article');
        card.className = 'item-card';
        const title = document.createElement('h2');
        title.textContent = account.email;
        const detail = document.createElement('p');
        detail.textContent = `${account.role === 'admin' ? 'Administratör' : 'Användare'} · Skapad ${new Date(account.created_at).toLocaleDateString('sv-SE')}`;
        card.append(title, detail);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary-button';
        button.textContent = account.role === 'admin' ? 'Gör till användare' : 'Gör till administratör';
        button.disabled = account.role === 'admin' && users.filter(person => person.role === 'admin').length === 1;
        if (button.disabled) button.title = 'Utse en annan administratör först.';
        button.addEventListener('click', async () => {
          const role = account.role === 'admin' ? 'user' : 'admin';
          const message = role === 'admin'
            ? `Göra ${account.email} till administratör? Kontot får hantera alla användares roller och lösenord.`
            : `Göra ${account.email} till vanlig användare?${account.id === user.id ? ' Du förlorar själv åtkomsten till kontohanteringen.' : ''}`;
          if (!confirm(message)) return;
          button.disabled = true;
          const feedback = document.querySelector('#admin-role-status');
          feedback.textContent = '';
          try {
            await api(`/admin/users/${account.id}/role`, { method: 'POST', body: JSON.stringify({ role }) });
            feedback.textContent = `${account.email} är nu ${role === 'admin' ? 'administratör' : 'vanlig användare'}.`;
            await load();
          } catch (error) {
            feedback.textContent = error.message;
            button.disabled = false;
          }
        });
        if (!allUsersAdmin) card.append(button);
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
