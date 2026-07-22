const { sql, ensureSchema } = require('../lib/db');
const { requireUser } = require('../lib/auth');

// Events a client may record about its own session. Auth events (login/signup)
// are written server-side in api/auth.js and are never accepted from a client,
// so they can't be spoofed to inflate the numbers.
const ALLOWED = new Set(['visit', 'spin', 'task_edit']);

module.exports = async (req, res) => {
  await ensureSchema();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const uid = await requireUser(req, res);
  if (!uid) return;

  const { type, props } = req.body || {};
  if (!ALLOWED.has(type)) return res.status(400).json({ error: 'unknown event type' });

  // Keep only a small, known set of props — never persist arbitrary client JSON.
  const clean = {};
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    if (Number.isFinite(props.minutes)) clean.minutes = Math.round(props.minutes);
    if (typeof props.action === 'string') clean.action = props.action.slice(0, 32);
  }

  await sql`INSERT INTO events (user_id, type, props) VALUES (${uid}, ${type}, ${JSON.stringify(clean)})`;
  return res.json({ ok: true });
};
