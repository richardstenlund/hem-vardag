const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const webPush = require('web-push');
const { newDb } = require('pg-mem');
const { createApp, initDatabase } = require('../server');
const { recordChange } = require('../household-tools');
const { hasReminder, validSubscription, deliverReminders } = require('../push-reminders');
const testSubscription = () => ({
  endpoint: 'https://fcm.googleapis.com/fcm/send/test',
  keys: { p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
});

async function fixture(t, legacy = false) {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  const config = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'Adminpassword123!', APP_URL: 'https://household.example.test' };
  const newTables = ['named_lists', 'list_history', 'list_trash', 'list_files', 'push_subscriptions', 'push_settings'];
  const oldSchemaOnly = { query: (sql, values) => {
    if (newTables.some(table => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`) || sql.startsWith(`ALTER TABLE ${table} `))) {
      return Promise.resolve({ rows: [] });
    }
    if (sql === 'SELECT id FROM push_settings WHERE id = 1') return Promise.resolve({ rows: [{ id: 1 }] });
    return pool.query(sql, values);
  } };
  await initDatabase(legacy ? oldSchemaOnly : pool, config);
  const app = createApp(pool, config);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(async () => {
    app.locals.stopCleanup();
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  async function api(path, cookie, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    return { status: response.status, body: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text,
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(username) {
    const result = await api('/auth/register', null, { username, password: 'Testpassword123!' });
    assert.equal(result.status, 201);
    assert.equal(result.body.user.role, 'user');
    return result;
  }
  const admin = await api('/auth/login', null, { username: 'admin', password: config.ADMIN_PASSWORD });
  const alice = await register('alice');
  const bob = await register('bob');
  const outside = await register('outside');
  return { pool, api, config, admin, alice, bob, outside };
}

test('named private/shared lists enforce membership even against administrators and readers', async t => {
  const { api, alice, bob, outside, admin } = await fixture(t);
  assert.equal((await api('/lists')).status, 401);
  const privateList = await api('/lists', alice.cookie, { name: 'Privat', visibility: 'private' });
  assert.equal(privateList.status, 201);
  const id = privateList.body.list.id;
  const state = await api(`/list-data?list=${id}`, alice.cookie);
  assert.equal(state.body.version, 0);
  const data = { notes: [{ id: 'n', title: 'Private' }] };
  assert.equal((await api(`/list-data?list=${id}`, alice.cookie, { data, version: 0 }, 'PUT')).status, 200);
  assert.equal((await api(`/list-data?list=${id}`, bob.cookie)).status, 404);
  assert.equal((await api(`/list-data?list=${id}`, admin.cookie)).status, 404);
  assert.equal((await api(`/list-data?list=${id}`, alice.cookie, { data, version: 0 }, 'PUT')).status, 409);
  assert.equal((await api('/lists', alice.cookie, { name: 'Delad', visibility: 'shared' })).status, 409);
  const household = await api('/household/create', alice.cookie, { name: 'Home' });
  await api('/household/join', bob.cookie, { code: household.body.household.inviteCode });
  const shared = await api('/lists', alice.cookie, { name: 'Matbutiken', visibility: 'shared' });
  const sharedId = shared.body.list.id;
  const entries = { shopping: [{ id: 's', title: 'Mjölk', assigneeId: bob.body.user.id, amount: '25' }],
    loans: [{ id: 'l', title: 'Borrmaskin', reference: 'Grannen', due: '2030-01-01' }],
    service: [{ id: 'v', title: 'Vaccination', due: '2025-01-01' }] };
  assert.equal((await api(`/list-data?list=${sharedId}`, bob.cookie, { data: entries, version: 0 }, 'PUT')).status, 200);
  assert.deepEqual((await api(`/list-data?list=${sharedId}`, alice.cookie)).body.data, entries);
  assert.equal((await api(`/list-data?list=${sharedId}`, outside.cookie)).status, 404);
  assert.equal((await api('/lists', outside.cookie)).body.lists.length, 0);
  await api(`/admin/users/${bob.body.user.id}/role`, admin.cookie, { role: 'reader' });
  assert.equal((await api(`/list-data?list=${sharedId}`, bob.cookie)).status, 200);
  assert.equal((await api(`/list-data?list=${sharedId}`, bob.cookie, { data: {}, version: 1 }, 'PUT')).status, 403);
  assert.equal((await api('/lists', bob.cookie, { name: 'No', visibility: 'private' })).status, 403);
});

test('trash/history work for existing lists, scoped restoration and optimistic conflicts', async t => {
  const { api, pool, alice, bob, admin } = await fixture(t);
  const original = { notes: [{ id: 'keep', title: 'Restore me' }] };
  await api('/household', alice.cookie, { data: original, version: `p:${alice.body.user.id}:0` }, 'PUT');
  await api('/household', alice.cookie, { data: {}, version: `p:${alice.body.user.id}:1` }, 'PUT');
  const trash = await api('/tools/trash', alice.cookie);
  assert.equal(trash.body.items.length, 1);
  assert.equal(trash.body.items[0].item.title, 'Restore me');
  const id = trash.body.items[0].id;
  assert.equal((await api(`/tools/trash/${id}/restore`, bob.cookie, { version: 0 })).status, 404);
  assert.equal((await api(`/tools/trash/${id}/restore`, alice.cookie, { version: 1 })).status, 409);
  assert.equal((await api(`/tools/trash/${id}/restore`, alice.cookie, { version: 2 })).status, 200);
  assert.deepEqual((await api('/household', alice.cookie)).body.data, original);
  assert.equal((await api('/tools/trash', alice.cookie)).body.items.length, 0);
  const history = await api('/tools/history', alice.cookie);
  assert.equal(history.body.items[0].actor, 'alice');
  assert.equal((await api(`/tools/history/${history.body.items[0].id}/restore`, alice.cookie, { version: 3 })).status, 200);
  assert.deepEqual((await api('/household', alice.cookie)).body.data, {});
  await pool.query('UPDATE list_trash SET deleted_at = $1', [Date.now() - 31 * 86400000]);
  assert.equal((await api('/tools/trash', alice.cookie)).body.items.length, 0);
  assert.equal((await api(`/tools/trash/${id}/restore`, alice.cookie, { version: 4 })).status, 404);
  await api(`/admin/users/${alice.body.user.id}/role`, admin.cookie, { role: 'reader' });
  assert.equal((await api(`/tools/history/${history.body.items[0].id}/restore`, alice.cookie, { version: 4 })).status, 403);
  assert.equal((await api('/tools/history', alice.cookie)).status, 200);
});

test('history keeps exactly 50 versions and prunes expired trash', async t => {
  const { pool } = await fixture(t);
  for (let i = 0; i < 52; i += 1) {
    await recordChange(pool, 'personal:1', 'admin', { notes: [{ id: String(i), title: 'Old' }] }, {});
  }
  assert.equal((await pool.query("SELECT id FROM list_history WHERE scope = 'personal:1'")).rows.length, 50);
  await pool.query('UPDATE list_trash SET deleted_at = $1', [Date.now() - 31 * 86400000]);
  await recordChange(pool, 'personal:1', 'admin', {}, { notes: [{ id: 'new', title: 'New' }] });
  assert.equal((await pool.query('SELECT id FROM list_trash')).rows.length, 0);
});

test('existing permissive household payloads do not break history or attachment validation', async t => {
  const { api, alice } = await fixture(t);
  const data = { metadata: { legacy: true }, notes: [null, { id: 'note', title: 'Legacy note' }] };
  assert.equal((await api('/household', alice.cookie, { data, version: `p:${alice.body.user.id}:0` }, 'PUT')).status, 200);
  const base64 = Buffer.from('%PDF-legacy').toString('base64');
  assert.equal((await api('/tools/files', alice.cookie, { name: 'legacy.pdf', base64, itemId: 'notes:note' })).status, 201);
  assert.equal((await api('/household', alice.cookie, { data: {}, version: `p:${alice.body.user.id}:1` }, 'PUT')).status, 200);
  assert.equal((await api('/tools/trash', alice.cookie)).body.items.length, 1);
});

test('file quotas, types, associations and scope permissions are enforced; shared files survive creator deletion', async t => {
  const { api, pool, alice, bob, admin } = await fixture(t);
  const base64 = Buffer.from('%PDF-1.4\nFixture\n%%EOF').toString('base64');
  assert.equal((await api('/tools/files', alice.cookie, { name: 'a.html', base64: Buffer.from('<html>').toString('base64') })).status, 400);
  assert.equal((await api('/tools/files', alice.cookie, { name: 'a.pdf', base64, itemId: 'missing' })).status, 400);
  const uploaded = await api('/tools/files', alice.cookie, { name: 'kvitto.pdf', base64 });
  assert.equal(uploaded.status, 201);
  assert.equal((await api(`/tools/files/${uploaded.body.id}`, alice.cookie)).body, '%PDF-1.4\nFixture\n%%EOF');
  assert.equal((await api(`/tools/files/${uploaded.body.id}`, bob.cookie)).status, 404);
  assert.equal((await api(`/tools/files/${uploaded.body.id}`, admin.cookie)).status, 404);
  await pool.query('INSERT INTO list_files (id,scope,name,mime,contents,size,actor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    ['quota-fixture', `personal:${alice.body.user.id}`, 'quota.pdf', 'application/pdf', base64, 50 * 1024 * 1024 - 2 * Buffer.from(base64, 'base64').length, 'alice', Date.now()]);
  assert.equal((await api('/tools/files', alice.cookie, { name: 'exact-quota.pdf', base64 })).status, 201);
  assert.equal((await api('/tools/files', alice.cookie, { name: 'over-quota.pdf', base64 })).status, 413);
  await pool.query("DELETE FROM list_files WHERE id = 'quota-fixture'");
  await api(`/admin/users/${alice.body.user.id}/role`, admin.cookie, { role: 'reader' });
  assert.equal((await api('/tools/files', alice.cookie, { name: 'a.pdf', base64 })).status, 403);
  assert.equal((await api(`/tools/files/${uploaded.body.id}`, alice.cookie, undefined, 'DELETE')).status, 403);
  await api(`/admin/users/${alice.body.user.id}/role`, admin.cookie, { role: 'user' });
  const exactSize = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024 - 5)]);
  const exactUpload = await api('/tools/files', alice.cookie, { name: 'exact-size.pdf', base64: exactSize.toString('base64') });
  assert.equal(exactUpload.status, 201);
  await api(`/tools/files/${exactUpload.body.id}`, alice.cookie, undefined, 'DELETE');
  const big = Buffer.concat([exactSize, Buffer.alloc(1)]).toString('base64');
  assert.equal((await api('/tools/files', alice.cookie, { name: 'too-big.pdf', base64: big })).status, 400);
  const home = await api('/household/create', alice.cookie, { name: 'Home' });
  const bobFile = await api('/tools/files', bob.cookie, { name: 'joined-file.pdf', base64 });
  await api('/household/join', bob.cookie, { code: home.body.household.inviteCode });
  assert.equal((await api(`/tools/files/${uploaded.body.id}`, bob.cookie)).status, 200);
  assert.equal((await api(`/tools/files/${bobFile.body.id}`, alice.cookie)).status, 200);
  const list = await api('/lists', bob.cookie, { name: 'Shared files', visibility: 'shared' });
  const sharedId = list.body.list.id;
  const sharedFile = await api(`/tools/files?list=${sharedId}`, bob.cookie, { name: 'shared.pdf', base64 });
  const privateList = await api('/lists', bob.cookie, { name: 'Private files', visibility: 'private' });
  await api(`/admin/users/${bob.body.user.id}`, admin.cookie, { username: 'bob' }, 'DELETE');
  assert.equal((await api(`/tools/files/${sharedFile.body.id}?list=${sharedId}`, alice.cookie)).status, 200);
  assert.equal((await api(`/list-data?list=${privateList.body.list.id}`, alice.cookie)).status, 404);
});

test('readers joining a household do not share their existing private files', async t => {
  const { api, pool, alice, bob, admin } = await fixture(t);
  const uploaded = await api('/tools/files', bob.cookie, { name: 'private.pdf', base64: Buffer.from('%PDF-private').toString('base64') });
  const home = await api('/household/create', alice.cookie, { name: 'Home' });
  await api(`/admin/users/${bob.body.user.id}/role`, admin.cookie, { role: 'reader' });
  assert.equal((await api('/household/join', bob.cookie, { code: home.body.household.inviteCode })).status, 200);
  assert.equal((await api(`/tools/files/${uploaded.body.id}`, alice.cookie)).status, 404);
  assert.equal((await pool.query('SELECT scope FROM list_files WHERE id = $1', [uploaded.body.id])).rows[0].scope, `personal:${bob.body.user.id}`);
});

test('tools tables are created when upgrading an old installation without replacing account data', async t => {
  const { pool, alice } = await fixture(t, true);
  const oldTables = ['users', 'sessions', 'household_data', 'household_spaces', 'household_members', 'user_security', 'admin_audit'];
  const existingSchema = { query: (sql, values) => oldTables.some(table => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`))
    ? Promise.resolve({ rows: [] }) : pool.query(sql, values) };
  await initDatabase(existingSchema);
  assert.equal((await pool.query('SELECT email, role FROM users WHERE id = $1', [alice.body.user.id])).rows[0].role, 'user');
  assert.equal((await pool.query('SELECT public_key FROM push_settings WHERE id = 1')).rows.length, 1);
  assert.equal((await pool.query('SELECT id FROM named_lists')).rows.length, 0);
});

