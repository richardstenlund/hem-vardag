const crypto = require('node:crypto');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sessionId = token => digest(token).slice(0, 32);
const totp = (secret, email) => new OTPAuth.TOTP({
  issuer: 'Hem & vardag', label: email, algorithm: 'SHA1', digits: 6, period: 30,
  secret: OTPAuth.Secret.fromBase32(secret)
});
const passwordMatches = (password, user, hashPassword) => {
  if (typeof password !== 'string' || password.length > 256) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, user.password_salt).hash, 'hex'),
    Buffer.from(user.password_hash, 'hex'));
};

async function initSecurity(pool) {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true');
  await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified BOOLEAN NOT NULL DEFAULT false');
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device VARCHAR(200) NOT NULL DEFAULT ''");
  await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await pool.query(`CREATE TABLE IF NOT EXISTS user_security (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    totp_secret TEXT, pending_secret TEXT, pending_expires BIGINT,
    recovery_json TEXT NOT NULL DEFAULT '[]', last_counter BIGINT NOT NULL DEFAULT -1
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS registration_invites (
    id SERIAL PRIMARY KEY, email VARCHAR(254) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL, used_at TIMESTAMPTZ, revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit (
    id SERIAL PRIMARY KEY, actor_email VARCHAR(254) NOT NULL, target_email VARCHAR(254) NOT NULL,
    action VARCHAR(50) NOT NULL, detail VARCHAR(200) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function audit(client, actor, target, action, detail = '') {
  await client.query('INSERT INTO admin_audit (actor_email, target_email, action, detail) VALUES ($1, $2, $3, $4)',
    [actor, target, action, detail]);
}

async function consumeFactor(client, userId, code) {
  if (typeof code !== 'string' || code.length > 80) return false;
  const { rows: [security] } = await client.query('SELECT * FROM user_security WHERE user_id = $1 FOR UPDATE', [userId]);
  if (!security?.totp_secret) return false;
  const token = code.trim();
  if (/^\d{6}$/.test(token)) {
    const timestamp = Date.now();
    const delta = totp(security.totp_secret, '').validate({ token, timestamp, window: 1 });
    if (delta === null) return false;
    const counter = Math.floor(timestamp / 30000) + delta;
    if (counter <= Number(security.last_counter)) return false;
    await client.query('UPDATE user_security SET last_counter = $1 WHERE user_id = $2', [counter, userId]);
    return true;
  }
  const hash = digest(token.toUpperCase());
  const codes = JSON.parse(security.recovery_json);
  const index = codes.indexOf(hash);
  if (index === -1) return false;
  codes.splice(index, 1);
  await client.query('UPDATE user_security SET recovery_json = $1 WHERE user_id = $2', [JSON.stringify(codes), userId]);
  return true;
}

function mountSecurity(app, tools) {
  const { pool, authenticated, admin, transaction, adminTransaction, limit,
    passwordCheck, cookie, config } = tools;
  const secureAction = handler => authenticated(async (req, res) => {
    if (limit(`security:${req.user.id}`, 20, 15 * 60000)) return res.status(429).json({ error: 'För många säkerhetsförsök. Vänta 15 minuter.' });
    await handler(req, res);
  });
  app.get('/api/security', ...authenticated(async (req, res) => {
    const { rows: [security] } = await pool.query('SELECT recovery_json FROM user_security WHERE user_id = $1', [req.user.id]);
    res.json({
      enabled: Boolean(req.user.totp_secret), required: req.user.role === 'admin',
      verified: req.user.mfa_verified, recoveryRemaining: security ? JSON.parse(security.recovery_json).length : 0
    });
  }));
  app.post('/api/security/setup', ...secureAction(async (req, res) => {
    if (!passwordCheck(req.body?.password, req.user)) return res.status(401).json({ error: 'Lösenordet stämmer inte.' });
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const result = await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      const { rows: [existing] } = await client.query('SELECT totp_secret FROM user_security WHERE user_id = $1', [req.user.id]);
      if (existing?.totp_secret && !await consumeFactor(client, req.user.id, req.body?.code)) return false;
      await client.query(`INSERT INTO user_security (user_id, pending_secret, pending_expires) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET pending_secret = EXCLUDED.pending_secret, pending_expires = EXCLUDED.pending_expires`,
      [req.user.id, secret, Date.now() + 10 * 60000]);
      return true;
    });
    if (!result) return res.status(401).json({ error: 'Ange en giltig appkod eller återställningskod för att byta autentiseringsnyckel.' });
    const uri = totp(secret, req.user.email).toString();
    res.json({ secret, qrCode: await QRCode.toDataURL(uri), expiresInMinutes: 10 });
  }));
  app.post('/api/security/enable', ...secureAction(async (req, res) => {
    const codes = Array.from({ length: 10 }, () => crypto.randomBytes(8).toString('hex').toUpperCase());
    const ok = await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      const { rows: [security] } = await client.query('SELECT * FROM user_security WHERE user_id = $1 FOR UPDATE', [req.user.id]);
      if (!security?.pending_secret || Number(security.pending_expires) <= Date.now()) return false;
      const token = req.body?.code;
      const timestamp = Date.now();
      if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return false;
      const delta = totp(security.pending_secret, '').validate({ token, timestamp, window: 1 });
      if (delta === null) return false;
      await client.query(`UPDATE user_security SET totp_secret = pending_secret, pending_secret = NULL,
        pending_expires = NULL, recovery_json = $1, last_counter = $2 WHERE user_id = $3`,
      [JSON.stringify(codes.map(digest)), Math.floor(timestamp / 30000) + delta, req.user.id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.user.session_id]);
      await client.query('UPDATE sessions SET mfa_verified = true WHERE id = $1', [req.user.session_id]);
      await audit(client, req.user.email, req.user.email, security.totp_secret ? 'two_factor_changed' : 'two_factor_enabled');
      return true;
    });
    if (!ok) return res.status(400).json({ error: 'Fel kod eller utgången inställning. Skapa en ny nyckel vid behov.' });
    res.json({ recoveryCodes: codes });
  }));
  app.post('/api/security/verify', ...secureAction(async (req, res) => {
    const ok = await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      if (!await consumeFactor(client, req.user.id, req.body?.code)) return false;
      await client.query('UPDATE sessions SET mfa_verified = true WHERE id = $1', [req.user.session_id]);
      return true;
    });
    if (!ok) return res.status(401).json({ error: 'Koden stämmer inte eller har redan använts.' });
    res.json({ ok: true });
  }));
  app.post('/api/security/disable', ...secureAction(async (req, res) => {
    if (!passwordCheck(req.body?.password, req.user)) return res.status(401).json({ error: 'Lösenordet stämmer inte.' });
    const result = await transaction(async client => {
      const { rows: [user] } = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      if (user.role === 'admin') return { status: 409, error: 'Administratörer måste ha tvåstegsverifiering.' };
      if (!await consumeFactor(client, req.user.id, req.body?.code)) return { status: 401, error: 'Koden stämmer inte eller har redan använts.' };
      await client.query('DELETE FROM user_security WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.user.session_id]);
      await audit(client, req.user.email, req.user.email, 'two_factor_disabled');
      return { status: 200 };
    });
    res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
  }));
  app.post('/api/security/recovery-codes', ...secureAction(async (req, res) => {
    if (!passwordCheck(req.body?.password, req.user)) return res.status(401).json({ error: 'Lösenordet stämmer inte.' });
    const codes = Array.from({ length: 10 }, () => crypto.randomBytes(8).toString('hex').toUpperCase());
    const ok = await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      if (!await consumeFactor(client, req.user.id, req.body?.code)) return false;
      await client.query('UPDATE user_security SET recovery_json = $1 WHERE user_id = $2', [JSON.stringify(codes.map(digest)), req.user.id]);
      await audit(client, req.user.email, req.user.email, 'recovery_codes_replaced');
      return true;
    });
    if (!ok) return res.status(401).json({ error: 'Koden stämmer inte eller har redan använts.' });
    res.json({ recoveryCodes: codes });
  }));
  app.get('/api/security/sessions', ...authenticated(async (req, res) => {
    const { rows } = await pool.query('SELECT id, device, created_at, expires_at FROM sessions WHERE user_id = $1 AND expires_at > $2 ORDER BY created_at DESC',
      [req.user.id, Date.now()]);
    res.json({ sessions: rows.map(item => ({
      id: sessionId(item.id), current: item.id === req.user.session_id, device: item.device || 'Äldre inloggning',
      createdAt: item.created_at, expiresAt: Number(item.expires_at)
    })) });
  }));
  app.delete('/api/security/sessions/:id', ...authenticated(async (req, res) => {
    const { rows } = await pool.query('SELECT id FROM sessions WHERE user_id = $1', [req.user.id]);
    const target = rows.find(item => sessionId(item.id) === req.params.id);
    if (!target) return res.status(404).json({ error: 'Inloggningen hittades inte.' });
    await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [target.id, req.user.id]);
    if (target.id === req.user.session_id) cookie(res, '', 0);
    res.json({ ok: true });
  }));
  app.post('/api/security/sessions/revoke-others', ...authenticated(async (req, res) => {
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.user.session_id]);
    res.json({ ok: true });
  }));
  app.post('/api/admin/users/:id/active', ...admin(async (req, res) => {
    const id = Number(req.params.id);
    const active = req.body?.active;
    if (!Number.isSafeInteger(id) || id < 1 || typeof active !== 'boolean') return res.status(400).json({ error: 'Ange giltigt konto och kontostatus.' });
    const result = await adminTransaction(req, async (client, users) => {
      const target = users.find(user => user.id === id);
      if (!target) return { status: 404, error: 'Kontot hittades inte.' };
      if (!active && target.active && target.role === 'admin' && users.filter(user => user.role === 'admin' && user.active).length === 1) {
        return { status: 409, error: 'Den sista aktiva administratören kan inte inaktiveras.' };
      }
      await client.query('UPDATE users SET active = $1 WHERE id = $2', [active, id]);
      if (!active) await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await audit(client, req.user.email, target.email, active ? 'account_enabled' : 'account_disabled');
      return { status: 200 };
    });
    if (!result.error && id === req.user.id && !active) cookie(res, '', 0);
    res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
  }));
  app.get('/api/admin/invites', ...admin(async (req, res) => {
    const { rows } = await pool.query('SELECT id, email, expires_at, used_at, revoked, created_at FROM registration_invites ORDER BY id DESC LIMIT 100');
    res.json({ invites: rows, inviteOnly: config.INVITE_ONLY !== 'false', registrationEnabled: config.ALLOW_REGISTRATION !== 'false' });
  }));
  app.post('/api/admin/invites', ...admin(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!tools.validEmail(email)) return res.status(400).json({ error: 'Ange en giltig e-postadress.' });
    if (config.ALLOW_REGISTRATION === 'false') return res.status(409).json({ error: 'Registrering är avstängd. Aktivera ALLOW_REGISTRATION innan du bjuder in.' });
    const token = crypto.randomBytes(24).toString('hex');
    const result = await adminTransaction(req, async (client, users) => {
      if (users.some(user => user.email === email)) return { status: 409, error: 'Kontot finns redan.' };
      await client.query('UPDATE registration_invites SET revoked = true WHERE email = $1 AND used_at IS NULL', [email]);
      const { rows: [invite] } = await client.query('INSERT INTO registration_invites (email, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id, email, expires_at',
        [email, digest(token), Date.now() + 7 * 86400000]);
      await audit(client, req.user.email, email, 'invitation_created');
      return { status: 201, invite };
    });
    res.status(result.status).json(result.error ? { error: result.error } : { invite: result.invite, token });
  }));
  app.delete('/api/admin/invites/:id', ...admin(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Ogiltig inbjudan.' });
    const result = await adminTransaction(req, async client => {
      const { rows: [invite] } = await client.query('SELECT email FROM registration_invites WHERE id = $1 FOR UPDATE', [id]);
      if (!invite) return { status: 404, error: 'Inbjudan hittades inte.' };
      await client.query('UPDATE registration_invites SET revoked = true WHERE id = $1', [id]);
      await audit(client, req.user.email, invite.email, 'invitation_revoked');
      return { status: 200 };
    });
    res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
  }));
  app.get('/api/admin/audit', ...admin(async (req, res) => {
    const before = req.query.before === undefined ? 2147483647 : Number(req.query.before);
    if (!Number.isSafeInteger(before) || before < 1) return res.status(400).json({ error: 'Ogiltig loggsida.' });
    const { rows } = await pool.query('SELECT * FROM admin_audit WHERE id < $1 ORDER BY id DESC LIMIT 50', [before]);
    res.json({ events: rows, nextBefore: rows.length === 50 ? rows[rows.length - 1].id : null });
  }));
}

module.exports = { initSecurity, mountSecurity, consumeFactor, audit, digest, passwordMatches };
