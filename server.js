const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = process.env.PORT || 3737;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const LOG_FILE = path.join(DATA, 'log.json');

// Mirrors lib/db.js DEFAULT_STATE and public/app.js FALLBACK_STATE — new local
// state files start seeded with example Work/Home tasks.
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Write to a temp file first so a crash mid-write can't leave a truncated log.
async function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const body = await fs.readFile(file);
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    if (url === '/api/state' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await readJson(STATE_FILE, DEFAULT_STATE)));
    }

    if (url === '/api/state' && req.method === 'PUT') {
      const state = await readBody(req);
      if (!Array.isArray(state.slots) || !Array.isArray(state.tasks)) {
        return send(res, 400, JSON.stringify({ error: 'slots and tasks must be arrays' }));
      }
      await writeJson(STATE_FILE, state);
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    if (url === '/api/log' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await readJson(LOG_FILE, [])));
    }

    if (url === '/api/log' && req.method === 'POST') {
      const entry = await readBody(req);
      const log = await readJson(LOG_FILE, []);
      log.push(entry);
      await writeJson(LOG_FILE, log);
      return send(res, 200, JSON.stringify({ ok: true, count: log.length }));
    }

    if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    return serveStatic(req, res);
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }));
  }
});

fs.mkdir(DATA, { recursive: true }).then(() => {
  server.listen(PORT, () => {
    console.log(`Spinwheel running at http://localhost:${PORT}`);
    console.log(`Data written to ${DATA}`);
  });
});
