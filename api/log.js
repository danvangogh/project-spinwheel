const { sql, ensureSchema } = require('../lib/db');
const { requireUser } = require('../lib/auth');

module.exports = async (req, res) => {
  await ensureSchema();
  const uid = await requireUser(req, res);
  if (!uid) return;

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT entry FROM log_entries WHERE user_id = ${uid} ORDER BY id ASC
    `;
    return res.json(rows.map((r) => r.entry));
  }

  if (req.method === 'POST') {
    const entry = req.body;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return res.status(400).json({ error: 'entry must be an object' });
    }
    await sql`INSERT INTO log_entries (user_id, entry) VALUES (${uid}, ${JSON.stringify(entry)})`;
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM log_entries WHERE user_id = ${uid}`;
    return res.json({ ok: true, count });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
