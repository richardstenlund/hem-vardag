(() => {
  'use strict';
  const status = document.querySelector('#admin-status');
  let nextBefore = null;
  const actionNames = {
    role_changed: 'Ändrade roll', password_reset: 'Återställde lösenord',
    account_created: 'Skapade konto', account_deleted: 'Tog bort konto', account_enabled: 'Aktiverade konto', account_disabled: 'Inaktiverade konto',
    household_owner_changed: 'Överförde hushållsägarskap',
    two_factor_enabled: 'Aktiverade tvåstegsverifiering', two_factor_disabled: 'Stängde av tvåstegsverifiering',
    two_factor_changed: 'Bytte autentiseringsnyckel',
    recovery_codes_replaced: 'Ersatte återställningskoder'
  };
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
    document.querySelector('#admin-create-form').hidden = true;
    document.querySelector('#admin-mode').hidden = true;
    document.querySelector('#admin-audit').hidden = true;
    try {
      const { user } = await api('/me');
      if (user?.role !== 'admin') {
        status.textContent = 'Logga in som administratör på startsidan för att hantera konton.';
        return;
      }
      const { users } = await api('/admin/users');
      document.querySelector('#admin-mode').hidden = false;
      for (const account of users) {
        const card = document.createElement('article');
        card.className = 'item-card';
        const title = document.createElement('h2');
        title.textContent = account.email;
        const detail = document.createElement('p');
        const roleNames = { admin: 'Administratör', user: 'Användare', reader: 'Läsare' };
        detail.textContent = `${roleNames[account.role]} · ${account.active ? 'Aktiv' : 'Inaktiverad'} · Tvåstegsverifiering ${account.twoFactorEnabled ? 'på' : 'av'} · Skapad ${new Date(account.created_at).toLocaleDateString('sv-SE')}`;
        card.append(title, detail);
        const roleButton = document.createElement('button');
        roleButton.type = 'button';
        roleButton.className = 'secondary-button';
        const roleLabel = document.createElement('label');
        roleLabel.className = 'form-field';
        roleLabel.textContent = 'Roll';
        const roleSelect = document.createElement('select');
        for (const [role, name] of Object.entries(roleNames)) roleSelect.add(new Option(name, role));
        roleSelect.value = account.role;
        roleLabel.append(roleSelect);
        roleButton.textContent = 'Spara roll';
        const lastAdmin = account.role === 'admin' && account.active && users.filter(person => person.active && person.role === 'admin').length === 1;
        roleSelect.disabled = lastAdmin;
        roleButton.disabled = lastAdmin;
        roleButton.addEventListener('click', async () => {
          const nextRole = roleSelect.value;
          if (nextRole === account.role) return;
          const permission = nextRole === 'admin' ? 'Kontot kan hantera andra konton och redigera sina listor.'
            : nextRole === 'user' ? 'Kontot kan redigera sina listor men inte hantera konton.'
              : 'Kontot kan bara läsa sina listor och inte hantera konton.';
          if (!confirm(`Gör ${account.email} till ${roleNames[nextRole].toLowerCase()}? ${permission}${account.id === user.id && nextRole !== 'admin' ? ' Du förlorar själv åtkomst till kontohanteringen.' : ''}`)) return;
          roleButton.disabled = true;
          const feedback = document.querySelector('#admin-role-status');
          try {
            await api(`/admin/users/${account.id}/role`, { method: 'POST', body: JSON.stringify({ role: nextRole }) });
            feedback.textContent = `${account.email} är nu ${roleNames[nextRole].toLowerCase()}.`;
            await load();
          } catch (error) {
            feedback.textContent = error.message;
            roleButton.disabled = false;
          }
        });
        card.append(roleLabel, roleButton);
        const activeButton = document.createElement('button');
        activeButton.type = 'button';
        activeButton.className = 'secondary-button';
        activeButton.textContent = account.active ? 'Inaktivera konto' : 'Aktivera konto';
        activeButton.disabled = account.active && account.role === 'admin' && users.filter(person => person.role === 'admin' && person.active).length === 1;
        activeButton.addEventListener('click', async () => {
          if (!confirm(account.active
            ? `Inaktivera ${account.email}? Alla inloggningar avslutas, men kontot och listorna behålls.`
            : `Aktivera ${account.email} igen?`)) return;
          activeButton.disabled = true;
          const feedback = document.querySelector('#admin-role-status');
          try {
            await api(`/admin/users/${account.id}/active`, { method: 'POST', body: JSON.stringify({ active: !account.active }) });
            feedback.textContent = `${account.email} är nu ${account.active ? 'inaktiverat' : 'aktiverat'}.`;
            await load();
          } catch (error) {
            feedback.textContent = error.message;
            activeButton.disabled = false;
          }
        });
        card.append(activeButton);
        if (account.ownedHousehold) {
          const household = account.ownedHousehold;
          const info = document.createElement('p');
          info.textContent = `Äger hushållet ${household.name}.`;
          card.append(info);
          if (household.members.length) {
            const form = document.createElement('form');
            const label = document.createElement('label');
            label.className = 'form-field';
            label.textContent = 'Ny hushållsägare';
            const select = document.createElement('select');
            select.required = true;
            select.add(new Option('Välj medlem', ''));
            for (const member of household.members) select.add(new Option(member.email, member.id));
            const transfer = document.createElement('button');
            transfer.type = 'submit';
            transfer.className = 'secondary-button';
            transfer.textContent = 'Överför ägarskap';
            label.append(select);
            form.append(label, transfer);
            form.addEventListener('submit', async event => {
              event.preventDefault();
              const chosen = household.members.find(member => member.id === Number(select.value));
              if (!chosen || !confirm(`Överföra ägarskapet för ${household.name} till ${chosen.email}? Listorna behålls och den nya ägaren får tillgång till inbjudningskoden.`)) return;
              transfer.disabled = true;
              const feedback = document.querySelector('#admin-role-status');
              try {
                await api(`/admin/users/${account.id}/household-owner`, {
                  method: 'POST', body: JSON.stringify({ newOwnerId: chosen.id })
                });
                feedback.textContent = `Ägarskapet har överförts till ${chosen.email}.`;
                await load();
              } catch (error) {
                feedback.textContent = error.message;
                transfer.disabled = false;
              }
            });
            card.append(form);
          } else {
            const hint = document.createElement('p');
            hint.textContent = 'Bjud först in en annan medlem till hushållet för att kunna överföra ägarskapet.';
            card.append(hint);
          }
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary-button';
        remove.textContent = 'Ta bort användare';
        remove.disabled = Boolean(account.deletionBlockedReason);
        if (account.deletionBlockedReason) {
          const reason = document.createElement('p');
          reason.textContent = account.deletionBlockedReason;
          card.append(reason);
        }
        remove.addEventListener('click', async () => {
          if (!confirm(`Ta bort ${account.email} permanent? Kontot, privata listor och inloggningar raderas. Delade hushållslistor behålls.${account.id === user.id ? ' Du tar bort ditt eget konto och loggas ut.' : ''}`)) return;
          remove.disabled = true;
          const feedback = document.querySelector('#admin-role-status');
          try {
            await api(`/admin/users/${account.id}`, { method: 'DELETE', body: JSON.stringify({ username: account.username || account.email }) });
            feedback.textContent = `${account.email} har tagits bort.`;
            await load();
          } catch (error) {
            feedback.textContent = error.message;
            remove.disabled = false;
          }
        });
        card.append(remove);
        document.querySelector('#admin-users').append(card);
        document.querySelector('#user-select').add(new Option(account.email, account.id));
      }
      status.textContent = `${users.length} konton`;
      document.querySelector('#admin-password-form').hidden = false;
      document.querySelector('#admin-create-form').hidden = false;
      await loadAudit();
    } catch (error) { status.textContent = error.message; }
  }
  document.querySelector('#admin-create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const button = form.querySelector('button');
    const feedback = document.querySelector('#admin-create-error');
    button.disabled = true;
    feedback.textContent = '';
    try {
      const { user } = await api('/admin/users', {
        method: 'POST', body: JSON.stringify({ username: values.get('username'), password: values.get('password') })
      });
      form.reset();
      feedback.textContent = `${user.username} har skapats som administratör. Du är fortfarande inloggad på ditt eget konto.`;
      await load();
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; }
  });
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
  async function loadAudit(older = false) {
    const { events, nextBefore: next } = await api(`/admin/audit${older && nextBefore ? `?before=${nextBefore}` : ''}`);
    const list = document.querySelector('#audit-list');
    if (!older) list.replaceChildren();
    for (const event of events) {
      const item = document.createElement('li');
      item.textContent = `${new Date(event.created_at).toLocaleString('sv-SE')} · ${event.actor_email} · ${actionNames[event.action] || event.action} · ${event.target_email}${event.detail ? ` · ${event.detail}` : ''}`;
      list.append(item);
    }
    nextBefore = next;
    document.querySelector('#more-audit').hidden = !nextBefore;
    document.querySelector('#admin-audit').hidden = false;
  }
  for (const [id, older] of [['refresh-audit', false], ['more-audit', true]]) {
    document.querySelector(`#${id}`).addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      document.querySelector('#audit-error').textContent = '';
      try { await loadAudit(older); }
      catch (error) { document.querySelector('#audit-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  load();
})();
