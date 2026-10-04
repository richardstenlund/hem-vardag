(() => {
  'use strict';
  const status = document.querySelector('#admin-status');
  let nextBefore = null;
  const actionNames = {
    role_changed: 'Ändrade roll', password_reset: 'Återställde lösenord',
    account_deleted: 'Tog bort konto', account_enabled: 'Aktiverade konto', account_disabled: 'Inaktiverade konto',
    household_owner_changed: 'Överförde hushållsägarskap', invitation_created: 'Skapade kontoinbjudan',
    invitation_revoked: 'Återkallade kontoinbjudan', invitation_used: 'Använde kontoinbjudan',
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
    document.querySelector('#admin-mode').hidden = true;
    document.querySelector('#admin-invitations').hidden = true;
    document.querySelector('#admin-audit').hidden = true;
    document.querySelector('#invite-link').value = '';
    document.querySelector('#invite-result').hidden = true;
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
        detail.textContent = `${account.role === 'admin' ? 'Administratör' : 'Användare'} · ${account.active ? 'Aktiv' : 'Inaktiverad'} · Tvåstegsverifiering ${account.twoFactorEnabled ? 'på' : 'av'} · Skapad ${new Date(account.created_at).toLocaleDateString('sv-SE')}`;
        card.append(title, detail);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary-button';
        button.textContent = account.role === 'admin' ? 'Gör till användare' : 'Gör till administratör';
        button.disabled = account.active && account.role === 'admin' && users.filter(person => person.role === 'admin' && person.active).length === 1;
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
            await api(`/admin/users/${account.id}`, { method: 'DELETE', body: JSON.stringify({ email: account.email }) });
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
      await loadInvites();
      await loadAudit();
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
  async function loadInvites() {
    const { invites, inviteOnly, registrationEnabled } = await api('/admin/invites');
    document.querySelector('#admin-invitations').hidden = false;
    document.querySelector('#invite-form').hidden = !registrationEnabled;
    document.querySelector('#registration-mode').textContent = !registrationEnabled
      ? 'All registrering är avstängd (ALLOW_REGISTRATION=false).'
      : inviteOnly ? 'Endast inbjudna personer kan registrera sig.'
        : 'Öppen registrering är aktiverad. Sätt INVITE_ONLY=true för att kräva inbjudan.';
    const list = document.querySelector('#invite-list');
    list.replaceChildren();
    for (const invite of invites) {
      const row = document.createElement('p');
      const state = invite.used_at ? 'Använd' : invite.revoked ? 'Återkallad'
        : Number(invite.expires_at) <= Date.now() ? 'Utgången' : 'Giltig';
      row.textContent = `${invite.email} · ${state} · Gäller till ${new Date(Number(invite.expires_at)).toLocaleString('sv-SE')} `;
      if (state === 'Giltig') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary-button';
        button.textContent = 'Återkalla';
        button.addEventListener('click', async () => {
          if (!confirm(`Återkalla inbjudan för ${invite.email}?`)) return;
          button.disabled = true;
          try {
            await api(`/admin/invites/${invite.id}`, { method: 'DELETE' });
            await loadInvites();
            await loadAudit();
          } catch (error) {
            document.querySelector('#invite-error').textContent = error.message;
            button.disabled = false;
          }
        });
        row.append(button);
      }
      list.append(row);
    }
  }
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
  document.querySelector('#invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    document.querySelector('#invite-error').textContent = '';
    document.querySelector('#invite-link').value = '';
    document.querySelector('#invite-result').hidden = true;
    try {
      const result = await api('/admin/invites', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      const fragment = new URLSearchParams({ invite: result.token, email: result.invite.email });
      document.querySelector('#invite-link').value = `${location.origin}/#${fragment}`;
      document.querySelector('#invite-result').hidden = false;
      form.reset();
      await loadInvites();
      await loadAudit();
    } catch (error) { document.querySelector('#invite-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
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
