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
    return { status: response.status, json, cookie: response.headers.get('set-cookie')?.split(';')[0], response };
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
