// The Skreets of Maple Ridge - Node.js game server
// Zero dependencies. Serves the game page and a small shared database
// (documents, short locks, live updates over Server-Sent Events).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024; // 1 MB
const STALE_MS = 30 * 24 * 60 * 60 * 1000; // drop games idle for 30 days
const MAX_GAMES = +process.env.MAX_GAMES || 1000;      // cap on saved tables
const WRITES_PER_MIN = +process.env.WRITES_PER_MIN || 240; // per visitor IP
const STREAMS_PER_IP = +process.env.STREAMS_PER_IP || 20;  // live connections per IP

/* ---------- Abuse limits for a public server ---------- */
const clientIp = req => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const writeHits = new Map(); // ip -> { n, reset }
function allowWrite(ip) {
  const now = Date.now(), h = writeHits.get(ip);
  if (!h || h.reset < now) { writeHits.set(ip, { n: 1, reset: now + 60000 }); return true; }
  return ++h.n <= WRITES_PER_MIN;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of writeHits) if (v.reset < now) writeHits.delete(k); }, 60000).unref();
const streamCount = new Map(); // ip -> open SSE count

/* ---------- Storage ---------- */
let docs = {}; // { "games/ABCD": {...} }
try {
  docs = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  console.log(`Loaded ${Object.keys(docs).length} saved game(s).`);
} catch (e) { docs = {}; }

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(docs));
    fs.renameSync(tmp, DB_FILE);
  }, 300);
}

function pruneStale() {
  const cutoff = Date.now() - STALE_MS;
  let n = 0;
  for (const k of Object.keys(docs)) if ((docs[k].updatedAt || 0) < cutoff) { delete docs[k]; n++; }
  if (n) { scheduleSave(); console.log(`Pruned ${n} stale game(s).`); }
}
pruneStale();
setInterval(pruneStale, 6 * 60 * 60 * 1000).unref();

/* ---------- Locks ---------- */
const locks = new Map(); // path -> { holder, until }
function acquire(p, holder, ttlMs) {
  const now = Date.now(), l = locks.get(p);
  if (l && l.until > now && l.holder !== holder) return false;
  locks.set(p, { holder, until: now + Math.min(Math.max(+ttlMs || 1200, 100), 10000) });
  return true;
}
function release(p, holder) {
  const l = locks.get(p);
  if (l && l.holder === holder) locks.delete(p);
}

/* ---------- Live subscriptions (SSE) ---------- */
const docSubs = new Map(); // path -> Set(res)
const colSubs = new Map(); // collection -> Set({res, limit})

function sse(res, payload) { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
function listCollection(col, limit) {
  return Object.entries(docs)
    .filter(([k]) => k.startsWith(col + '/'))
    .map(([, v]) => v)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);
}
function broadcast(p) {
  const subs = docSubs.get(p);
  if (subs) for (const res of subs) sse(res, { exists: p in docs, data: docs[p] ?? null });
  const col = p.split('/')[0], cs = colSubs.get(col);
  if (cs) for (const s of cs) sse(s.res, { docs: listCollection(col, s.limit) });
}
function addSub(map, key, entry, req, res) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(entry);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); map.get(key)?.delete(entry); });
}

/* ---------- HTTP helpers ---------- */
const DOC_RE = /^games\/[A-Z0-9]{4}$/;
const COL_RE = /^games$/;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};
function json(res, code, obj) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------- Routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('path') || '';
  const ip = clientIp(req);

  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, games: Object.keys(docs).length });

    if (req.method !== 'GET' && req.method !== 'HEAD' && !allowWrite(ip))
      return json(res, 429, { code: 'resource_exhausted', error: 'Too many requests. Slow down a little.' });

    if (url.pathname === '/api/doc') {
      if (!DOC_RE.test(p)) return json(res, 400, { code: 'invalid_argument', error: 'Bad path' });
      if (req.method === 'GET') return json(res, 200, { exists: p in docs, data: docs[p] ?? null });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || typeof body.data !== 'object' || Array.isArray(body.data)) return json(res, 400, { code: 'invalid_argument', error: 'Bad data' });
        if (!(p in docs) && Object.keys(docs).length >= MAX_GAMES) return json(res, 503, { code: 'resource_exhausted', error: 'The server is full. Try again later.' });
        docs[p] = body.data;
        if (body.holder) release(p, String(body.holder));
        scheduleSave(); broadcast(p);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') { delete docs[p]; scheduleSave(); broadcast(p); return json(res, 200, { ok: true }); }
    }

    if (url.pathname === '/api/lock' && req.method === 'POST') {
      if (!DOC_RE.test(p)) return json(res, 400, { code: 'invalid_argument', error: 'Bad path' });
      const body = await readBody(req);
      return json(res, 200, { acquired: acquire(p, String(body.holder || ''), body.ttlMs) });
    }

    if (url.pathname === '/api/subscribe') {
      const col = url.searchParams.get('collection');
      if (p && !DOC_RE.test(p)) return json(res, 400, { error: 'Bad path' });
      if (col && !COL_RE.test(col)) return json(res, 400, { error: 'Bad collection' });
      if (!p && !col) return json(res, 400, { error: 'Missing path or collection' });
      const open = streamCount.get(ip) || 0;
      if (open >= STREAMS_PER_IP) return json(res, 429, { error: 'Too many open connections' });
      streamCount.set(ip, open + 1);
      req.on('close', () => { const n = (streamCount.get(ip) || 1) - 1; n > 0 ? streamCount.set(ip, n) : streamCount.delete(ip); });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      if (p) { addSub(docSubs, p, res, req, res); sse(res, { exists: p in docs, data: docs[p] ?? null }); }
      else {
        const limit = Math.min(Math.max(+url.searchParams.get('limit') || 15, 1), 100);
        const entry = { res, limit };
        addSub(colSubs, col, entry, req, res); sse(res, { docs: listCollection(col, limit) });
      }
      return;
    }

    if (url.pathname === '/api/id' && req.method === 'GET') return json(res, 200, { id: 'p_' + crypto.randomUUID() });

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`The Skreets of Maple Ridge is running at http://localhost:${PORT}`);
  console.log('Friends on the same network can join using this computer\'s IP address and that port.');
});

function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(docs)); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
