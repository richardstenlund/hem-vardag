const { test } = require('node:test');
const assert = require('node:assert/strict');
const OTPAuth = require('otpauth');
const { newDb } = require('pg-mem');
const { createApp, initDatabase } = require('../server');
const { digest } = require('../account-security');

async function fixture(t, config = {}) {
  const settings = { ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Adminpassword123!', ...config };
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await initDatabase(pool, settings);
  const app = createApp(pool, settings);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(async () => {
    app.locals.stopCleanup();
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  async function request(path, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Security test browser', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    return {
      status: response.status, json: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text,
      cookie: response.headers.get('set-cookie')?.split(';')[0], response
    };
  }
  const post = (path, body, cookie) => request(path, { method: 'POST', body, cookie });
  const login = (email, password, code) => post('/api/auth/login', { email, password, code });
  const register = (email, inviteToken) => post('/api/auth/register', { email, password: 'Testpassword123!', inviteToken });
  async function enroll(cookie, password) {
    const setup = await post('/api/security/setup', { password }, cookie);
    assert.equal(setup.status, 200);
    assert.match(setup.json.qrCode, /^data:image\/png;base64,/);
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret) }).generate();
    const enabled = await post('/api/security/enable', { code }, cookie);
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json.recoveryCodes.length, 10);
    return { secret: setup.json.secret, code, codes: enabled.json.recoveryCodes };
  }
  async function admin() {
    const result = await login(settings.ADMIN_EMAIL, settings.ADMIN_PASSWORD);
    assert.equal(result.status, 200);
    const factor = await enroll(result.cookie, settings.ADMIN_PASSWORD);
    return { ...result, factor };
  }
  return { pool, request, post, login, register, enroll, admin };
}

test('admins must enroll and MFA login cannot be bypassed; recovery codes work once', async t => {
  const { pool, request, post, login, enroll } = await fixture(t);
  const first = await login('admin@example.test', 'Adminpassword123!');
  assert.equal(first.json.user.requiresTwoFactorSetup, true);
  assert.equal((await request('/api/admin/users', { cookie: first.cookie })).status, 403);
  const oldSession = await login('admin@example.test', 'Adminpassword123!');
  assert.equal((await post('/api/security/setup', { password: 'wrong' }, first.cookie)).status, 401);
  const factor = await enroll(first.cookie, 'Adminpassword123!');
  assert.equal((await request('/api/me', { cookie: oldSession.cookie })).json.user, null);
  const listed = await request('/api/admin/users', { cookie: first.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.users[0].twoFactorEnabled, true);
  assert.doesNotMatch(JSON.stringify(listed.json), new RegExp(factor.secret));
  assert.equal((await post('/api/security/disable', { password: 'Adminpassword123!', code: factor.codes[0] }, first.cookie)).status, 409);
  const challenge = await login('admin@example.test', 'Adminpassword123!');
  assert.deepEqual(challenge.json, { requiresTwoFactor: true });
  assert.equal(challenge.cookie, undefined);
  assert.equal((await login('admin@example.test', 'Adminpassword123!', factor.code)).status, 401);
  assert.equal((await login('admin@example.test', 'Adminpassword123!', 'not-a-valid-code')).status, 401);
  const recovered = await login('admin@example.test', 'Adminpassword123!', factor.codes[0]);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.user.twoFactorEnabled, true);
  assert.equal((await login('admin@example.test', 'Adminpassword123!', factor.codes[0])).status, 401);
  const state = await request('/api/security', { cookie: recovered.cookie });
  assert.equal(state.json.recoveryRemaining, 9);
  const stored = (await pool.query('SELECT recovery_json FROM user_security')).rows[0].recovery_json;
  assert.doesNotMatch(stored, new RegExp(factor.codes[1]));
  assert.ok(JSON.parse(stored).includes(digest(factor.codes[1])));
});

