const { neon } = require('@neondatabase/serverless');

// One SQL client per lambda instance, created lazily so importing this module
// never throws when DATABASE_URL isn't set (e.g. local tooling).
// Neon's HTTP driver needs no pooling.
let client = null;
const sql = (strings, ...values) => {
  client ??= neon(process.env.DATABASE_URL);
  return client(strings, ...values);
};

// Schema is created lazily on first use so there's no separate migration step
// to forget — CREATE IF NOT EXISTS is a no-op once tables exist.
let initPromise = null;

function ensureSchema() {
  if (!initPromise) {
    initPromise = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS app_state (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data JSONB NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS log_entries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      // Usage analytics — one row per tracked event (login/signup/visit/spin/
      // task_edit). Feeds the admin dashboard; never read by the app itself.
      await sql`CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        props JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS events_user_type_idx ON events (user_id, type)`;
    })();
  }
  return initPromise;
}

// What a brand-new account starts with — mirrors the local server's defaults
// and public/app.js FALLBACK_STATE. Seeded with example Work/Home tasks so a
// first-time user lands on a populated wheel instead of an empty one (the
// first-run tour, gated on settings.onboarded alone, still runs on top).
// All seeds are ongoing tasks — one-time tasks carry `once: true`.
const DEFAULT_STATE = {
  slots: [
    { id: 's20', label: '20 min', minutes: 20 },
    { id: 's45', label: '45 min', minutes: 45 },
    { id: 's60', label: '1 hour', minutes: 60 },
  ],
  tasks: [
    { id: 'seed-w1', name: 'Catch up on emails', category: 'Work', slotId: 's20' },
    { id: 'seed-w2', name: 'Submit recent expenses', category: 'Work', slotId: 's20' },
    { id: 'seed-w3', name: 'Respond to Slack messages', category: 'Work', slotId: 's20' },
    { id: 'seed-w4', name: 'Review your calendar for the week', category: 'Work', slotId: 's20' },
    { id: 'seed-w5', name: 'Draft a project update', category: 'Work', slotId: 's45' },
    { id: 'seed-w6', name: "Plan next week's priorities", category: 'Work', slotId: 's45' },
    { id: 'seed-h1', name: 'Vacuum floors', category: 'Home', slotId: 's20' },
    { id: 'seed-h2', name: 'Wipe kitchen cupboards', category: 'Home', slotId: 's20' },
    { id: 'seed-h3', name: 'Clean behind stove', category: 'Home', slotId: 's20' },
    { id: 'seed-h4', name: 'Clean out fridge', category: 'Home', slotId: 's20' },
    { id: 'seed-h5', name: 'Restock pantry', category: 'Home', slotId: 's45' },
    { id: 'seed-h6', name: 'Wash windows', category: 'Home', slotId: 's45' },
    { id: 'seed-h7', name: 'Dust baseboards', category: 'Home', slotId: 's45' },
  ],
};

module.exports = { sql, ensureSchema, DEFAULT_STATE };
