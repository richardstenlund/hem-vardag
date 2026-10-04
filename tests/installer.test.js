const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const available = spawnSync(bash, ['--version']).status === 0;
const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8').replace(/\r\n/g, '\n');
const start = installer.indexOf('CREATED_ENV=0');
const end = installer.indexOf('get_env()');
assert.ok(start !== -1 && end > start);
const envSetup = `set -euo pipefail\nhostname() { printf '127.0.0.1\\n'; }\ndie() { printf 'Fel: %s\\n' "$1" >&2; exit 1; }\n${installer.slice(start, end)}`;

function runSetup(t, username, password, legacy = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hem-vardag-installer-'));
  t.after(() => {
    if (fs.existsSync(path.join(directory, '.env'))) fs.unlinkSync(path.join(directory, '.env'));
    fs.rmdirSync(directory);
  });
  const result = spawnSync(bash, ['-c', envSetup], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, ADMIN_USERNAME: legacy ? '' : username, ADMIN_EMAIL: legacy ? username : '', ADMIN_PASSWORD: password, APP_PORT: '3010', APP_URL: 'http://localhost:3010' }
  });
  const file = path.join(directory, '.env');
  return { result, contents: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
}

test('installer uses chosen admin credentials and preserves literal dollar signs, spaces and hashes', { skip: !available }, t => {
  const password = 'Chosen $password #123!';
  const { result, contents } = runSetup(t, 'chosen_admin', password);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(contents.includes("ADMIN_USERNAME='chosen_admin'"));
  assert.ok(contents.includes(`ADMIN_PASSWORD='${password}'`));
  assert.ok(contents.includes('ALLOW_REGISTRATION=true\n'));
  assert.doesNotMatch(contents, /ALL_USERS_ADMIN/);
  assert.doesNotMatch(contents, /INVITE_ONLY/);
  assert.doesNotMatch(result.stdout, /Chosen/);
});

test('installer rejects invalid admin credentials before writing configuration', { skip: !available }, t => {
  for (const [email, password] of [['bad name', 'Validpassword123!'], ['chosen_admin', 'short'], ['a', 'Validpassword123!']]) {
    const { result, contents } = runSetup(t, email, password);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Fel:/);
    assert.equal(contents, null);
  }
});

test('installer keeps legacy admin email configuration compatible', { skip: !available }, t => {
  const { result, contents } = runSetup(t, 'chosen@example.test', 'Chosenpassword123!', true);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(contents.includes("ADMIN_USERNAME='chosen@example.test'"));
});

test('installer accepts Swedish letters in administrator usernames', { skip: !available }, t => {
  const { result, contents } = runSetup(t, 'räven_1', 'Chosenpassword123!');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(contents.includes("ADMIN_USERNAME='räven_1'"));
});
