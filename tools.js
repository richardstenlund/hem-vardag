(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  let listId = new URLSearchParams(location.search).get('list') || '';
  let version = 0;
  let reader = true;
  const query = () => listId ? `?list=${encodeURIComponent(listId)}` : '';
  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json' } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Serverfel.');
    return body;
  }
  function button(label, action) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'secondary-button';
    node.textContent = label;
    node.disabled = reader;
    node.addEventListener('click', () => busy(node, action));
    return node;
  }
  async function busy(node, action) {
    const previousDisabled = node.disabled;
    node.disabled = true;
    $('#tools-error').textContent = '';
    try { await action(); } catch (error) { $('#tools-error').textContent = error.message; }
    finally { node.disabled = previousDisabled; }
  }
  async function load() {
    const { user } = await api('/me');
    if (!user) throw new Error('Logga in på startsidan för att använda listverktygen.');
    reader = user.role === 'reader';
    $('#tools-status').textContent = `${user.username} · ${reader ? 'Läsbehörighet' : 'Kan redigera listor'}`;
    $('#list-create-form').hidden = reader;
    $('#file-upload-form').hidden = reader;
    const { lists } = await api('/lists');
    $('#tools-list').replaceChildren(new Option('Befintliga hem-/kontolistor', ''));
    for (const list of lists) $('#tools-list').add(new Option(`${list.name} · ${list.shared ? 'Delad' : 'Privat'}`, list.id));
    if (listId && !lists.some(list => String(list.id) === listId)) throw new Error('Listan hittades inte eller är inte delad med dig.');
    $('#tools-list').value = listId;
    $('#home-link').href = `/${query()}`;
    const data = await api(`/list-data${query()}`);
    version = data.version;
    $('#file-item').replaceChildren(new Option('Hela listan', ''));
    for (const [kind, items] of Object.entries(data.data)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item && typeof item.id === 'string' && typeof item.title === 'string') $('#file-item').add(new Option(item.title, `${kind}:${item.id}`));
      }
    }
    const [trash, history, files] = await Promise.all(['trash', 'history', 'files'].map(kind => api(`/tools/${kind}${query()}`)));
    for (const [kind, result] of [['trash', trash], ['history', history]]) {
      const container = $(`#${kind}-items`);
      container.replaceChildren();
      for (const row of result.items) {
        const card = document.createElement('article');
        card.className = 'item-card';
        const text = document.createElement('p');
        text.textContent = `${kind === 'trash' ? row.item.title : 'Version före ändring'} · ${row.actor} · ${new Date(Number(row.deleted_at || row.created_at)).toLocaleString('sv-SE')}`;
        if (kind === 'history' && row.summary.length) text.textContent += ` · ${row.summary.join('; ')}`;
        card.append(text, button('Återställ', async () => {
          if (!confirm(kind === 'history' ? 'Ersätta listornas innehåll med den här versionen? Ta gärna backup först.' : 'Återställa posten?')) return;
          await api(`/tools/${kind}/${row.id}/restore${query()}`, { method: 'POST', body: JSON.stringify({ version }) });
          await load();
        }));
        container.append(card);
      }
      if (!result.items.length) container.textContent = 'Inga poster ännu.';
    }
    $('#file-items').replaceChildren();
    for (const file of files.items) {
      const card = document.createElement('article');
      card.className = 'item-card';
      const link = document.createElement('a');
      link.textContent = `${file.name} (${Math.ceil(file.size / 1024)} kB)`;
      link.href = `/api/tools/files/${file.id}${query()}`;
      card.append(link, button('Ta bort fil', async () => {
        if (!confirm('Ta bort filen permanent? Filborttagning går inte till papperskorgen.')) return;
        await api(`/tools/files/${file.id}${query()}`, { method: 'DELETE' });
        await load();
      }));
      $('#file-items').append(card);
    }
    const push = await api('/push');
    $('#push-enable').disabled = !push.configured;
    $('#push-status').textContent = push.configured
      ? `${push.enabled ? 'Kontot har aktiverade pushpåminnelser.' : 'Pushpåminnelser är inte aktiverade.'} Tidszon: ${push.timezone}.`
      : 'Push kräver att serverns APP_URL är sidans HTTPS-adress (inte localhost). Listverktygen fungerar utan push.';
  }
  $('#tools-list').addEventListener('change', async event => {
    listId = event.target.value;
    history.replaceState(null, '', `/tools.html${query()}`);
    try { await load(); } catch (error) { $('#tools-error').textContent = error.message; }
  });
  $('#list-create-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    busy(form.querySelector('button'), async () => {
      const { list } = await api('/lists', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      listId = String(list.id);
      history.replaceState(null, '', `/tools.html${query()}`);
      await load();
    });
  });
  $('#file-upload-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    busy(form.querySelector('button'), async () => {
      const values = new FormData(form);
      const file = values.get('file');
      if (!file || file.size > 5 * 1024 * 1024) throw new Error('Välj en fil på högst 5 MB.');
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Filen kunde inte läsas.'));
        reader.readAsDataURL(file);
      });
      await api(`/tools/files${query()}`, { method: 'POST', body: JSON.stringify({ name: file.name, base64, itemId: values.get('itemId') }) });
      form.reset();
      await load();
    });
  });
  $('#push-enable').addEventListener('click', event => busy(event.currentTarget, async () => {
    const { publicKey, configured } = await api('/push');
    if (!configured) throw new Error('Ställ in serverns APP_URL till sidans HTTPS-adress (inte localhost).');
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push kräver HTTPS och en webbläsare med Web Push-stöd.');
    if (await Notification.requestPermission() !== 'granted') throw new Error('Tillåt aviseringar i webbläsarens inställningar.');
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await api('/push', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
    $('#push-status').textContent = 'Påminnelser aktiverade på denna enhet, även när sidan är stängd.';
  }));
  $('#push-disable').addEventListener('click', event => busy(event.currentTarget, async () => {
    await api('/push', { method: 'DELETE' });
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    }
    $('#push-status').textContent = 'Pushpåminnelser avstängda för alla dina enheter.';
  }));
  load().catch(error => { $('#tools-error').textContent = error.message; });
})();
