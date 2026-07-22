const { SignJWT, jwtVerify } = require('jose');
const { sql } = require('./db');

const SESSION_DAYS = 30;
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET);

// The single admin account. Overridable via env so it isn't hard-wired, but
// defaults to the owner's email. Compared case-insensitively.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'danielredwhite@gmail.com').toLowerCase();
const isAdmin = (email) => String(email || '').toLowerCase() === ADMIN_EMAIL;

async function createSession(res, userId) {
  const token = await new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
  res.setHeader(
    'Set-Cookie',
    `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
  );
}

function clearSession(res) {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}

// Returns the logged-in user's id, or null.
async function userIdFrom(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  try {
    const { payload } = await jwtVerify(match[1], secret());
    return payload.uid;
  } catch {
    return null; // expired or tampered — treat as logged out
  }
}

// Guard for data endpoints: responds 401 itself when there's no session.
async function requireUser(req, res) {
  const uid = await userIdFrom(req);
  if (!uid) {
    res.status(401).json({ error: 'not signed in' });
    return null;
  }
  return uid;
}

// Guard for the admin dashboard. Responds 404 (not 401/403) when the caller
// isn't the admin, so the route's very existence stays invisible to everyone
// else. Assumes ensureSchema() has already run.
async function requireAdmin(req, res) {
  const uid = await userIdFrom(req);
  if (uid) {
    const rows = await sql`SELECT email FROM users WHERE id = ${uid}`;
    if (rows.length && isAdmin(rows[0].email)) return uid;
  }
  res.status(404).json({ error: 'not found' });
  return null;
}

module.exports = { createSession, clearSession, userIdFrom, requireUser, requireAdmin, isAdmin };