test('push validation rejects arbitrary network endpoints and detects dates without leaking content', () => {
  const subscription = testSubscription();
  assert.equal(validSubscription(subscription), true);
  assert.equal(validSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: 'a'.repeat(87) } }), false);
  assert.equal(validSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'b'.repeat(30) } }), false);
  for (const endpoint of ['http://127.0.0.1/test', 'https://example.com/test', 'https://fcm.googleapis.com.evil.test/x']) {
    assert.equal(validSubscription({ ...subscription, endpoint }), false);
  }
  assert.equal(hasReminder({ tasks: [{ title: 'Private', due: '2025-01-01' }] }, '2025-01-01'), true);
  assert.equal(hasReminder({ tasks: [{ completed: true, due: '2025-01-01' }] }, '2025-01-01'), false);
  assert.equal(hasReminder({ service: [{ due: '2025-01-01' }] }, '2025-01-01'), false);
  assert.equal(hasReminder({ tasks: [null, { due: '2025-01-01' }] }, '2025-01-01'), true);
});

test('push subscriptions are account-scoped and delivery is generic and once per local day', async t => {
  const { pool, api, alice, bob, config } = await fixture(t);
  const subscription = testSubscription();
  assert.equal((await api('/push', alice.cookie, { ...subscription, endpoint: 'https://127.0.0.1/test' })).status, 400);
  assert.equal((await api('/push', alice.cookie, subscription)).status, 201);
  assert.equal((await api('/push', alice.cookie)).body.enabled, true);
  assert.equal((await api('/push', bob.cookie)).body.enabled, false);
  await api('/household', alice.cookie, { data: { tasks: [{ id: 't', title: 'Sensitive title', due: '2020-01-01' }] }, version: `p:${alice.body.user.id}:0` }, 'PUT');
  // Choose a real time zone where it is daytime so the test does not depend on wall-clock hour.
  config.APP_TIMEZONE = Array.from({ length: 25 }, (_, i) => `Etc/GMT${i - 12 >= 0 ? '+' : ''}${i - 12}`)
    .find(zone => {
      const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date()));
      return hour >= 10 && hour < 19;
    });
  const payloads = [];
  await deliverReminders(pool, config, async (sub, payload, options) => {
    const request = webPush.generateRequestDetails(sub, payload, options);
    assert.match(request.headers.Authorization, /^vapid /);
    assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
    assert.ok(Buffer.isBuffer(request.body));
    payloads.push(payload);
  });
  assert.equal((await api('/push', alice.cookie, subscription)).status, 201);
  await deliverReminders(pool, config, async (sub, payload) => payloads.push(payload));
  assert.equal(payloads.length, 1);
  assert.doesNotMatch(payloads[0], /Sensitive title|alice/);
  assert.equal((await api('/push', bob.cookie, undefined, 'DELETE')).status, 200);
  assert.equal((await api('/push', alice.cookie)).body.enabled, true);
  assert.equal((await api('/push', alice.cookie, undefined, 'DELETE')).status, 200);
  assert.equal((await api('/push', alice.cookie)).body.enabled, false);
  await api('/push', alice.cookie, subscription);
  await deliverReminders(pool, config, async () => { throw Object.assign(new Error('Subscription expired'), { statusCode: 410 }); });
  assert.equal((await api('/push', alice.cookie)).body.enabled, false);
});

test('push requires a usable HTTPS address and enforces exactly ten endpoints per account', async t => {
  const { api, alice, config } = await fixture(t);
  const subscription = testSubscription();
  const url = config.APP_URL;
  config.APP_URL = 'http://localhost:3010';
  assert.equal((await api('/push', alice.cookie)).body.configured, false);
  assert.equal((await api('/push', alice.cookie, subscription)).status, 409);
  config.APP_URL = url;
  assert.equal((await api('/push', alice.cookie)).body.configured, true);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await api('/push', alice.cookie, { ...subscription, endpoint: `${subscription.endpoint}/${i}` })).status, 201);
  }
  assert.equal((await api('/push', alice.cookie, { ...subscription, endpoint: `${subscription.endpoint}/0` })).status, 201);
  assert.equal((await api('/push', alice.cookie, { ...subscription, endpoint: `${subscription.endpoint}/10` })).status, 409);
});
