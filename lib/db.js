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

// What a brand-new account starts with — mirrors the local server's defaults.
const DEFAULT_STATE = {
  slots: [
    { id: 's20', label: '20 min', minutes: 20 },
    { id: 's45', label: '45 min', minutes: 45 },
    { id: 's60', label: '1 hour', minutes: 60 },
  ],
  tasks: [],
};

module.exports = { sql, ensureSchema, DEFAULT_STATE };
