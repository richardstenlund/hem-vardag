const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { createApp, initDatabase } = require('../server');
const OTPAuth = require('otpauth');

async function fixture(t, config = {}) {
  config = { ALL_USERS_ADMIN: 'false', INVITE_ONLY: 'false', ...config };
  const recovery = new Map();
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await initDatabase(pool, config);
  const app = createApp(pool, config);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    app.locals.stopCleanup();
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  async function request(path, { method = 'GET', body, cookie, origin } = {}) {
    if (path === '/api/auth/login' && body && recovery.has(body.email) && !body.code) {
      body = { ...body, code: recovery.get(body.email).shift() };
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text;
    const result = { status: response.status, json, cookie: response.headers.get('set-cookie')?.split(';')[0], response };
    if (['/api/auth/login', '/api/auth/register'].includes(path) && result.cookie && json.user?.requiresTwoFactorSetup) {
      const setup = await request('/api/security/setup', { method: 'POST', cookie: result.cookie, body: { password: body.password } });
      assert.equal(setup.status, 200);
      const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret) }).generate();
      const enabled = await request('/api/security/enable', { method: 'POST', cookie: result.cookie, body: { code } });
      assert.equal(enabled.status, 200);
      recovery.set(json.user.email, enabled.json.recoveryCodes);
      result.json = (await request('/api/me', { cookie: result.cookie })).json;
    }
    return result;
  }
  async function register(email) {
    const result = await request('/api/auth/register', { method: 'POST', body: { email, password: 'Testpassword123!' } });
    assert.equal(result.status, 201);
    assert.match(result.cookie, /^hem_vardag_session=/);
    return result;
  }
  return { app, pool, request, register };
}

test('standalone home, health, assets and no training API', async t => {
  const { request } = await fixture(t);
  assert.match((await request('/')).json, /<title>Hem & vardag<\/title>/);
  assert.doesNotMatch((await request('/')).json, /Formkurva|MyHome/);
  assert.equal((await request('/api/health')).json.application, 'hem-vardag');
  for (const asset of ['/vardag.js', '/vardag.css', '/admin.js', '/sw.js']) assert.equal((await request(asset)).status, 200);
  for (const route of ['/MyHome.html', '/server.js', '/.env', '/api/workouts', '/api/measurements']) assert.equal((await request(route)).status, 404);
  assert.equal((await request('/api/household')).status, 401);
});

test('register, login, logout, change password and account isolation', async t => {
  const { request, register } = await fixture(t);
  const alice = await register('alice@example.test');
  const bob = await register('bob@example.test');
  assert.equal((await request('/api/me', { cookie: alice.cookie })).json.user.email, 'alice@example.test');
  const first = await request('/api/household', { cookie: alice.cookie });
  const data = { notes: [{ id: 'note-1', title: 'Privat anteckning' }] };
  const saved = await request('/api/household', { method: 'PUT', cookie: alice.cookie, body: { data, version: first.json.version } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await request('/api/household', { cookie: alice.cookie })).json.data, data);
  assert.equal((await request('/api/household', { cookie: bob.cookie })).json.data, null);
  assert.equal((await request('/api/household', { method: 'PUT', cookie: alice.cookie, body: { data: {}, version: first.json.version } })).status, 409);
  const changed = await request('/api/auth/change-password', { method: 'POST', cookie: alice.cookie, body: { currentPassword: 'Testpassword123!', newPassword: 'Newpassword123!' } });
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: alice.cookie })).status, 204);
  assert.equal((await request('/api/me', { cookie: alice.cookie })).json.user, null);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'alice@example.test', password: 'Testpassword123!' } })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'alice@example.test', password: 'Newpassword123!' } })).status, 200);
});

test('household creation, join, merging and stale-write protection', async t => {
  const { request, register } = await fixture(t);
  const alice = await register('alice@example.test');
  const bob = await register('bob@example.test');
  const outsider = await register('outside@example.test');
  for (const [person, title] of [[alice, 'Recept'], [bob, 'Inköp']]) {
    const current = await request('/api/household', { cookie: person.cookie });
    const saved = await request('/api/household', { method: 'PUT', cookie: person.cookie, body: {
      data: { notes: [{ id: person.json.user.email, title }] }, version: current.json.version
    } });
    assert.equal(saved.status, 200);
  }
  const created = await request('/api/household/create', { method: 'POST', cookie: alice.cookie, body: { name: 'Vårt hem' } });
  assert.equal(created.status, 201);
  assert.match(created.json.household.inviteCode, /^[A-F0-9]{12}$/);
  const joined = await request('/api/household/join', { method: 'POST', cookie: bob.cookie, body: { code: created.json.household.inviteCode } });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.data.notes.length, 2);
  assert.equal(joined.json.household.inviteCode, '');
  assert.equal(joined.json.household.members.length, 2);
  assert.equal((await request('/api/household', { cookie: outsider.cookie })).json.data, null);
  assert.equal((await request('/api/household', { method: 'PUT', cookie: alice.cookie, body: { data: {}, version: created.json.version } })).status, 409);
  const latest = await request('/api/household', { cookie: alice.cookie });
  const saved = await request('/api/household', { method: 'PUT', cookie: alice.cookie, body: { data: { notes: [] }, version: latest.json.version } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await request('/api/household', { cookie: bob.cookie })).json.data, { notes: [] });
  assert.equal((await request('/api/household/create', { method: 'POST', cookie: bob.cookie, body: { name: 'Dublett' } })).status, 409);
});

