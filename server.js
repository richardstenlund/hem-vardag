const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');
const { initSecurity, mountSecurity, consumeFactor, audit, passwordMatches } = require('./account-security');

const validEmail = value => typeof value === 'string' && value.length <= 254 && /^\S+@\S+\.\S+$/.test(value);
const validUsername = value => typeof value === 'string'
  && ((value.length >= 2 && value.length <= 64 && /^[\p{L}\p{N}._-]+$/u.test(value)) || validEmail(value));
const accountName = body => String(body?.username ?? body?.email ?? '').trim().toLowerCase();
const bootstrapName = config => String(config.ADMIN_USERNAME || config.ADMIN_EMAIL || '').trim().toLowerCase();
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt, hash: crypto.scryptSync(password, salt, 64).toString('hex')
});
// Keep legacy email columns and response fields so existing accounts, audits and clients survive upgrades.
const publicUser = user => ({
  id: user.id, username: user.email, email: user.email, role: user.role,
  twoFactorEnabled: Boolean(user.totp_secret), requiresTwoFactorSetup: false
});
const dataLimit = 1024 * 1024;

async function initDatabase(pool, config = process.env) {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE,
    password_hash CHAR(128) NOT NULL, password_salt CHAR(32) NOT NULL,
    role VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'reader')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
  await pool.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user', 'reader'))");
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
  await initSecurity(pool);
  const email = bootstrapName(config);
  const password = String(config.ADMIN_PASSWORD || '');
  if (email || password) {
    if (!validUsername(email) || password.length < 12 || password.length > 256) {
      throw new Error('ADMIN_USERNAME måste vara giltigt och ADMIN_PASSWORD ha 12–256 tecken.');
    }
    const { salt, hash } = hashPassword(password);
    await pool.query(
      `INSERT INTO users (email, password_hash, password_salt, role) VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO NOTHING`, [email, hash, salt]);
  }
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
      `SELECT users.*, sessions.id AS session_id, sessions.mfa_verified, s.totp_secret
       FROM sessions JOIN users ON users.id = sessions.user_id LEFT JOIN user_security s ON s.user_id = users.id
       WHERE sessions.id = $1 AND sessions.expires_at > $2 AND users.active = true`, [token, Date.now()]);
    return rows[0] || null;
  }
  async function requireUser(req, res, next) {
    try {
      req.user = await sessionUser(req);
      if (!req.user) return res.status(401).json({ error: 'Du måste vara inloggad.' });
      if (req.user.totp_secret && !req.user.mfa_verified
        && !['/api/security', '/api/security/verify', '/api/auth/logout'].includes(req.path)) {
        return res.status(403).json({ error: 'Bekräfta tvåstegsverifieringen under Kontosäkerhet.' });
      }
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
  async function createSession(id, res, req, verified = false, client = pool) {
    const token = crypto.randomBytes(32).toString('hex');
    await client.query('INSERT INTO sessions (id, user_id, expires_at, device, mfa_verified) VALUES ($1, $2, $3, $4, $5)',
      [token, id, Date.now() + sessionsDays * 86400000, String(req.get('user-agent') || 'Okänd enhet').slice(0, 200), verified]);
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
  async function adminTransaction(req, action) {
    return transaction(async client => {
      // Serialize account removal and suspension, including concurrent admin requests.
      const { rows: users } = await client.query('SELECT id, email, role, active FROM users ORDER BY id FOR UPDATE');
      if (!users.some(user => user.id === req.user.id && user.role === 'admin' && user.active)) {
        return { status: 403, error: 'Administratörsbehörighet krävs.' };
      }
      const { rows: [session] } = await client.query('SELECT mfa_verified FROM sessions WHERE id = $1', [req.user.session_id]);
      const { rows: [security] } = await client.query('SELECT totp_secret FROM user_security WHERE user_id = $1', [req.user.id]);
      if (!session || (security?.totp_secret && !session.mfa_verified)) {
        return { status: 403, error: 'Inloggningen är inte längre giltig. Logga in igen.' };
      }
      return action(client, users);
    });
  }
  async function insertAccount(client, users, email, password) {
    if (users.some(user => user.email === email)) return { status: 409, error: 'Det finns redan ett konto med det användarnamnet.' };
    const { salt, hash } = hashPassword(password);
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash, password_salt, role) VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO NOTHING RETURNING id, email, role`, [email, hash, salt]);
    return user ? { status: 201, user } : { status: 409, error: 'Det finns redan ett konto med det användarnamnet.' };
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
  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'vardag.html'));
  });
  const publicFiles = new Set(['vardag.html', 'vardag.css', 'vardag.js', 'admin.html', 'admin.js', 'security.html', 'security.js', 'sw.js', 'manifest.webmanifest']);
  app.get('/:file', (req, res, next) => {
    if (!publicFiles.has(req.params.file)) return next();
    res.setHeader('Cache-Control', 'no-cache');
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
    const email = accountName(req.body);
    const password = String(req.body?.password || '');
    if (!validUsername(email) || password.length < 8 || password.length > 256) return res.status(400).json({ error: 'Ange ett användarnamn med 2–64 bokstäver, siffror, punkt, bindestreck eller understreck och ett lösenord med 8–256 tecken.' });
    const result = await transaction(async client => {
      const { rows: users } = await client.query('SELECT id, email FROM users ORDER BY id FOR UPDATE');
      const result = await insertAccount(client, users, email, password);
      if (result.user) await createSession(result.user.id, res, req, false, client);
      return result;
    });
    res.status(result.status).json(result.error ? { error: result.error } : { user: publicUser(result.user) });
  }));
  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    if (limit(`login:${req.ip}`, 8, 15 * 60000)) return res.status(429).json({ error: 'För många försök. Vänta 15 minuter.' });
    const email = accountName(req.body);
    const password = String(req.body?.password || '');
    if (password.length > 256) return res.status(400).json({ error: 'Lösenordet är för långt.' });
    if (limit(`login-email:${email}`, 15, 15 * 60000)) return res.status(429).json({ error: 'För många försök för kontot. Vänta 15 minuter.' });
    const result = await transaction(async client => {
      const { rows: [user] } = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email]);
      const checkUser = user || { password_salt: '0'.repeat(32), password_hash: '0'.repeat(128) };
      if (!passwordMatches(password, checkUser, hashPassword) || !user?.active) {
        return { status: 401, error: 'Inloggningen misslyckades. Kontrollera uppgifterna eller kontakta administratören.' };
      }
      const { rows: [security] } = await client.query('SELECT totp_secret FROM user_security WHERE user_id = $1', [user.id]);
      user.totp_secret = security?.totp_secret;
      if (user.totp_secret) {
        if (!req.body?.code) return { status: 200, requiresTwoFactor: true };
        if (!await consumeFactor(client, user.id, req.body.code)) return { status: 401, error: 'Koden stämmer inte eller har redan använts.' };
      }
      await createSession(user.id, res, req, Boolean(user.totp_secret), client);
      return { status: 200, user };
    });
    if (result.user) {
      attempts.delete(`login:${req.ip}`);
      attempts.delete(`login-email:${email}`);
    }
    res.status(result.status).json(result.error ? { error: result.error }
      : result.requiresTwoFactor ? { requiresTwoFactor: true } : { user: publicUser(result.user) });
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
      const { rows: [writer] } = await client.query('SELECT id, role, active FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      if (!writer?.active || writer.role === 'reader') return false;
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
    if (version === false) return res.status(403).json({ error: 'Läsare kan bara läsa listorna. Be en administratör ändra din roll.' });
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
        const { rows: [member] } = await client.query('SELECT id, role, active FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
        if (!member?.active || (member.role === 'reader' && mode === 'create')) {
          return { status: 403, error: 'Läsare kan gå med i ett hushåll men inte skapa ett.' };
        }
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
          if (member.role !== 'reader') {
            const json = JSON.stringify(mergeHouseholdData(JSON.parse(found.data_json), JSON.parse(personal?.data_json || '{}')));
            if (Buffer.byteLength(json) > dataLimit) return { error: 'De sammanslagna listorna överstiger 1 MB.', status: 413 };
            await client.query('UPDATE household_spaces SET data_json = $1, version = version + 1 WHERE id = $2', [json, found.id]);
          }
          space = found;
        }
        await client.query('INSERT INTO household_members (household_id, user_id, role) VALUES ($1, $2, $3)',
          [space.id, req.user.id, mode === 'create' ? 'owner' : 'member']);
        if (member.role !== 'reader') await client.query('DELETE FROM household_data WHERE user_id = $1', [req.user.id]);
        return {};
      });
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.status(mode === 'create' ? 201 : 200).json(await readHousehold(req.user.id));
    }));
  }
  app.get('/api/admin/users', ...admin(async (req, res) => {
    const { rows } = await pool.query('SELECT id, email, role, active, created_at FROM users ORDER BY id');
    const { rows: security } = await pool.query('SELECT user_id, totp_secret FROM user_security');
    const { rows: spaces } = await pool.query('SELECT id, name, owner_id FROM household_spaces ORDER BY id');
    const { rows: members } = await pool.query(
      'SELECT m.household_id, u.id, u.email FROM household_members m JOIN users u ON u.id = m.user_id ORDER BY u.id');
    const bootstrapEmail = bootstrapName(config);
    const users = rows.map(user => {
      const space = spaces.find(item => item.owner_id === user.id);
      const lastAdmin = user.active && user.role === 'admin' && rows.filter(item => item.role === 'admin' && item.active).length === 1;
      return {
        ...user,
        username: user.email,
        twoFactorEnabled: Boolean(security.find(item => item.user_id === user.id)?.totp_secret),
        deletionBlockedReason: lastAdmin ? 'Den sista administratören kan inte tas bort.'
          : user.email === bootstrapEmail ? 'Ändra administratörens användarnamn i serverns inställningar först, annars återskapas kontot vid omstart.'
          : space ? 'Överför hushållets ägarskap innan kontot tas bort.' : '',
        ownedHousehold: space ? {
          id: space.id, name: space.name,
          members: members.filter(member => member.household_id === space.id && member.id !== user.id)
            .map(member => ({ id: member.id, email: member.email }))
        } : null
      };
    });
    res.json({ users, allUsersAdmin: false });
  }));
  app.post('/api/admin/users', ...admin(async (req, res) => {
    const email = accountName(req.body);
    const password = String(req.body?.password || '');
    if (!validUsername(email) || password.length < 8 || password.length > 256) {
      return res.status(400).json({ error: 'Ange ett användarnamn med 2–64 bokstäver, siffror, punkt, bindestreck eller understreck och ett lösenord med 8–256 tecken.' });
    }
    const result = await adminTransaction(req, async (client, users) => {
      const result = await insertAccount(client, users, email, password);
      if (result.user) await audit(client, req.user.email, result.user.email, 'account_created');
      return result;
    });
    res.status(result.status).json(result.error ? { error: result.error } : { user: publicUser(result.user) });
  }));
  app.post('/api/admin/users/:id/role', ...admin(async (req, res) => {
    const id = Number(req.params.id);
    const role = req.body?.role;
    if (!Number.isSafeInteger(id) || id < 1 || !['admin', 'user', 'reader'].includes(role)) {
      return res.status(400).json({ error: 'Välj ett giltigt konto och rollen administratör, användare eller läsare.' });
    }
    const result = await adminTransaction(req, async (client, users) => {
      const target = users.find(user => user.id === id);
      if (!target) return { status: 404, error: 'Kontot hittades inte.' };
      if (target.role === role) return { status: 200 };
      if (target.role === 'admin' && role !== 'admin' && target.active && users.filter(user => user.active && user.role === 'admin').length === 1) {
        return { status: 409, error: 'Den sista aktiva administratören kan inte få en lägre roll.' };
      }
      await client.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
      await audit(client, req.user.email, target.email, 'role_changed', role);
      return { status: 200 };
    });
    res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
  }));
  app.post('/api/admin/users/:id/household-owner', ...admin(async (req, res) => {
    const id = Number(req.params.id);
    const newOwnerId = req.body?.newOwnerId;
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(newOwnerId) || newOwnerId < 1 || id === newOwnerId) {
      return res.status(400).json({ error: 'Välj en annan hushållsmedlem som ny ägare.' });
    }
    const result = await adminTransaction(req, async (client, users) => {
      if (!users.some(user => user.id === id)) return { status: 404, error: 'Kontot hittades inte.' };
      const { rows: [space] } = await client.query('SELECT id FROM household_spaces WHERE owner_id = $1 FOR UPDATE', [id]);
      if (!space) return { status: 404, error: 'Kontot äger inget hushåll.' };
      const { rows: [member] } = await client.query(
        'SELECT user_id FROM household_members WHERE household_id = $1 AND user_id = $2', [space.id, newOwnerId]);
      if (!member) return { status: 400, error: 'Den nya ägaren måste redan tillhöra hushållet.' };
      await client.query('UPDATE household_spaces SET owner_id = $1 WHERE id = $2', [newOwnerId, space.id]);
      await client.query("UPDATE household_members SET role = 'member' WHERE household_id = $1 AND user_id = $2", [space.id, id]);
      await client.query("UPDATE household_members SET role = 'owner' WHERE household_id = $1 AND user_id = $2", [space.id, newOwnerId]);
      await audit(client, req.user.email, users.find(user => user.id === id).email, 'household_owner_changed', users.find(user => user.id === newOwnerId).email);
      return { status: 200 };
    });
    res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
  }));
  app.delete('/api/admin/users/:id', ...admin(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Ange ett giltigt konto.' });
    const result = await adminTransaction(req, async (client, users) => {
      const target = users.find(user => user.id === id);
      if (!target) return { status: 404, error: 'Kontot hittades inte.' };
      if ((req.body?.username ?? req.body?.email) !== target.email) return { status: 400, error: 'Bekräfta kontots användarnamn för att ta bort det.' };
      if (target.active && target.role === 'admin' && users.filter(user => user.role === 'admin' && user.active).length === 1) {
        return { status: 409, error: 'Den sista administratören kan inte tas bort.' };
      }
      if (target.email === bootstrapName(config)) {
        return { status: 409, error: 'Ändra administratörens användarnamn i serverns inställningar först, annars återskapas kontot vid omstart.' };
      }
      const { rows: [space] } = await client.query('SELECT id FROM household_spaces WHERE owner_id = $1 FOR UPDATE', [id]);
      if (space) return { status: 409, error: 'Överför hushållets ägarskap till en annan medlem innan kontot tas bort.' };
      await client.query('DELETE FROM users WHERE id = $1', [id]);
      await audit(client, req.user.email, target.email, 'account_deleted');
      return { status: 200 };
    });
    if (!result.error && id === req.user.id) cookie(res, '', 0);
    res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
  }));
  app.post('/api/admin/users/:id/password', ...admin(async (req, res) => {
    const id = Number(req.params.id);
    const password = String(req.body?.newPassword || '');
    if (!Number.isSafeInteger(id) || password.length < 8 || password.length > 256) return res.status(400).json({ error: 'Ange giltigt konto och lösenord (8–256 tecken).' });
    const { salt, hash } = hashPassword(password);
    const result = await adminTransaction(req, async (client, users) => {
      const target = users.find(user => user.id === id);
      if (!target) return { status: 404, error: 'Kontot hittades inte.' };
      await client.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3', [hash, salt, id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await audit(client, req.user.email, target.email, 'password_reset');
      return { status: 200 };
    });
    res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
  }));
  mountSecurity(app, {
    pool, authenticated, admin, transaction, adminTransaction, limit, cookie,
    passwordCheck: (password, user) => passwordMatches(password, user, hashPassword)
  });
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