test('invite-only registration binds email, expires, revokes and consumes tokens without leaking them', async t => {
  const { pool, request, post, register, admin } = await fixture(t);
  const owner = await admin();
  assert.equal((await register('person@example.test')).status, 403);
  assert.equal((await post('/api/admin/invites', { email: 'bad' }, owner.cookie)).status, 400);
  const invite = await post('/api/admin/invites', { email: 'Person@example.test' }, owner.cookie);
  assert.equal(invite.status, 201);
  assert.match(invite.json.token, /^[a-f0-9]{48}$/);
  assert.equal(invite.json.invite.email, 'person@example.test');
  assert.equal((await register('other@example.test', invite.json.token)).status, 403);
  assert.equal((await register('person@example.test', 'bad')).status, 403);
  const registered = await register('person@example.test', invite.json.token);
  assert.equal(registered.status, 201);
  assert.equal(registered.json.user.role, 'user');
  assert.equal((await register('person@example.test', invite.json.token)).status, 403);
  assert.equal((await request('/api/admin/invites', { cookie: registered.cookie })).status, 403);
  const expired = await post('/api/admin/invites', { email: 'expired@example.test' }, owner.cookie);
  await pool.query('UPDATE registration_invites SET expires_at = $1 WHERE id = $2', [Date.now() - 1, expired.json.invite.id]);
  assert.equal((await register('expired@example.test', expired.json.token)).status, 403);
  const revoked = await post('/api/admin/invites', { email: 'revoked@example.test' }, owner.cookie);
  assert.equal((await request(`/api/admin/invites/${revoked.json.invite.id}`, { method: 'DELETE', cookie: owner.cookie })).status, 200);
  assert.equal((await register('revoked@example.test', revoked.json.token)).status, 403);
  const replaced = await post('/api/admin/invites', { email: 'replace@example.test' }, owner.cookie);
  const newer = await post('/api/admin/invites', { email: 'replace@example.test' }, owner.cookie);
  assert.notEqual(replaced.json.token, newer.json.token);
  assert.equal((await register('replace@example.test', replaced.json.token)).status, 403);
  const list = await request('/api/admin/invites', { cookie: owner.cookie });
  assert.equal(list.json.inviteOnly, true);
  assert.doesNotMatch(JSON.stringify(list.json), /token_hash/);
  assert.doesNotMatch(JSON.stringify(list.json), new RegExp(newer.json.token));
  assert.equal((await post('/api/admin/invites', { email: 'person@example.test' }, owner.cookie)).status, 409);
  const closed = await fixture(t, { ALLOW_REGISTRATION: 'false' });
  const closedAdmin = await closed.admin();
  assert.equal((await closed.post('/api/admin/invites', { email: 'blocked@example.test' }, closedAdmin.cookie)).status, 409);
  assert.equal((await closed.register('blocked@example.test', newer.json.token)).status, 403);
});

test('account suspension revokes access without losing data; last active admin stays available', async t => {
  const { request, post, login, register, admin, enroll } = await fixture(t, { INVITE_ONLY: 'false' });
  const owner = await admin();
  const person = await register('person@example.test');
  const first = await request('/api/household', { cookie: person.cookie });
  const data = { notes: [{ id: 'keep', title: 'Behåll' }] };
  await request('/api/household', { method: 'PUT', cookie: person.cookie, body: { data, version: first.json.version } });
  const activePath = `/api/admin/users/${person.json.user.id}/active`;
  assert.equal((await post(activePath, { active: false }, person.cookie)).status, 403);
  assert.equal((await post(activePath, { active: 'false' }, owner.cookie)).status, 400);
  assert.equal((await post(activePath, { active: false }, owner.cookie)).status, 200);
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user, null);
  assert.equal((await request('/api/household', { cookie: person.cookie })).status, 401);
  assert.equal((await login('person@example.test', 'Testpassword123!')).status, 401);
  assert.equal((await post(activePath, { active: true }, owner.cookie)).status, 200);
  const restored = await login('person@example.test', 'Testpassword123!');
  assert.equal(restored.status, 200);
  assert.deepEqual((await request('/api/household', { cookie: restored.cookie })).json.data, data);
  assert.equal((await post(`/api/admin/users/${owner.json.user.id}/active`, { active: false }, owner.cookie)).status, 409);
  await post(`/api/admin/users/${person.json.user.id}/role`, { role: 'admin' }, owner.cookie);
  assert.equal((await request('/api/admin/users', { cookie: restored.cookie })).status, 403);
  await enroll(restored.cookie, 'Testpassword123!');
  assert.equal((await post(activePath, { active: false }, owner.cookie)).status, 200);
  assert.equal((await post(`/api/admin/users/${owner.json.user.id}/active`, { active: false }, owner.cookie)).status, 409);
  assert.equal((await post(`/api/admin/users/${owner.json.user.id}/role`, { role: 'user' }, owner.cookie)).status, 409);
});