test('admin bootstrap is usable and does not reset password on restart', async t => {
  const config = { ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Adminpassword123!' };
  const { pool, request, register } = await fixture(t, config);
  const loggedIn = await request('/api/auth/login', { method: 'POST', body: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD } });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.json.user.role, 'admin');
  const ordinary = await register('person@example.test');
  assert.equal((await request('/api/admin/users', { cookie: ordinary.cookie })).status, 403);
  assert.equal((await request('/api/admin/users', { cookie: loggedIn.cookie })).json.users.length, 2);
  assert.equal((await request(`/api/admin/users/${ordinary.json.user.id}/password`, {
    method: 'POST', cookie: loggedIn.cookie, body: { newPassword: 'Resetpassword123!' }
  })).status, 200);
  assert.equal((await request('/api/me', { cookie: ordinary.cookie })).json.user, null);
  await request('/api/auth/change-password', { method: 'POST', cookie: loggedIn.cookie, body: { currentPassword: config.ADMIN_PASSWORD, newPassword: 'Changedadmin123!' } });
  // pg-mem cannot plan CREATE TABLE IF NOT EXISTS for tables already created.
  const existingSchema = { query: (sql, values) => sql.startsWith('CREATE TABLE IF NOT EXISTS')
    ? Promise.resolve({ rows: [] }) : pool.query(sql, values) };
  await initDatabase(existingSchema, config);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: config.ADMIN_EMAIL, password: 'Changedadmin123!' } })).status, 200);
});

test('only admins can change roles and the last admin is protected', async t => {
  const { request, register } = await fixture(t, { ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Adminpassword123!' });
  const admin = await request('/api/auth/login', { method: 'POST', body: { email: 'admin@example.test', password: 'Adminpassword123!' } });
  const person = await register('person@example.test');
  const rolePath = id => `/api/admin/users/${id}/role`;
  const change = (id, role, cookie = admin.cookie) => request(rolePath(id), { method: 'POST', cookie, body: { role } });
  assert.equal((await change(person.json.user.id, 'admin', person.cookie)).status, 403);
  assert.equal((await request(rolePath(person.json.user.id), { method: 'POST', body: { role: 'admin' } })).status, 401);
  assert.equal((await change(admin.json.user.id, 'user')).status, 409);
  const promoted = await change(person.json.user.id, 'admin');
  assert.equal(promoted.status, 200);
  assert.deepEqual(promoted.json.user, { id: person.json.user.id, email: person.json.user.email, role: 'admin' });
  const setup = await request('/api/security/setup', { method: 'POST', cookie: person.cookie, body: { password: 'Testpassword123!' } });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret) }).generate();
  assert.equal((await request('/api/security/enable', { method: 'POST', cookie: person.cookie, body: { code } })).status, 200);
  assert.equal((await change(person.json.user.id, 'owner')).status, 400);
  assert.equal((await change('invalid', 'admin')).status, 400);
  assert.equal((await change(0, 'admin')).status, 400);
  assert.equal((await change(9999, 'admin')).status, 404);
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user.role, 'admin');
  assert.equal((await request('/api/admin/users', { cookie: person.cookie })).status, 200);
  assert.equal((await change(admin.json.user.id, 'user', person.cookie)).status, 200);
  assert.equal((await request('/api/admin/users', { cookie: admin.cookie })).status, 403);
  assert.equal((await change(person.json.user.id, 'user', admin.cookie)).status, 403);
  assert.equal((await change(person.json.user.id, 'user', person.cookie)).status, 409);
  assert.equal((await change(admin.json.user.id, 'admin', person.cookie)).status, 200);
  assert.equal((await change(person.json.user.id, 'user', person.cookie)).status, 200);
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user.role, 'user');
  assert.equal((await request('/api/admin/users', { cookie: person.cookie })).status, 403);
  assert.equal((await change(admin.json.user.id, 'user')).status, 409);
  assert.equal((await change(admin.json.user.id, 'admin')).status, 200);
});

