const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');

const validEmail = value => typeof value === 'string' && value.length <= 254 && /^\S+@\S+\.\S+$/.test(value);
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt, hash: crypto.scryptSync(password, salt, 64).toString('hex')
});
const publicUser = user => ({ id: user.id, email: user.email, role: user.role });
const dataLimit = 1024 * 1024;
const allUsersAdmin = config => config.ALL_USERS_ADMIN !== 'false';

async function initDatabase(pool, config = process.env) {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE,
    password_hash CHAR(128) NOT NULL, password_salt CHAR(32) NOT NULL,
    role VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS household_data (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS household_spaces (
    id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL, invite_code VARCHAR(12) NOT NULL UNIQUE,
    owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS household_members (
    household_id INTEGER NOT NULL REFERENCES household_spaces(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL CHECK (role IN ('owner', 'member')),
    PRIMARY KEY (household_id, user_id)
  )`);
  const email = String(config.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(config.ADMIN_PASSWORD || '');
  if (email || password) {
    if (!validEmail(email) || password.length < 12 || password.length > 256) {
      throw new Error('ADMIN_EMAIL måste vara giltig och ADMIN_PASSWORD ha 12–256 tecken.');
    }
    const { salt, hash } = hashPassword(password);
    await pool.query(
      `INSERT INTO users (email, password_hash, password_salt, role) VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO NOTHING`, [email, hash, salt]);
  }
  if (allUsersAdmin(config)) await pool.query("UPDATE users SET role = 'admin' WHERE role <> 'admin'");
}

function mergeHouseholdData(primary, secondary) {
  const merged = { ...primary };
  for (const [key, items] of Object.entries(secondary)) {
    if (!Array.isArray(items)) continue;
    const byId = new Map();
    for (const item of [...(Array.isArray(merged[key]) ? merged[key] : []), ...items]) {
      if (item && typeof item === 'object' && typeof item.id === 'string') byId.set(item.id, item);
    }
    merged[key] = [...byId.values()];
  }
  return merged;
}

function createApp(pool, config = process.env) {
  const app = express();
  const secure = config.SECURE_COOKIES === 'true';
  const sessionsDays = Math.max(1, Number(config.SESSION_DAYS) || 30);
  const attempts = new Map();
  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  function limit(key, max, windowMs) {
    const now = Date.now();
    const entry = attempts.get(key);
    const current = entry && entry.expires > now ? entry : { count: 0, expires: now + windowMs };
    current.count += 1;
    attempts.set(key, current);
    return current.count > max;
  }
  const cleanup = setInterval(() => {
    for (const [key, entry] of attempts) if (entry.expires <= Date.now()) attempts.delete(key);
    pool.query('DELETE FROM sessions WHERE expires_at <= $1', [Date.now()]).catch(console.error);
  }, 60 * 60 * 1000);
  cleanup.unref();
  app.locals.stopCleanup = () => clearInterval(cleanup);
  async function sessionUser(req) {
    const token = (req.headers.cookie || '').split(';').map(value => value.trim())
      .find(value => value.startsWith('hem_vardag_session='))?.slice('hem_vardag_session='.length);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const { rows } = await pool.query(
      `SELECT users.*, sessions.id AS session_id FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = $1 AND sessions.expires_at > $2`, [token, Date.now()]);
    return rows[0] || null;
  }
  async function requireUser(req, res, next) {
    try {
      req.user = await sessionUser(req);
      if (!req.user) return res.status(401).json({ error: 'Du måste vara inloggad.' });
      next();
    } catch (error) { next(error); }
  }
  const authenticated = handler => [requireUser, asyncRoute(handler)];
  const admin = handler => authenticated(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administratörsbehörighet krävs.' });
    await handler(req, res);
  });
  function cookie(res, value, age) {
    res.setHeader('Set-Cookie', `hem_vardag_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`);
  }
  async function createSession(id, res) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, id, Date.now() + sessionsDays * 86400000]);
    cookie(res, token, sessionsDays * 86400);
  }
  async function readHousehold(userId) {
    const { rows: [shared] } = await pool.query(
      `SELECT h.*, m.role FROM household_members m JOIN household_spaces h ON h.id = m.household_id
       WHERE m.user_id = $1`, [userId]);
    if (!shared) {
      const { rows: [personal] } = await pool.query('SELECT * FROM household_data WHERE user_id = $1', [userId]);
      return { data: personal ? JSON.parse(personal.data_json) : null, household: null, version: `p:${userId}:${personal?.version || 0}` };
    }
    const { rows: members } = await pool.query(
      `SELECT u.email, m.role FROM household_members m JOIN users u ON u.id = m.user_id
       WHERE m.household_id = $1 ORDER BY u.id`, [shared.id]);
    return {
      data: JSON.parse(shared.data_json), version: `h:${shared.id}:${shared.version}`,
      household: { name: shared.name, role: shared.role, inviteCode: shared.role === 'owner' ? shared.invite_code : '', members }
    };
  }
  async function transaction(action) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
    let origin;
    try { origin = new URL(req.headers.origin).origin; } catch { return res.status(403).json({ error: 'Ogiltigt ursprung.' }); }
    const allowed = [`${req.protocol}://${req.get('host')}`];
    if (config.APP_URL) allowed.push(new URL(config.APP_URL).origin);
    if (!allowed.includes(origin)) return res.status(403).json({ error: 'Anropet blockerades av säkerhetsskäl.' });
    next();
  });
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'vardag.html')));
  const publicFiles = new Set(['vardag.html', 'vardag.css', 'vardag.js', 'admin.html', 'admin.js', 'sw.js', 'manifest.webmanifest']);
  app.get('/:file', (req, res, next) => {
    if (!publicFiles.has(req.params.file)) return next();
    res.sendFile(path.join(__dirname, req.params.file));
  });
  app.get('/api/health', asyncRoute(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, application: 'hem-vardag', database: 'postgresql' });
  }));
  app.get('/api/me', asyncRoute(async (req, res) => {
    const user = await sessionUser(req);
    res.json({ user: user ? publicUser(user) : null });
  }));
  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    if (config.ALLOW_REGISTRATION === 'false') return res.status(403).json({ error: 'Registrering är avstängd. Kontakta administratören.' });
    if (limit(`register:${req.ip}`, 10, 3600000)) return res.status(429).json({ error: 'För många registreringar. Vänta en timme.' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!validEmail(email) || password.length < 8 || password.length > 256) return res.status(400).json({ error: 'Ange giltig e-post och ett lösenord med 8–256 tecken.' });
    const { salt, hash } = hashPassword(password);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, password_hash, password_salt, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, role`, [email, hash, salt, allUsersAdmin(config) ? 'admin' : 'user']);
    if (!user) return res.status(409).json({ error: 'Det finns redan ett konto med den e-posten.' });
    await createSession(user.id, res);
    res.status(201).json({ user: publicUser(user) });
  }));
  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    if (limit(`login:${req.ip}`, 8, 15 * 60000)) return res.status(429).json({ error: 'För många försök. Vänta 15 minuter.' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (password.length > 256) return res.status(400).json({ error: 'Lösenordet är för långt.' });
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const salt = user?.password_salt || '0'.repeat(32);
    const actual = Buffer.from(hashPassword(password, salt).hash, 'hex');
    const expected = Buffer.from(user?.password_hash || '0'.repeat(128), 'hex');
    if (!user || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'E-posten eller lösenordet stämmer inte.' });
    attempts.delete(`login:${req.ip}`);
    await createSession(user.id, res);
    res.json({ user: publicUser(user) });
  }));
  app.post('/api/auth/logout', ...authenticated(async (req, res) => {
    await pool.query('DELETE FROM sessions WHERE id = $1', [req.user.session_id]);
    cookie(res, '', 0);
    res.status(204).end();
  }));
  app.post('/api/auth/change-password', ...authenticated(async (req, res) => {
    const password = String(req.body?.newPassword || '');
    const current = String(req.body?.currentPassword || '');
    if (password.length < 8 || password.length > 256 || current.length > 256) return res.status(400).json({ error: 'Lösenord måste ha 8–256 tecken.' });
    if (!crypto.timingSafeEqual(Buffer.from(hashPassword(current, req.user.password_salt).hash, 'hex'), Buffer.from(req.user.password_hash, 'hex'))) {
      return res.status(401).json({ error: 'Nuvarande lösenord stämmer inte.' });
    }
    const { salt, hash } = hashPassword(password);
    await transaction(async client => {
      await client.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3', [hash, salt, req.user.id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.user.session_id]);
    });
    res.json({ ok: true });
  }));
  app.get('/api/household', ...authenticated(async (req, res) => res.json(await readHousehold(req.user.id))));
  app.put('/api/household', ...authenticated(async (req, res) => {
    const data = req.body?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Ogiltigt hushållsformat.' });
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > dataLimit) return res.status(413).json({ error: 'Listorna får vara högst 1 MB.' });
    const version = await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      const { rows: [membership] } = await client.query('SELECT household_id FROM household_members WHERE user_id = $1', [req.user.id]);
      if (membership) {
        const { rows: [space] } = await client.query('SELECT version FROM household_spaces WHERE id = $1 FOR UPDATE', [membership.household_id]);
        if (req.body.version !== `h:${membership.household_id}:${space.version}`) return null;
        await client.query('UPDATE household_spaces SET data_json = $1, version = version + 1 WHERE id = $2', [json, membership.household_id]);
        return `h:${membership.household_id}:${space.version + 1}`;
      }
      const { rows: [personal] } = await client.query('SELECT version FROM household_data WHERE user_id = $1 FOR UPDATE', [req.user.id]);
      if (req.body.version !== `p:${req.user.id}:${personal?.version || 0}`) return null;
      await client.query(
        `INSERT INTO household_data (user_id, data_json, version) VALUES ($1, $2, 1)
         ON CONFLICT (user_id) DO UPDATE SET data_json = EXCLUDED.data_json, version = household_data.version + 1`, [req.user.id, json]);
      return `p:${req.user.id}:${(personal?.version || 0) + 1}`;
    });
    if (!version) return res.status(409).json({ error: 'Listorna har ändrats på en annan enhet. Ta en Backup av dina ändringar och ladda om sidan innan du sparar igen.' });
    res.json({ saved: true, version });
  }));
  for (const mode of ['create', 'join']) {
    app.post(`/api/household/${mode}`, ...authenticated(async (req, res) => {
      const code = String(req.body?.code || '').trim().toUpperCase();
      if (mode === 'join' && (limit(`join:${req.user.id}`, 10, 15 * 60000) || !/^[A-F0-9]{12}$/.test(code))) {
        return res.status(400).json({ error: 'Kontrollera koden (12 tecken). Vid många försök: vänta 15 minuter.' });
      }
      const result = await transaction(async client => {
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
        const { rows } = await client.query('SELECT household_id FROM household_members WHERE user_id = $1', [req.user.id]);
        if (rows.length) return { error: 'Du tillhör redan ett hushåll.', status: 409 };
        const { rows: [personal] } = await client.query('SELECT data_json FROM household_data WHERE user_id = $1 FOR UPDATE', [req.user.id]);
        let space;
        if (mode === 'create') {
          const name = String(req.body?.name || '').trim().slice(0, 80);
          if (!name) return { error: 'Ange ett namn på hushållet.', status: 400 };
          const { rows: [created] } = await client.query(
            `INSERT INTO household_spaces (name, invite_code, owner_id, data_json) VALUES ($1, $2, $3, $4) RETURNING id`,
            [name, crypto.randomBytes(6).toString('hex').toUpperCase(), req.user.id, personal?.data_json || '{}']);
          space = created;
        } else {
          const { rows: [found] } = await client.query('SELECT * FROM household_spaces WHERE invite_code = $1 FOR UPDATE', [code]);
          if (!found) return { error: 'Hushållskoden hittades inte.', status: 404 };
          const { rows: [size] } = await client.query('SELECT COUNT(*) AS count FROM household_members WHERE household_id = $1', [found.id]);
          if (Number(size.count) >= 10) return { error: 'Hushållet är fullt (10 personer).', status: 409 };
          const json = JSON.stringify(mergeHouseholdData(JSON.parse(found.data_json), JSON.parse(personal?.data_json || '{}')));
          if (Buffer.byteLength(json) > dataLimit) return { error: 'De sammanslagna listorna överstiger 1 MB.', status: 413 };
          await client.query('UPDATE household_spaces SET data_json = $1, version = version + 1 WHERE id = $2', [json, found.id]);
          space = found;
        }
        await client.query('INSERT INTO household_members (household_id, user_id, role) VALUES ($1, $2, $3)',
          [space.id, req.user.id, mode === 'create' ? 'owner' : 'member']);
        await client.query('DELETE FROM household_data WHERE user_id = $1', [req.user.id]);
        return {};
      });
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.status(mode === 'create' ? 201 : 200).json(await readHousehold(req.user.id));
    }));
  }
  app.get('/api/admin/users', ...admin(async (req, res) => {
    const { rows } = await pool.query('SELECT id, email, role, created_at FROM users ORDER BY id');
    res.json({ users: rows, allUsersAdmin: allUsersAdmin(config) });
  }));
  app.post('/api/admin/users/:id/role', ...admin(async (req, res) => {
    const id = Number(req.params.id);
    const role = req.body?.role;
    if (!Number.isSafeInteger(id) || id < 1 || !['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Ange giltigt konto och rollen admin eller user.' });
    }
    if (allUsersAdmin(config) && role === 'user') {
      return res.status(409).json({ error: 'Alla konton ska vara administratörer. Stäng av ALL_USERS_ADMIN innan du ändrar till vanlig användare.' });
    }
    const result = await transaction(async client => {
      // Lock in a stable order so simultaneous demotions cannot remove every admin.
      const { rows: users } = await client.query('SELECT id, role FROM users ORDER BY id FOR UPDATE');
      if (users.find(user => user.id === req.user.id)?.role !== 'admin') {
        return { status: 403, error: 'Administratörsbehörighet krävs.' };
      }
      const target = users.find(user => user.id === id);
      if (!target) return { status: 404, error: 'Kontot hittades inte.' };
      if (target.role === 'admin' && role === 'user' && users.filter(user => user.role === 'admin').length === 1) {
        return { status: 409, error: 'Den sista administratören kan inte göras till vanlig användare. Utse en annan administratör först.' };
      }
      const { rows: [user] } = await client.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role', [role, id]);
      return { status: 200, user };
    });
    res.status(result.status).json(result.error ? { error: result.error } : { user: result.user });
  }));
  app.post('/api/admin/users/:id/password', ...admin(async (req, res) => {
    const id = Number(req.params.id);
    const password = String(req.body?.newPassword || '');
    if (!Number.isSafeInteger(id) || password.length < 8 || password.length > 256) return res.status(400).json({ error: 'Ange giltigt konto och lösenord (8–256 tecken).' });
    const { salt, hash } = hashPassword(password);
    const found = await transaction(async client => {
      const result = await client.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3', [hash, salt, id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      return result.rowCount;
    });
    if (!found) return res.status(404).json({ error: 'Kontot hittades inte.' });
    res.json({ ok: true });
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API-adressen finns inte.' }));
  app.use((req, res) => res.status(404).send('Sidan finns inte.'));
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(error.status === 413 ? 413 : error.type === 'entity.parse.failed' ? 400 : 500)
      .json({ error: error.status === 413 ? 'För stor begäran.' : error.type === 'entity.parse.failed' ? 'Ogiltig JSON.' : 'Ett serverfel uppstod. Kontrollera serverloggen.' });
  });
  return app;
}

if (require.main === module) {
  const pool = new Pool({
    host: process.env.DB_HOST || 'db', port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'hemvardag', password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hemvardag', connectionTimeoutMillis: 5000
  });
  initDatabase(pool).then(() => {
    const app = createApp(pool);
    app.listen(Number(process.env.PORT || 3000), () => console.log('Hem & vardag är igång.'));
  }).catch(error => { console.error('Databasen kunde inte startas:', error); process.exitCode = 1; pool.end(); });
}
module.exports = { createApp, initDatabase, mergeHouseholdData };
