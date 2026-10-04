const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { createApp, initDatabase } = require('../server');

async function fixture(t, config = {}) {
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
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text;
    const result = { status: response.status, json, cookie: response.headers.get('set-cookie')?.split(';')[0], response };
    return result;
  }
  async function register(email, role = 'user') {
    const result = await request('/api/auth/register', { method: 'POST', body: { email, password: 'Testpassword123!' } });
    assert.equal(result.status, 201);
    assert.match(result.cookie, /^hem_vardag_session=/);
    if (role !== 'user') {
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, result.json.user.id]);
      result.json.user.role = role;
    }
    return result;
  }
  return { app, pool, request, register };
}

test('standalone home, health, assets and no training API', async t => {
  const { request } = await fixture(t);
  assert.match((await request('/')).json, /<title>Hem & vardag<\/title>/);
  assert.doesNotMatch((await request('/')).json, /Formkurva|MyHome/);
  for (const route of ['/', '/vardag.html']) {
    const page = await request(route);
    assert.equal(page.response.headers.get('cache-control'), 'no-cache');
    assert.doesNotMatch(page.json, /invite-field|inviteToken|Kontoinbjudan/);
    assert.match(page.json, /id="register-button"/);
  }
  for (const route of ['/vardag.js', '/sw.js', '/admin.html', '/admin.js']) {
    assert.equal((await request(route)).response.headers.get('cache-control'), 'no-cache');
  }
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

test('admins create ordinary users without replacing their own session; users cannot administer accounts', async t => {
  const { request, register, pool } = await fixture(t);
  const alice = await register('alice@example.test', 'admin');
  const create = (cookie, email, password = 'Createdpassword123!') => request('/api/admin/users', {
    method: 'POST', cookie, body: { email, password }
  });
  assert.equal((await create(undefined, 'blocked@example.test')).status, 401);
  assert.equal((await create(alice.cookie, 'invalid name')).status, 400);
  assert.equal((await create(alice.cookie, 'short@example.test', 'short')).status, 400);
  assert.equal((await create(alice.cookie, 'long@example.test', 'x'.repeat(257))).status, 400);
  const bob = await create(alice.cookie, ' BOB@example.test ');
  assert.equal(bob.status, 201);
  assert.equal(bob.json.user.role, 'user');
  assert.equal(bob.json.user.email, 'bob@example.test');
  assert.equal(bob.cookie, undefined);
  assert.equal((await request('/api/me', { cookie: alice.cookie })).json.user.id, alice.json.user.id);
  assert.equal((await create(alice.cookie, 'bob@example.test')).status, 409);
  const login = await request('/api/auth/login', {
    method: 'POST', body: { email: 'bob@example.test', password: 'Createdpassword123!' }
  });
  assert.equal(login.status, 200);
  assert.equal((await request('/api/admin/users', { cookie: login.cookie })).status, 403);
  assert.equal((await create(login.cookie, 'blocked@example.test')).status, 403);
  const carol = await create(alice.cookie, 'carol@example.test');
  assert.equal(carol.status, 201);
  assert.equal((await request(`/api/admin/users/${carol.json.user.id}`, {
    method: 'DELETE', cookie: alice.cookie, body: { email: 'carol@example.test' }
  })).status, 200);
  const { rows } = await pool.query("SELECT * FROM admin_audit WHERE action = 'account_created'");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor_email, 'alice@example.test');
  assert.equal(rows[0].target_email, 'bob@example.test');
  assert.ok(!JSON.stringify(rows).includes('Createdpassword123!'));
});

test('admin account creation stays available with public registration closed', async t => {
  const { request } = await fixture(t, {
    ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Adminpassword123!', ALLOW_REGISTRATION: 'false'
  });
  const login = await request('/api/auth/login', {
    method: 'POST', body: { email: 'admin@example.test', password: 'Adminpassword123!' }
  });
  assert.equal((await request('/api/auth/register', {
    method: 'POST', body: { email: 'closed@example.test', password: 'Testpassword123!' }
  })).status, 403);
  const created = await request('/api/admin/users', {
    method: 'POST', cookie: login.cookie, body: { email: 'added@example.test', password: 'Testpassword123!' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.user.role, 'user');
});

test('usernames support registration, login, admin creation and deletion without email', async t => {
  const { request, pool } = await fixture(t);
  const post = (path, body, cookie) => request(path, { method: 'POST', body, cookie });
  const password = 'UsernamePassword123!';
  const registered = await post('/api/auth/register', { username: '  Räven_1  ', password });
  assert.equal(registered.status, 201);
  assert.equal(registered.json.user.username, 'räven_1');
  assert.equal(registered.json.user.role, 'user');
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [registered.json.user.id]);
  assert.equal((await post('/api/auth/register', { username: 'RÄVEN_1', password })).status, 409);
  for (const username of ['', 'a', 'x'.repeat(65), 'bad name', 'bad/name', '<script>']) {
    assert.equal((await post('/api/admin/users', { username, password }, registered.cookie)).status, 400, username);
  }
  const login = await post('/api/auth/login', { username: 'RÄVEN_1', password });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.id, registered.json.user.id);
  const next = await post('/api/admin/users', { username: 'ab', password }, login.cookie);
  assert.equal(next.status, 201);
  const long = await post('/api/admin/users', { username: 'x'.repeat(64), password }, login.cookie);
  assert.equal(long.status, 201);
  assert.equal((await request(`/api/admin/users/${next.json.user.id}`, {
    method: 'DELETE', cookie: login.cookie, body: { username: 'ab' }
  })).status, 200);
  assert.equal((await post('/api/auth/login', { username: 'ab', password })).status, 401);
});

test('username bootstrap preserves legacy accounts, sessions and lists on upgrade', async t => {
  const config = {};
  const { request, register, pool } = await fixture(t, config);
  const legacy = await register('old@example.test');
  const current = await request('/api/household', { cookie: legacy.cookie });
  const data = { notes: [{ id: 'kept', title: 'Keep legacy data' }] };
  await request('/api/household', {
    method: 'PUT', cookie: legacy.cookie, body: { data, version: current.json.version }
  });
  const existingSchema = { query: (sql, values) => sql.startsWith('CREATE TABLE IF NOT EXISTS')
    ? Promise.resolve({ rows: [] }) : pool.query(sql, values) };
  Object.assign(config, {
    ADMIN_USERNAME: 'richard', ADMIN_EMAIL: 'ignored@example.test', ADMIN_PASSWORD: 'BootstrapPassword123!'
  });
  await initDatabase(existingSchema, config);
  assert.equal((await request('/api/me', { cookie: legacy.cookie })).json.user.username, 'old@example.test');
  assert.deepEqual((await request('/api/household', { cookie: legacy.cookie })).json.data, data);
  const login = await request('/api/auth/login', {
    method: 'POST', body: { username: 'old@example.test', password: 'Testpassword123!' }
  });
  assert.equal(login.status, 200);
  const admin = await request('/api/auth/login', {
    method: 'POST', body: { username: 'Richard', password: 'BootstrapPassword123!' }
  });
  assert.equal(admin.status, 200);
  assert.equal(admin.json.user.username, 'richard');
  assert.equal((await request(`/api/admin/users/${admin.json.user.id}`, {
    method: 'DELETE', cookie: admin.cookie, body: { username: 'richard' }
  })).status, 409);
  assert.equal((await pool.query("SELECT id FROM users WHERE email = 'ignored@example.test'")).rows.length, 0);
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

test('roles apply immediately, protect the last active admin and retain household access', async t => {
  const { request, register } = await fixture(t, { ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Adminpassword123!' });
  const admin = await request('/api/auth/login', { method: 'POST', body: { email: 'admin@example.test', password: 'Adminpassword123!' } });
  const person = await register('person@example.test');
  const rolePath = id => `/api/admin/users/${id}/role`;
  const change = (id, role, cookie = admin.cookie) => request(rolePath(id), { method: 'POST', cookie, body: { role } });
  assert.equal((await change(person.json.user.id, 'admin', person.cookie)).status, 403);
  assert.equal((await change(person.json.user.id, 'admin')).status, 200);
  assert.equal((await request(rolePath(person.json.user.id), { method: 'POST', body: { role: 'admin' } })).status, 401);
  assert.equal((await change(9999, 'user')).status, 404);
  assert.equal((await change(person.json.user.id, 'invalid')).status, 400);
  assert.equal((await change('bad', 'user')).status, 400);
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user.role, 'admin');
  assert.equal((await request('/api/admin/users', { cookie: person.cookie })).status, 200);
  assert.equal((await change(person.json.user.id, 'user')).status, 200);
  assert.equal((await request('/api/admin/users', { cookie: admin.cookie })).status, 200);
  assert.equal((await change(person.json.user.id, 'admin', person.cookie)).status, 403);
  assert.equal((await request('/api/me', { cookie: person.cookie })).json.user.role, 'user');
  assert.equal((await request('/api/household', { cookie: person.cookie })).status, 200);
  assert.equal((await request('/api/admin/users', { cookie: person.cookie })).status, 403);
  assert.equal((await request('/api/admin/users', { method: 'POST', cookie: person.cookie,
    body: { username: 'blocked', password: 'Testpassword123!' } })).status, 403);
  assert.equal((await request(`/api/admin/users/${admin.json.user.id}`, {
    method: 'DELETE', cookie: person.cookie, body: { username: 'admin@example.test' }
  })).status, 403);
  const log = await request('/api/admin/audit', { cookie: admin.cookie });
  assert.ok(log.json.events.some(event => event.action === 'role_changed'
    && event.target_email === 'person@example.test' && event.detail === 'user'));
  assert.equal(person.json.user.requiresTwoFactorSetup, false);
  assert.equal((await change(admin.json.user.id, 'user')).status, 409);
  assert.equal((await request(`/api/admin/users/${admin.json.user.id}/password`, {
    method: 'POST', cookie: person.cookie, body: { newPassword: 'Anotherpassword123!' }
  })).status, 403);
  assert.equal((await change(person.json.user.id, 'admin')).status, 200);
  assert.equal((await request('/api/admin/users', { cookie: person.cookie })).status, 200);
  assert.equal((await request(`/api/admin/users/${person.json.user.id}/active`, {
    method: 'POST', cookie: admin.cookie, body: { active: false }
  })).status, 200);
  assert.equal((await change(admin.json.user.id, 'user')).status, 409);
  assert.equal((await change(person.json.user.id, 'user')).status, 200);
});

test('chosen roles survive restart even with legacy all-admin configuration', async t => {
  const { pool, request, register } = await fixture(t, { ALL_USERS_ADMIN: 'false', INVITE_ONLY: 'true' });
  const account = await register('everyone@example.test', 'admin');
  assert.equal(account.json.user.role, 'admin');
  const list = await request('/api/admin/users', { cookie: account.cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.allUsersAdmin, false);
  assert.equal((await request(`/api/admin/users/${account.json.user.id}/role`, {
    method: 'POST', cookie: account.cookie, body: { role: 'user' }
  })).status, 409);
  await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [account.json.user.id]);
  const existingSchema = { query: (sql, values) => sql.startsWith('CREATE TABLE IF NOT EXISTS')
    ? Promise.resolve({ rows: [] }) : pool.query(sql, values) };
  await initDatabase(existingSchema, { ALL_USERS_ADMIN: 'false' });
  assert.equal((await request('/api/me', { cookie: account.cookie })).json.user.role, 'user');
  const next = await register('next@example.test', 'admin');
  assert.equal(next.json.user.role, 'admin');
  assert.equal((await request(`/api/admin/users/${next.json.user.id}/password`, {
    method: 'POST', cookie: next.cookie, body: { newPassword: 'Resetpassword123!' }
  })).status, 200);
  await initDatabase(existingSchema, { ALL_USERS_ADMIN: 'true' });
  assert.equal((await request('/api/me', { cookie: account.cookie })).json.user.role, 'user');
});

test('upgrading the legacy role constraint enables readers without changing chosen roles', async t => {
  const { pool, register, request } = await fixture(t);
  const account = await register('legacy');
  await pool.query('ALTER TABLE users DROP CONSTRAINT users_role_check');
  await pool.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user'))");
  const existingSchema = { query: (sql, values) => sql.startsWith('CREATE TABLE IF NOT EXISTS')
    ? Promise.resolve({ rows: [] }) : pool.query(sql, values) };
  await initDatabase(existingSchema);
  await pool.query("UPDATE users SET role = 'reader' WHERE id = $1", [account.json.user.id]);
  await initDatabase(existingSchema);
  assert.equal((await request('/api/me', { cookie: account.cookie })).json.user.role, 'reader');
});

test('reader permissions block writes but allow joining without modifying shared or private data', async t => {
  const { request, register, pool } = await fixture(t);
  const owner = await register('owner', 'admin');
  const reader = await register('reader');
  const write = (account, data, version) => request('/api/household', {
    method: 'PUT', cookie: account.cookie, body: { data, version }
  });
  const role = value => request(`/api/admin/users/${reader.json.user.id}/role`, {
    method: 'POST', cookie: owner.cookie, body: { role: value }
  });
  const privateData = { notes: [{ id: 'private', title: 'Never merge me' }] };
  const first = await request('/api/household', { cookie: reader.cookie });
  assert.equal((await write(reader, privateData, first.json.version)).status, 200);
  const space = await request('/api/household/create', {
    method: 'POST', cookie: owner.cookie, body: { name: 'Our home' }
  });
  const sharedData = { tasks: [{ id: 'shared', title: 'Read only', completed: false }] };
  const saved = await write(owner, sharedData, space.json.version);
  assert.equal((await role('reader')).status, 200);
  const privateRead = await request('/api/household', { cookie: reader.cookie });
  assert.deepEqual(privateRead.json.data, privateData);
  assert.equal((await write(reader, {}, privateRead.json.version)).status, 403);
  assert.equal((await request('/api/household/create', {
    method: 'POST', cookie: reader.cookie, body: { name: 'Forbidden' }
  })).status, 403);
  const joined = await request('/api/household/join', {
    method: 'POST', cookie: reader.cookie, body: { code: space.json.household.inviteCode }
  });
  assert.equal(joined.status, 200);
  assert.deepEqual(joined.json.data, sharedData);
  assert.equal(joined.json.version, saved.json.version);
  assert.deepEqual(JSON.parse((await pool.query('SELECT data_json FROM household_data WHERE user_id = $1',
    [reader.json.user.id])).rows[0].data_json), privateData);
  assert.equal((await write(reader, {}, joined.json.version)).status, 403);
  assert.equal((await request('/api/admin/users', { cookie: reader.cookie })).status, 403);
  assert.equal((await request('/api/security', { cookie: reader.cookie })).status, 200);
  assert.equal((await request(`/api/admin/users/${owner.json.user.id}/role`, {
    method: 'POST', cookie: owner.cookie, body: { role: 'reader' }
  })).status, 409);
  const existingSchema = { query: (sql, values) => sql.startsWith('CREATE TABLE IF NOT EXISTS')
    ? Promise.resolve({ rows: [] }) : pool.query(sql, values) };
  await initDatabase(existingSchema);
  assert.equal((await request('/api/me', { cookie: reader.cookie })).json.user.role, 'reader');
  assert.equal((await role('user')).status, 200);
  assert.equal((await write(reader, sharedData, joined.json.version)).status, 200);
});

test('account removal checks permissions and preserves the last and bootstrap admins', async t => {
  const { pool, request, register } = await fixture(t, { ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'Adminpassword123!' });
  const admin = await request('/api/auth/login', { method: 'POST', body: { email: 'admin@example.test', password: 'Adminpassword123!' } });
  const person = await register('delete@example.test', 'admin');
  const remove = (id, email, cookie = admin.cookie) => request(`/api/admin/users/${id}`, {
    method: 'DELETE', cookie, body: { email }
  });
  assert.equal((await request(`/api/admin/users/${person.json.user.id}`, { method: 'DELETE' })).status, 401);
  assert.equal((await remove('bad', person.json.user.email)).status, 400);
  assert.equal((await remove(9999, 'missing@example.test')).status, 404);
  assert.equal((await remove(person.json.user.id, 'wrong@example.test')).status, 400);
  const current = await request('/api/household', { cookie: person.cookie });
  await request('/api/household', { method: 'PUT', cookie: person.cookie,
    body: { data: { notes: [{ id: 'private', title: 'Privat' }] }, version: current.json.version } });
  assert.equal((await remove(admin.json.user.id, admin.json.user.email)).status, 409);
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
  assert.equal((await request(`/api/admin/users/${owner.json.user.id}/household-owner`, {
    method: 'POST', body: { newOwnerId: member.json.user.id }
  })).status, 401);
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