test('sessions are account-scoped, hide cookie tokens and support single and all-other revocation', async t => {
  const { request, post, login, register } = await fixture(t, { INVITE_ONLY: 'false' });
  const person = await register('person@example.test');
  const other = await register('other@example.test');
  const second = await login('person@example.test', 'Testpassword123!');
  let sessions = await request('/api/security/sessions', { cookie: person.cookie });
  assert.equal(sessions.json.sessions.length, 2);
  assert.equal(sessions.json.sessions.filter(item => item.current).length, 1);
  assert.doesNotMatch(JSON.stringify(sessions.json), new RegExp(person.cookie.split('=')[1]));
  const target = sessions.json.sessions.find(item => !item.current);
  assert.equal((await request(`/api/security/sessions/${target.id}`, { method: 'DELETE', cookie: other.cookie })).status, 404);
  assert.equal((await request(`/api/security/sessions/${target.id}`, { method: 'DELETE', cookie: person.cookie })).status, 200);
  assert.equal((await request('/api/me', { cookie: second.cookie })).json.user, null);
  const third = await login('person@example.test', 'Testpassword123!');
  assert.equal((await post('/api/security/sessions/revoke-others', {}, person.cookie)).status, 200);
  assert.equal((await request('/api/me', { cookie: third.cookie })).json.user, null);
  assert.equal((await request('/api/me', { cookie: other.cookie })).json.user.email, 'other@example.test');
  sessions = await request('/api/security/sessions', { cookie: person.cookie });
  assert.equal((await request(`/api/security/sessions/${sessions.json.sessions[0].id}`, { method: 'DELETE', cookie: person.cookie })).status, 200);
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user, null);
});

test('optional MFA supports legacy-session verification, code replacement and disable without bypass', async t => {
  const { pool, request, post, register, enroll } = await fixture(t, { INVITE_ONLY: 'false' });
  const person = await register('person@example.test');
  const factor = await enroll(person.cookie, 'Testpassword123!');
  await pool.query('UPDATE sessions SET mfa_verified = false WHERE user_id = $1', [person.json.user.id]);
  assert.equal((await request('/api/household', { cookie: person.cookie })).status, 403);
  assert.equal((await request('/api/security/sessions', { cookie: person.cookie })).status, 403);
  assert.equal((await post('/api/security/verify', { code: 'bad' }, person.cookie)).status, 401);
  assert.equal((await post('/api/security/verify', { code: factor.codes[0] }, person.cookie)).status, 200);
  assert.equal((await request('/api/household', { cookie: person.cookie })).status, 200);
  const renewed = await post('/api/security/recovery-codes', { password: 'Testpassword123!', code: factor.codes[1] }, person.cookie);
  assert.equal(renewed.status, 200);
  assert.equal(renewed.json.recoveryCodes.length, 10);
  assert.equal((await post('/api/security/disable', { password: 'Testpassword123!', code: factor.codes[2] }, person.cookie)).status, 401);
  assert.equal((await post('/api/security/disable', { password: 'wrong', code: renewed.json.recoveryCodes[0] }, person.cookie)).status, 401);
  assert.equal((await post('/api/security/disable', { password: 'Testpassword123!', code: renewed.json.recoveryCodes[0] }, person.cookie)).status, 200);
  assert.equal((await request('/api/security', { cookie: person.cookie })).json.enabled, false);
});

