const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function runPage(file, responses) {
  const nodes = new Map();
  const requests = [];
  const element = () => ({
    hidden: true, textContent: '', value: '', children: [], handlers: new Map(),
    addEventListener(event, handler) { this.handlers.set(event, handler); },
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); }
  });
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    createElement: element
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    document, window: { addEventListener() {} }, URLSearchParams,
    fetch: async url => {
      requests.push(url);
      if (!responses[url]) throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => responses[url] };
    }
  });
  // Drain asynchronous initialization without relying on wall-clock sleeps.
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve));
  return { nodes, requests };
}

test('admin audit initializes independently of the password form without invitation UI', async () => {
  const { nodes, requests } = await runPage('admin.js', {
    '/api/me': { user: { id: 1, email: 'admin@example.test', role: 'admin' } },
    '/api/admin/users': { users: [], allUsersAdmin: true },
    '/api/admin/audit': { events: [], nextBefore: null }
  });
  assert.deepEqual(requests, ['/api/me', '/api/admin/users', '/api/admin/audit']);
  assert.equal(nodes.get('#admin-status').textContent, '0 konton');
  assert.equal(nodes.has('#admin-invitations'), false);
  assert.equal(nodes.get('#admin-audit').hidden, false);
  assert.equal(nodes.get('#admin-create-form').hidden, false);
  assert.equal(nodes.has('#invite-form'), false);
});

test('optional account security does not block administration without MFA', async () => {
  const { nodes, requests } = await runPage('security.js', {
    '/api/me': { user: { id: 1, email: 'admin@example.test', role: 'admin' } },
    '/api/security': { enabled: false, required: false, verified: false, recoveryRemaining: 0 },
    '/api/security/sessions': { sessions: [] }
  });
  assert.deepEqual(requests, ['/api/me', '/api/security', '/api/security/sessions']);
  assert.equal(nodes.get('#security-status').textContent, 'admin@example.test');
  assert.equal(nodes.get('#setup-form').hidden, false);
  assert.equal(nodes.get('#factor-actions').hidden, true);
  assert.equal(nodes.get('#security-admin-link').hidden, false);
});
