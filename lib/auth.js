const { SignJWT, jwtVerify } = require('jose');

const SESSION_DAYS = 30;
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET);

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

module.exports = { createSession, clearSession, userIdFrom, requireUser };