test('audit records actor, target and action; survives removal and never includes credentials', async t => {
  const { request, post, register, admin } = await fixture(t, { INVITE_ONLY: 'false' });
  const owner = await admin();
  const person = await register('audit@example.test');
  await post(`/api/admin/users/${person.json.user.id}/role`, { role: 'user' }, owner.cookie);
  await post(`/api/admin/users/${person.json.user.id}/password`, { newPassword: 'NeverLogThisPassword!' }, owner.cookie);
  await request(`/api/admin/users/${person.json.user.id}`, { method: 'DELETE', cookie: owner.cookie, body: { email: person.json.user.email } });
  const log = await request('/api/admin/audit', { cookie: owner.cookie });
  assert.equal(log.status, 200);
  for (const action of ['role_changed', 'password_reset', 'account_deleted']) {
    assert.ok(log.json.events.some(item => item.action === action && item.actor_email === 'admin@example.test' && item.target_email === 'audit@example.test'));
  }
  assert.doesNotMatch(JSON.stringify(log.json), /NeverLogThisPassword|Adminpassword123|recovery_json|totp_secret/);
  assert.equal((await request('/api/admin/audit?before=bad', { cookie: owner.cookie })).status, 400);
  assert.equal((await request('/api/admin/audit')).status, 401);
});

test('admins can recover with codes and replace their authenticator without disabling MFA', async t => {
  const { pool, request, post, admin } = await fixture(t);
  const owner = await admin();
  assert.equal((await post('/api/security/setup', { password: 'Adminpassword123!' }, owner.cookie)).status, 401);
  const setup = await post('/api/security/setup', {
    password: 'Adminpassword123!', code: owner.factor.codes[0]
  }, owner.cookie);
  assert.equal(setup.status, 200);
  assert.notEqual(setup.json.secret, owner.factor.secret);
  const before = (await pool.query('SELECT totp_secret FROM user_security')).rows[0];
  assert.equal(before.totp_secret, owner.factor.secret);
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret) }).generate();
  assert.equal((await post('/api/security/enable', { code }, owner.cookie)).status, 200);
  assert.equal((await request('/api/security', { cookie: owner.cookie })).json.enabled, true);
  assert.equal((await pool.query('SELECT totp_secret FROM user_security')).rows[0].totp_secret, setup.json.secret);
  assert.equal((await post('/api/security/verify', { code: owner.factor.codes[1] }, owner.cookie)).status, 401);
});

test('expired enrollment is rejected and audit pagination returns bounded non-overlapping pages', async t => {
  const { pool, request, post, register, admin } = await fixture(t, { INVITE_ONLY: 'false' });
  const owner = await admin();
  const person = await register('expire@example.test');
  const setup = await post('/api/security/setup', { password: 'Testpassword123!' }, person.cookie);
  await pool.query('UPDATE user_security SET pending_expires = $1 WHERE user_id = $2', [Date.now() - 1, person.json.user.id]);
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret) }).generate();
  assert.equal((await post('/api/security/enable', { code }, person.cookie)).status, 400);
  assert.equal((await request('/api/security', { cookie: person.cookie })).json.enabled, false);
  for (let i = 0; i < 55; i += 1) {
    await pool.query("INSERT INTO admin_audit (actor_email, target_email, action) VALUES ('admin@example.test', 'expire@example.test', 'account_enabled')");
  }
  const first = await request('/api/admin/audit', { cookie: owner.cookie });
  assert.equal(first.json.events.length, 50);
  const next = await request(`/api/admin/audit?before=${first.json.nextBefore}`, { cookie: owner.cookie });
  assert.equal(next.json.events.length, 6);
  assert.equal(next.json.nextBefore, null);
  assert.ok(next.json.events.every(event => event.id < first.json.nextBefore));
});
