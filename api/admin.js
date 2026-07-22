const { sql, ensureSchema } = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

// Admin-only usage dashboard data. Aggregate metrics plus a per-user table of
// COUNTS ONLY — deliberately no task labels or other personal content.
module.exports = async (req, res) => {
  await ensureSchema();
  const uid = await requireAdmin(req, res);
  if (!uid) return; // requireAdmin already responded 404

  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const [
    userCount, eventCounts, outcomeCounts, active,
    signupsByDay, spinsByDay, dauByDay, chunkDist, users,
  ] = await Promise.all([
    sql`SELECT count(*)::int AS n FROM users`,
    sql`SELECT type, count(*)::int AS n FROM events GROUP BY type`,
    sql`SELECT entry->>'outcome' AS outcome, count(*)::int AS n FROM log_entries GROUP BY 1`,
    sql`SELECT
          (count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '1 day'))::int  AS d1,
          (count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '7 days'))::int  AS d7,
          (count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '30 days'))::int AS d30
        FROM events`,
    sql`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM users WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
    sql`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM events WHERE type = 'spin' AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
    sql`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(DISTINCT user_id)::int AS n
        FROM events WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
    sql`SELECT (props->>'minutes')::int AS minutes, count(*)::int AS n
        FROM events WHERE type = 'spin' AND props->>'minutes' IS NOT NULL GROUP BY 1 ORDER BY 1`,
    sql`SELECT
          u.id, u.email, to_char(u.created_at, 'YYYY-MM-DD') AS joined,
          (SELECT to_char(max(created_at), 'YYYY-MM-DD') FROM events e WHERE e.user_id = u.id) AS last_active,
          (SELECT count(*)::int FROM events e WHERE e.user_id = u.id AND e.type = 'spin')  AS spins,
          (SELECT count(*)::int FROM events e WHERE e.user_id = u.id AND e.type = 'visit') AS visits,
          (SELECT count(*)::int FROM log_entries l WHERE l.user_id = u.id AND l.entry->>'outcome' = 'success') AS completions,
          (SELECT count(*)::int FROM log_entries l WHERE l.user_id = u.id) AS sessions,
          (SELECT coalesce(jsonb_array_length(data->'tasks'), 0) FROM app_state s WHERE s.user_id = u.id) AS tasks
        FROM users u ORDER BY u.created_at DESC LIMIT 500`,
  ]);

  const byType = Object.fromEntries(eventCounts.map((r) => [r.type, r.n]));
  const byOutcome = Object.fromEntries(outcomeCounts.map((r) => [r.outcome, r.n]));

  return res.json({
    totals: {
      users: userCount[0].n,
      spins: byType.spin || 0,
      visits: byType.visit || 0,
      logins: byType.login || 0,
      signups: byType.signup || 0,
      taskEdits: byType.task_edit || 0,
      completions: byOutcome.success || 0,
      fails: byOutcome.fail || 0,
      activeToday: active[0].d1,
      active7d: active[0].d7,
      active30d: active[0].d30,
    },
    signupsByDay,
    spinsByDay,
    dauByDay,
    chunkDist,
    users,
  });
};
