const bcrypt = require('bcryptjs');
const { sql, ensureSchema, DEFAULT_STATE } = require('../lib/db');
const { createSession, clearSession, userIdFrom } = require('../lib/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  await ensureSchema();

  // GET /api/auth — who am I?
  if (req.method === 'GET') {
    const uid = await userIdFrom(req);
    if (!uid) return res.status(401).json({ error: 'not signed in' });
    const rows = await sql`SELECT email FROM users WHERE id = ${uid}`;
    if (rows.length === 0) return res.status(401).json({ error: 'not signed in' });
    return res.json({ email: rows[0].email });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { action, email: rawEmail, password } = req.body || {};

  if (action === 'logout') {
    clearSession(res);
    return res.json({ ok: true });
  }

  const email = String(rawEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  if (action === 'signup') {
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists — sign in instead.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const rows = await sql`INSERT INTO users (email, password_hash) VALUES (${email}, ${hash}) RETURNING id`;
    const uid = rows[0].id;
    await sql`INSERT INTO app_state (user_id, data) VALUES (${uid}, ${JSON.stringify(DEFAULT_STATE)})`;
    await sql`INSERT INTO events (user_id, type) VALUES (${uid}, 'signup')`;
    await createSession(res, uid);
    return res.json({ email });
  }

  if (action === 'login') {
    const rows = await sql`SELECT id, password_hash FROM users WHERE email = ${email}`;
    // Same error for wrong email and wrong password — don't leak which.
    if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    await sql`INSERT INTO events (user_id, type) VALUES (${rows[0].id}, 'login')`;
    await createSession(res, rows[0].id);
    return res.json({ email });
  }

  return res.status(400).json({ error: 'unknown action' });
};
