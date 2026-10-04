const crypto = require('node:crypto');

const maxData = 1024 * 1024;
const validItem = item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.title === 'string';
const contentItems = items => Array.isArray(items) ? items.filter(validItem) : [];
const validData = data => data && typeof data === 'object' && !Array.isArray(data)
  && Object.keys(data).every(kind => kind.length > 0 && kind.length <= 40 && !['__proto__', 'constructor', 'prototype'].includes(kind))
  && Object.values(data).every(items => Array.isArray(items)
    && items.every(validItem));

async function initTools(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS named_lists (
    id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    household_id INTEGER REFERENCES household_spaces(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS list_history (
    id SERIAL PRIMARY KEY, scope VARCHAR(80) NOT NULL, actor VARCHAR(254) NOT NULL,
    data_json TEXT NOT NULL, summary_json TEXT NOT NULL DEFAULT '[]', created_at BIGINT NOT NULL
  )`);
  await pool.query("ALTER TABLE list_history ADD COLUMN IF NOT EXISTS summary_json TEXT NOT NULL DEFAULT '[]'");
  await pool.query(`CREATE TABLE IF NOT EXISTS list_trash (
    id SERIAL PRIMARY KEY, scope VARCHAR(80) NOT NULL, kind VARCHAR(40) NOT NULL,
    item_json TEXT NOT NULL, deleted_at BIGINT NOT NULL, actor VARCHAR(254) NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS list_files (
    id VARCHAR(32) PRIMARY KEY, scope VARCHAR(80) NOT NULL, name VARCHAR(120) NOT NULL,
    mime VARCHAR(40) NOT NULL, contents TEXT NOT NULL, size INTEGER NOT NULL, item_id VARCHAR(160) NOT NULL DEFAULT '',
    actor VARCHAR(254) NOT NULL, created_at BIGINT NOT NULL
  )`);
  await pool.query("ALTER TABLE list_files ADD COLUMN IF NOT EXISTS item_id VARCHAR(160) NOT NULL DEFAULT ''");
}

async function recordChange(client, scope, actor, previous, next) {
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  const now = Date.now();
  const summary = [];
  for (const kind of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const oldItems = contentItems(previous[kind]);
    const newItems = contentItems(next[kind]);
    for (const item of newItems) {
      const old = oldItems.find(entry => entry.id === item.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(item)) summary.push(`${old ? 'Ändrade' : 'Skapade'}: ${String(item.title || '').slice(0, 120)}`);
    }
    for (const item of oldItems) if (!newItems.some(entry => entry.id === item.id)) summary.push(`Tog bort: ${String(item.title || '').slice(0, 120)}`);
  }
  await client.query('INSERT INTO list_history (scope, actor, data_json, summary_json, created_at) VALUES ($1, $2, $3, $4, $5)',
    [scope, actor, JSON.stringify(previous), JSON.stringify(summary.slice(0, 100)), now]);
  for (const [kind, items] of Object.entries(previous)) {
    if (kind.length > 40 || ['__proto__', 'constructor', 'prototype'].includes(kind)) continue;
    const remaining = new Set(contentItems(next[kind]).map(item => item.id));
    for (const item of contentItems(items)) {
      if (!item || typeof item.id !== 'string' || remaining.has(item.id)) continue;
      await client.query('INSERT INTO list_trash (scope, kind, item_json, deleted_at, actor) VALUES ($1, $2, $3, $4, $5)',
        [scope, kind.slice(0, 40), JSON.stringify(item), now, actor]);
    }
  }
  await client.query('DELETE FROM list_trash WHERE deleted_at < $1', [now - 30 * 86400000]);
  const { rows } = await client.query('SELECT id FROM list_history WHERE scope = $1 ORDER BY id DESC', [scope]);
  for (const row of rows.slice(50)) await client.query('DELETE FROM list_history WHERE id = $1', [row.id]);
}

function mountTools(app, { pool, authenticated, transaction }) {
  async function context(client, req, lock = false) {
    const { rows: [user] } = await client.query(`SELECT id, role, active FROM users WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [req.user.id]);
    if (!user?.active) return { status: 401, error: 'Inloggningen är inte längre giltig.' };
    const { rows: [membership] } = await client.query('SELECT household_id FROM household_members WHERE user_id = $1', [user.id]);
    const listId = req.query.list;
    if (listId) {
      if (!/^[1-9]\d*$/.test(String(listId)) || !Number.isSafeInteger(Number(listId))) return { status: 400, error: 'Ogiltig lista.' };
      const { rows: [list] } = await client.query(`SELECT * FROM named_lists WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(listId)]);
      if (!list || (list.household_id ? list.household_id !== membership?.household_id : list.owner_id !== user.id)) {
        return { status: 404, error: 'Listan hittades inte.' };
      }
      return { user, scope: `list:${list.id}`, table: 'named_lists', key: 'id', id: list.id, row: list };
    }
    if (membership) {
      const { rows: [row] } = await client.query(`SELECT * FROM household_spaces WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [membership.household_id]);
      return { user, scope: `household:${row.id}`, table: 'household_spaces', key: 'id', id: row.id, row };
    }
    const { rows: [row] } = await client.query(`SELECT * FROM household_data WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [user.id]);
    return { user, scope: `personal:${user.id}`, table: 'household_data', key: 'user_id', id: user.id, row: row || { data_json: '{}', version: 0 } };
  }
  async function scoped(req, res, write, action) {
    const result = await transaction(async client => {
      const ctx = await context(client, req, write);
      if (ctx.error) return ctx;
      if (write && ctx.user.role === 'reader') return { status: 403, error: 'Läsare kan inte ändra innehåll.' };
      return action(client, ctx);
    });
    res.status(result.status || 200).json(result.error ? { error: result.error } : result.body);
  }
  async function save(client, ctx, req, data) {
    if (!validData(data) || Buffer.byteLength(JSON.stringify(data)) > maxData) return { status: 400, error: 'Ogiltiga listor eller över 1 MB.' };
    if (req.body.version !== ctx.row.version) return { status: 409, error: 'Listan har ändrats. Ladda om innan du sparar.' };
    await recordChange(client, ctx.scope, req.user.email, JSON.parse(ctx.row.data_json), data);
    if (ctx.table === 'household_data') {
      await client.query(`INSERT INTO household_data (user_id, data_json, version) VALUES ($1, $2, 1)
        ON CONFLICT (user_id) DO UPDATE SET data_json = EXCLUDED.data_json, version = household_data.version + 1`, [ctx.id, JSON.stringify(data)]);
    } else {
      await client.query(`UPDATE ${ctx.table} SET data_json = $1, version = version + 1 WHERE ${ctx.key} = $2`, [JSON.stringify(data), ctx.id]);
    }
    return { body: { saved: true, version: ctx.row.version + 1 } };
  }
  app.get('/api/lists', ...authenticated(async (req, res) => {
    const { rows: [membership] } = await pool.query('SELECT household_id FROM household_members WHERE user_id = $1', [req.user.id]);
    const { rows } = await pool.query('SELECT id, name, owner_id, household_id FROM named_lists ORDER BY id');
    res.json({ lists: rows.filter(row => row.household_id ? row.household_id === membership?.household_id : row.owner_id === req.user.id)
      .map(row => ({ id: row.id, name: row.name, shared: Boolean(row.household_id) })) });
  }));
  app.post('/api/lists', ...authenticated(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 80 || !['private', 'shared'].includes(req.body?.visibility)) {
      return res.status(400).json({ error: 'Ange namn (1–80 tecken) och privat eller delad lista.' });
    }
    await scoped(req, res, true, async (client, ctx) => {
      const { rows: [membership] } = await client.query('SELECT household_id FROM household_members WHERE user_id = $1', [req.user.id]);
      if (req.body.visibility === 'shared' && !membership) return { status: 409, error: 'Gå först med i eller skapa ett hushåll.' };
      const { rows: [row] } = await client.query(
        'INSERT INTO named_lists (name, owner_id, household_id) VALUES ($1, $2, $3) RETURNING id, name',
        [name, req.user.id, req.body.visibility === 'shared' ? membership.household_id : null]);
      return { status: 201, body: { list: row } };
    });
  }));
  app.get('/api/list-data', ...authenticated(async (req, res) => {
    await scoped(req, res, false, async (client, ctx) => {
      const { rows: members } = ctx.row.household_id || ctx.table === 'household_spaces'
        ? await client.query(`SELECT u.id, u.email FROM household_members m JOIN users u ON u.id = m.user_id
            WHERE m.household_id = $1 ORDER BY u.id`, [ctx.row.household_id || ctx.id])
        : { rows: [{ id: req.user.id, email: req.user.email }] };
      return { body: { data: JSON.parse(ctx.row.data_json), version: ctx.row.version, members } };
    });
  }));
  app.put('/api/list-data', ...authenticated(async (req, res) => {
    await scoped(req, res, true, (client, ctx) => save(client, ctx, req, req.body.data));
  }));
  for (const kind of ['history', 'trash', 'files']) {
    app.get(`/api/tools/${kind}`, ...authenticated(async (req, res) => {
      await scoped(req, res, false, async (client, ctx) => {
        const fields = kind === 'history' ? 'id, actor, summary_json, created_at' : kind === 'trash' ? 'id, kind, item_json, deleted_at, actor' : 'id, name, mime, size, item_id, actor, created_at';
        const { rows } = await client.query(`SELECT ${fields} FROM list_${kind} WHERE scope = $1 ORDER BY ${kind === 'files' ? 'created_at' : 'id'} DESC`, [ctx.scope]);
        return { body: { items: kind === 'trash' ? rows.filter(row => Number(row.deleted_at) >= Date.now() - 30 * 86400000)
          .map(row => ({ ...row, item: JSON.parse(row.item_json), item_json: undefined }))
          : kind === 'history' ? rows.map(row => ({ ...row, summary: JSON.parse(row.summary_json), summary_json: undefined })) : rows } };
      });
    }));
  }
  for (const kind of ['history', 'trash']) {
    app.post(`/api/tools/${kind}/:id/restore`, ...authenticated(async (req, res) => {
      if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({ error: 'Ogiltig post.' });
      await scoped(req, res, true, async (client, ctx) => {
        const { rows: [row] } = await client.query(`SELECT * FROM list_${kind} WHERE id = $1 AND scope = $2`, [Number(req.params.id), ctx.scope]);
        if (!row || (kind === 'trash' && Number(row.deleted_at) < Date.now() - 30 * 86400000)) return { status: 404, error: 'Posten hittades inte eller har gått ut.' };
        let data = JSON.parse(ctx.row.data_json);
        if (kind === 'history') data = JSON.parse(row.data_json);
        else {
          const item = JSON.parse(row.item_json);
          if (data[row.kind] && !Array.isArray(data[row.kind])) return { status: 400, error: 'Listans innehåll är inte giltigt för återställning.' };
          if ((data[row.kind] || []).some(entry => entry?.id === item.id)) return { status: 409, error: 'Posten finns redan i listan.' };
          data[row.kind] = [item, ...(data[row.kind] || [])];
        }
        const result = await save(client, ctx, req, data);
        if (!result.error && kind === 'trash') await client.query('DELETE FROM list_trash WHERE id = $1', [row.id]);
        return result;
      });
    }));
  }
  app.post('/api/tools/files', ...authenticated(async (req, res) => {
    const { name, base64 } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 120 || typeof base64 !== 'string'
      || base64.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      return res.status(400).json({ error: 'Ange en fil på högst 5 MB.' });
    }
    const buffer = Buffer.from(base64, 'base64');
    const mime = buffer.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
      : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? 'image/jpeg' : '';
    if (!mime || buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Endast PDF, PNG och JPEG på högst 5 MB stöds.' });
    await scoped(req, res, true, async (client, ctx) => {
      const { rows: files } = await client.query('SELECT size FROM list_files WHERE scope = $1', [ctx.scope]);
      if (files.reduce((sum, file) => sum + file.size, 0) + buffer.length > 50 * 1024 * 1024) return { status: 413, error: 'Filerna i listan får tillsammans vara högst 50 MB.' };
      const itemId = String(req.body.itemId || '');
      if (itemId.length > 160 || (itemId && !Object.entries(JSON.parse(ctx.row.data_json)).some(([kind, items]) =>
        contentItems(items).some(item => `${kind}:${item.id}` === itemId)))) return { status: 400, error: 'Välj en befintlig post för filen.' };
      const id = crypto.randomBytes(16).toString('hex');
      await client.query('INSERT INTO list_files (id, scope, name, mime, contents, size, item_id, actor, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, ctx.scope, name.trim(), mime, buffer.toString('base64'), buffer.length, itemId, req.user.email, Date.now()]);
      return { status: 201, body: { id } };
    });
  }));
  app.get('/api/tools/files/:id', ...authenticated(async (req, res) => {
    const ctx = await context(pool, req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const { rows: [file] } = await pool.query('SELECT * FROM list_files WHERE id = $1 AND scope = $2', [req.params.id, ctx.scope]);
    if (!file) return res.status(404).json({ error: 'Filen hittades inte.' });
    res.setHeader('Content-Type', file.mime);
    const filename = encodeURIComponent(file.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(Buffer.from(file.contents, 'base64'));
  }));
  app.delete('/api/tools/files/:id', ...authenticated(async (req, res) => {
    await scoped(req, res, true, async (client, ctx) => {
      const { rows } = await client.query('DELETE FROM list_files WHERE id = $1 AND scope = $2 RETURNING id', [req.params.id, ctx.scope]);
      return rows.length ? { body: { ok: true } } : { status: 404, error: 'Filen hittades inte.' };
    });
  }));
}
module.exports = { initTools, mountTools, recordChange };