test('optional all-admin mode promotes existing users and grants new accounts admin access', async t => {
  const { pool, request, register } = await fixture(t, { ALL_USERS_ADMIN: 'true' });
  const account = await register('everyone@example.test');
  assert.equal(account.json.user.role, 'admin');
  const list = await request('/api/admin/users', { cookie: account.cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.allUsersAdmin, true);
  assert.equal((await request(`/api/admin/users/${account.json.user.id}/role`, {
    method: 'POST', cookie: account.cookie, body: { role: 'user' }
  })).status, 409);
  await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [account.json.user.id]);
  const existingSchema = { query: (sql, values) => sql.startsWith('CREATE TABLE IF NOT EXISTS')
    ? Promise.resolve({ rows: [] }) : pool.query(sql, values) };
  await initDatabase(existingSchema, { ALL_USERS_ADMIN: 'true' });
  assert.equal((await request('/api/me', { cookie: account.cookie })).json.user.role, 'admin');
  const next = await register('next@example.test');
  assert.equal(next.json.user.role, 'admin');
  assert.equal((await request(`/api/admin/users/${next.json.user.id}/password`, {
    method: 'POST', cookie: account.cookie, body: { newPassword: 'Resetpassword123!' }
  })).status, 200);
});

test('manual roles are the default and survive restart after all-admin mode is disabled', async t => {
  const { pool, request, register } = await fixture(t, { ALL_USERS_ADMIN: undefined });
  const person = await register('manual@example.test');
  assert.equal(person.json.user.role, 'user');
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [person.json.user.id]);
  const setup = await request('/api/security/setup', { method: 'POST', cookie: person.cookie, body: { password: 'Testpassword123!' } });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret) }).generate();
  assert.equal((await request('/api/security/enable', { method: 'POST', cookie: person.cookie, body: { code } })).status, 200);
  const existingSchema = { query: (sql, values) => sql.startsWith('CREATE TABLE IF NOT EXISTS')
    ? Promise.resolve({ rows: [] }) : pool.query(sql, values) };
  await initDatabase(existingSchema, {});
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user.role, 'admin');
  assert.equal((await request('/api/admin/users', { cookie: person.cookie })).json.allUsersAdmin, false);
  const next = await register('nextmanual@example.test');
  assert.equal(next.json.user.role, 'user');
  assert.equal((await request(`/api/admin/users/${next.json.user.id}/role`, {
    method: 'POST', cookie: person.cookie, body: { role: 'admin' }
  })).status, 200);
  const nextSetup = await request('/api/security/setup', { method: 'POST', cookie: next.cookie, body: { password: 'Testpassword123!' } });
  const nextCode = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(nextSetup.json.secret) }).generate();
  assert.equal((await request('/api/security/enable', { method: 'POST', cookie: next.cookie, body: { code: nextCode } })).status, 200);
  assert.equal((await request(`/api/admin/users/${person.json.user.id}/role`, {
    method: 'POST', cookie: next.cookie, body: { role: 'user' }
  })).status, 200);
  await initDatabase(existingSchema, {});
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user.role, 'user');
  assert.equal((await request('/api/me', { cookie: next.cookie })).json.user.role, 'admin');
});

test('account removal checks permissions and preserves the last and bootstrap admins', async t => {
  const { pool, request, register } = await fixture(t, { ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Adminpassword123!' });
  const admin = await request('/api/auth/login', { method: 'POST', body: { email: 'admin@example.test', password: 'Adminpassword123!' } });
  const person = await register('delete@example.test');
  const remove = (id, email, cookie = admin.cookie) => request(`/api/admin/users/${id}`, {
    method: 'DELETE', cookie, body: { email }
  });
  assert.equal((await request(`/api/admin/users/${person.json.user.id}`, { method: 'DELETE' })).status, 401);
  assert.equal((await remove(person.json.user.id, person.json.user.email, person.cookie)).status, 403);
  assert.equal((await remove('bad', person.json.user.email)).status, 400);
  assert.equal((await remove(9999, 'missing@example.test')).status, 404);
  assert.equal((await remove(person.json.user.id, 'wrong@example.test')).status, 400);
  const current = await request('/api/household', { cookie: person.cookie });
  await request('/api/household', { method: 'PUT', cookie: person.cookie,
    body: { data: { notes: [{ id: 'private', title: 'Privat' }] }, version: current.json.version } });
  assert.equal((await remove(admin.json.user.id, admin.json.user.email)).status, 409);
  await request(`/api/admin/users/${person.json.user.id}/role`, { method: 'POST', cookie: admin.cookie, body: { role: 'admin' } });
  const setup = await request('/api/security/setup', { method: 'POST', cookie: person.cookie, body: { password: 'Testpassword123!' } });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret) }).generate();
  assert.equal((await request('/api/security/enable', { method: 'POST', cookie: person.cookie, body: { code } })).status, 200);
  assert.equal((await remove(admin.json.user.id, admin.json.user.email)).status, 409);
  assert.equal((await remove(person.json.user.id, person.json.user.email, person.cookie)).status, 200);
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user, null);
  assert.equal((await pool.query('SELECT * FROM household_data WHERE user_id = $1', [person.json.user.id])).rows.length, 0);
  assert.equal((await pool.query('SELECT * FROM sessions WHERE user_id = $1', [person.json.user.id])).rows.length, 0);
  assert.equal((await remove(person.json.user.id, person.json.user.email)).status, 404);
});

