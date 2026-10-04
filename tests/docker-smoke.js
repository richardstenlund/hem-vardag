const assert = require('node:assert/strict');
const OTPAuth = require('otpauth');

async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return {
    status: response.status,
    body: response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text,
    cookie: response.headers.get('set-cookie')?.split(';')[0]
  };
}

async function main() {
  assert.equal((await request('/api/health')).body.application, 'hem-vardag');
  assert.doesNotMatch((await request('/')).body, /Formkurva|MyHome/);
  assert.equal((await request('/api/workouts')).status, 404);
  const password = 'CI-only-password-123!';
  if (process.env.VERIFY_RESTART === 'true') {
    const login = await request('/api/auth/login', { method: 'POST', body: { email: 'ci-owner@example.test', password } });
    assert.equal(login.status, 200);
    const restored = await request('/api/household', { cookie: login.cookie });
    assert.equal(restored.body.household.members.length, 2);
    assert.equal(restored.body.data.notes[0].title, 'Sparat i riktig PostgreSQL');
    console.log('Docker restart persistence verified.');
    return;
  }
  const admin = await request('/api/auth/login', { method: 'POST', body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  assert.equal(admin.status, 200);
  assert.ok(admin.cookie, 'Use a fresh disposable test installation; the admin should not yet have MFA.');
  const setup = await request('/api/security/setup', { method: 'POST', cookie: admin.cookie, body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(setup.status, 200);
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) }).generate();
  const enabled = await request('/api/security/enable', { method: 'POST', cookie: admin.cookie, body: { code } });
  assert.equal(enabled.status, 200);
  async function invitedAccount(email) {
    const invite = await request('/api/admin/invites', { method: 'POST', cookie: admin.cookie, body: { email } });
    assert.equal(invite.status, 201);
    return request('/api/auth/register', { method: 'POST', body: { email, password, inviteToken: invite.body.token } });
  }
  const owner = await invitedAccount('ci-owner@example.test');
  const member = await invitedAccount('ci-member@example.test');
  assert.equal(owner.status, 201);
  assert.equal(member.status, 201);
  const before = await request('/api/household', { cookie: owner.cookie });
  const data = { notes: [{ id: 'ci-note', title: 'Sparat i riktig PostgreSQL' }] };
  assert.equal((await request('/api/household', { method: 'PUT', cookie: owner.cookie, body: { data, version: before.body.version } })).status, 200);
  const space = await request('/api/household/create', { method: 'POST', cookie: owner.cookie, body: { name: 'CI-hushåll' } });
  assert.equal(space.status, 201);
  const joined = await request('/api/household/join', { method: 'POST', cookie: member.cookie, body: { code: space.body.household.inviteCode } });
  assert.equal(joined.status, 200);
  assert.deepEqual(joined.body.data, data);
  assert.equal((await request('/api/household', { method: 'PUT', cookie: owner.cookie, body: { data: {}, version: space.body.version } })).status, 409);
  assert.equal(owner.body.user.role, 'user');
  assert.equal((await request(`/api/admin/users/${member.body.user.id}/active`, {
    method: 'POST', cookie: admin.cookie, body: { active: false }
  })).status, 200);
  assert.equal((await request('/api/household', { cookie: member.cookie })).status, 401);
  assert.equal((await request(`/api/admin/users/${member.body.user.id}/active`, {
    method: 'POST', cookie: admin.cookie, body: { active: true }
  })).status, 200);
  const restoredMember = await request('/api/auth/login', { method: 'POST', body: { email: 'ci-member@example.test', password } });
  assert.deepEqual((await request('/api/household', { cookie: restoredMember.cookie })).body.data, data);
  const disposable = await invitedAccount('ci-disposable@example.test');
  assert.equal((await request(`/api/admin/users/${disposable.body.user.id}`, {
    method: 'DELETE', cookie: admin.cookie, body: { email: 'ci-disposable@example.test' }
  })).status, 200);
  const events = await request('/api/admin/audit', { cookie: admin.cookie });
  assert.ok(events.body.events.some(event => event.action === 'account_deleted'));
  const sessionList = await request('/api/security/sessions', { cookie: admin.cookie });
  assert.equal(sessionList.body.sessions[0].current, true);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: {
    email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, code: enabled.body.recoveryCodes[0]
  } })).status, 200);
  console.log('Docker invitations, MFA, suspension, deletion, sessions, audit, shared data and conflict protection verified.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
