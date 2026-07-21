const { sql, ensureSchema, DEFAULT_STATE } = require('../lib/db');
const { requireUser } = require('../lib/auth');

module.exports = async (req, res) => {
  await ensureSchema();
  const uid = await requireUser(req, res);
  if (!uid) return;

  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM app_state WHERE user_id = ${uid}`;
    return res.json(rows.length ? rows[0].data : DEFAULT_STATE);
  }

  if (req.method === 'PUT') {
    const state = req.body;
    if (!state || !Array.isArray(state.slots) || !Array.isArray(state.tasks)) {
      return res.status(400).json({ error: 'slots and tasks must be arrays' });
    }
    await sql`
      INSERT INTO app_state (user_id, data) VALUES (${uid}, ${JSON.stringify(state)})
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data
    `;
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