test('transfer ownership before deleting an owner; keep shared lists when deleting members', async t => {
  const { request, register } = await fixture(t, { ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Adminpassword123!' });
  const admin = await request('/api/auth/login', { method: 'POST', body: { email: 'admin@example.test', password: 'Adminpassword123!' } });
  const owner = await register('owner@example.test');
  const member = await register('member@example.test');
  const outsider = await register('outsider@example.test');
  const created = await request('/api/household/create', { method: 'POST', cookie: owner.cookie, body: { name: 'Delat hem' } });
  const remove = account => request(`/api/admin/users/${account.json.user.id}`, {
    method: 'DELETE', cookie: admin.cookie, body: { email: account.json.user.email }
  });
  const transfer = (newOwnerId, cookie = admin.cookie, id = owner.json.user.id) =>
    request(`/api/admin/users/${id}/household-owner`, { method: 'POST', cookie, body: { newOwnerId } });
  assert.equal((await remove(owner)).status, 409);
  assert.equal((await transfer(member.json.user.id, owner.cookie)).status, 403);
  assert.equal((await transfer('bad')).status, 400);
  assert.equal((await transfer(owner.json.user.id)).status, 400);
  assert.equal((await transfer(member.json.user.id)).status, 400);
  assert.equal((await transfer(member.json.user.id, admin.cookie, outsider.json.user.id)).status, 404);
  await request('/api/household/join', { method: 'POST', cookie: member.cookie, body: { code: created.json.household.inviteCode } });
  await request('/api/household/join', { method: 'POST', cookie: outsider.cookie, body: { code: created.json.household.inviteCode } });
  const latest = await request('/api/household', { cookie: owner.cookie });
  const data = { notes: [{ id: 'keep', title: 'Behåll delat' }] };
  await request('/api/household', { method: 'PUT', cookie: owner.cookie, body: { data, version: latest.json.version } });
  const list = await request('/api/admin/users', { cookie: admin.cookie });
  const account = list.json.users.find(user => user.id === owner.json.user.id);
  assert.equal(account.ownedHousehold.members.length, 2);
  assert.ok(account.deletionBlockedReason);
  assert.equal((await transfer(member.json.user.id)).status, 200);
  const newOwner = await request('/api/household', { cookie: member.cookie });
  assert.equal(newOwner.json.household.role, 'owner');
  assert.equal(newOwner.json.household.inviteCode, created.json.household.inviteCode);
  assert.deepEqual(newOwner.json.data, data);
  const oldOwner = await request('/api/household', { cookie: owner.cookie });
  assert.equal(oldOwner.json.household.role, 'member');
  assert.equal(oldOwner.json.household.inviteCode, '');
  assert.equal((await remove(owner)).status, 200);
  assert.equal((await remove(outsider)).status, 200);
  assert.equal((await request('/api/me', { cookie: owner.cookie })).json.user, null);
  const kept = await request('/api/household', { cookie: member.cookie });
  assert.deepEqual(kept.json.data, data);
  assert.equal(kept.json.household.members.length, 1);
  assert.equal((await remove(member)).status, 409);
});

test('invalid input, external origins, registration toggle and payload limits', async t => {
  const { request, register } = await fixture(t);
  const alice = await register('alice@example.test');
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { email: 'bad', password: 'short' } })).status, 400);
  assert.equal((await request('/api/household', { method: 'PUT', cookie: alice.cookie, body: { data: [] } })).status, 400);
  assert.equal((await request('/api/household', { method: 'PUT', cookie: alice.cookie, body: { data: { text: 'a'.repeat(1024 * 1024) } } })).status, 413);
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: alice.cookie, origin: 'https://not-this-site.test' })).status, 403);
  const privateApp = await fixture(t, { ALLOW_REGISTRATION: 'false' });
  assert.equal((await privateApp.request('/api/auth/register', { method: 'POST', body: { email: 'x@example.test', password: 'Password123!' } })).status, 403);
});
