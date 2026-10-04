const webPush = require('web-push');
const crypto = require('node:crypto');

async function initPush(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS push_settings (
    id INTEGER PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id VARCHAR(64) PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_json TEXT NOT NULL, last_sent_date VARCHAR(10) NOT NULL DEFAULT ''
  )`);
  const { rows } = await pool.query('SELECT id FROM push_settings WHERE id = 1');
  if (!rows.length) {
    const keys = webPush.generateVAPIDKeys();
    await pool.query('INSERT INTO push_settings (id, public_key, private_key) VALUES (1,$1,$2) ON CONFLICT (id) DO NOTHING',
      [keys.publicKey, keys.privateKey]);
  }
}
function validSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 2048) return false;
  let url;
  try { url = new URL(value.endpoint); } catch { return false; }
  const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || !(allowed.includes(url.hostname) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname))) return false;
  if (typeof value.keys?.p256dh !== 'string' || !/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(value.keys.p256dh)
    || typeof value.keys?.auth !== 'string' || !/^[A-Za-z0-9_-]{20,30}={0,2}$/.test(value.keys.auth)) return false;
  const key = Buffer.from(value.keys.p256dh, 'base64url');
  if (key.length !== 65 || key[0] !== 4 || Buffer.from(value.keys.auth, 'base64url').length !== 16) return false;
  try { crypto.ECDH.convertKey(key, 'prime256v1'); return true; } catch { return false; }
}
function hasReminder(data, today) {
  return Object.entries(data).some(([kind, items]) => kind !== 'service' && Array.isArray(items) && items.some(item => item && typeof item === 'object' && !item.completed
    && [item.due, item.expiry].some(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today)));
}
function pushConfigured(config) {
  let url;
  try { url = new URL(config.APP_URL); } catch { return false; }
  return url.protocol === 'https:' && url.hostname !== 'localhost' && !url.username && !url.password;
}
async function deliverReminders(pool, config, sender = webPush.sendNotification) {
  const now = new Date();
  const zone = config.APP_TIMEZONE || 'Europe/Stockholm';
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: zone }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: zone }).format(now));
  if (hour < 9 || hour >= 21) return;
  const { rows: [keys] } = await pool.query('SELECT * FROM push_settings WHERE id = 1');
  const { rows } = await pool.query(`SELECT s.*, u.active FROM push_subscriptions s JOIN users u ON u.id = s.user_id`);
  for (const subscription of rows) {
    if (!subscription.active || subscription.last_sent_date === today) continue;
    const { rows: [member] } = await pool.query('SELECT household_id FROM household_members WHERE user_id = $1', [subscription.user_id]);
    const { rows: main } = member
      ? await pool.query('SELECT data_json FROM household_spaces WHERE id = $1', [member.household_id])
      : await pool.query('SELECT data_json FROM household_data WHERE user_id = $1', [subscription.user_id]);
    const { rows: lists } = await pool.query('SELECT owner_id, household_id, data_json FROM named_lists');
    const visible = lists.filter(list => list.household_id ? list.household_id === member?.household_id : list.owner_id === subscription.user_id);
    if (![...main, ...visible].some(row => hasReminder(JSON.parse(row.data_json), today))) continue;
    try {
      await sender(JSON.parse(subscription.subscription_json), JSON.stringify({
        title: 'Hem & vardag', body: 'Du har datum att följa upp. Öppna sidan för att se dina påminnelser.', url: '/'
      }), { TTL: 3600, vapidDetails: { subject: config.APP_URL, publicKey: keys.public_key, privateKey: keys.private_key } });
      await pool.query('UPDATE push_subscriptions SET last_sent_date = $1 WHERE id = $2', [today, subscription.id]);
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [subscription.id]);
      else console.error('Pushpåminnelsen kunde inte levereras:', error.message);
    }
  }
}
function mountPush(app, { pool, authenticated, config, transaction }) {
  new Intl.DateTimeFormat('sv-SE', { timeZone: config.APP_TIMEZONE || 'Europe/Stockholm' }).format(new Date());
  app.get('/api/push', ...authenticated(async (req, res) => {
    const { rows: [keys] } = await pool.query('SELECT public_key FROM push_settings WHERE id = 1');
    const { rows } = await pool.query('SELECT id FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
    res.json({ publicKey: keys.public_key, enabled: rows.length > 0, configured: pushConfigured(config), timezone: config.APP_TIMEZONE || 'Europe/Stockholm' });
  }));
  app.post('/api/push', ...authenticated(async (req, res) => {
    if (!validSubscription(req.body)) return res.status(400).json({ error: 'Ogiltig pushprenumeration eller leverantör som inte stöds.' });
    if (!pushConfigured(config)) return res.status(409).json({ error: 'Ställ in APP_URL till sidans HTTPS-adress (inte localhost) innan push aktiveras.' });
    const id = crypto.createHash('sha256').update(req.body.endpoint).digest('hex');
    const result = await transaction(async client => {
      const { rows: [user] } = await client.query('SELECT active FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      if (!user?.active) return { status: 401, error: 'Inloggningen är inte längre giltig.' };
      const { rows } = await client.query('SELECT id FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
      if (rows.length >= 10 && !rows.some(row => row.id === id)) return { status: 409, error: 'Högst 10 enheter kan ha pushpåminnelser per konto.' };
      await client.query(`INSERT INTO push_subscriptions (id,user_id,subscription_json) VALUES ($1,$2,$3)
        ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, subscription_json = EXCLUDED.subscription_json`,
      [id, req.user.id, JSON.stringify(req.body)]);
      return {};
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json({ ok: true });
  }));
  app.delete('/api/push', ...authenticated(async (req, res) => {
    await transaction(async client => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
    });
    res.json({ ok: true });
  }));
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await deliverReminders(pool, config); } catch (error) { console.error('Pushpåminnelser misslyckades:', error.message); }
    finally { running = false; }
  }, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = { initPush, mountPush, deliverReminders, hasReminder, validSubscription };
