const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

let Pool = null;
try { ({ Pool } = require('pg')); } catch {}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const ACCESS_CODE = String(process.env.ACCESS_CODE || '1209');
const ADMIN_ROUTE = String(process.env.ADMIN_ROUTE || '/_c9').replace(/\/+$/, '') || '/_c9';
const ROOT = __dirname;
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(ROOT, 'storage'));
const DATA_FILE = path.join(STORAGE_DIR, 'videos.json');
const DATA_BACKUP = path.join(STORAGE_DIR, 'videos.backup.json');
const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
const THUMB_DIR = path.join(STORAGE_DIR, 'generated');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SESSION_TTL = 8 * 60 * 60 * 1000;
const MAX_PAGE = 48;
const sessions = new Map();
const rate = new Map();
let localCache = null;
let localWriteQueue = Promise.resolve();

for (const dir of [STORAGE_DIR, UPLOAD_DIR, THUMB_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

const pool = process.env.DATABASE_URL && Pool
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    })
  : null;

function noStore(res) { res.setHeader('Cache-Control', 'no-store'); }
function safeName(n) { return String(n).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file'; }
function requestIp(req) { return String(req.ip || req.socket.remoteAddress || 'unknown'); }
function allowRate(key, limit, windowMs) {
  const now = Date.now();
  const rec = rate.get(key) || { count: 0, reset: now + windowMs };
  if (rec.reset <= now) { rec.count = 0; rec.reset = now + windowMs; }
  rec.count += 1; rate.set(key, rec);
  return rec.count <= limit;
}
function cookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const p = part.trim(); if (!p) continue;
    const i = p.indexOf('='); if (i < 1) continue;
    try { out[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1)); } catch {}
  }
  return out;
}
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { exp: Date.now() + SESSION_TTL, csrf });
  return { token, csrf };
}
function sessionRecord(req) {
  const token = cookies(req.headers.cookie || '').gta6_session;
  const rec = token ? sessions.get(token) : null;
  if (!rec || rec.exp < Date.now()) { if (token) sessions.delete(token); return null; }
  return rec;
}
function requireSession(req, res, next) {
  const rec = sessionRecord(req);
  if (!rec) return res.status(401).json({ error: 'Unauthorized' });
  noStore(res); next();
}
function requireCsrf(req, res, next) {
  const rec = sessionRecord(req);
  if (!rec) return res.status(401).json({ error: 'Unauthorized' });
  const supplied = Buffer.from(String(req.get('x-csrf-token') || ''));
  const expected = Buffer.from(rec.csrf);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(403).json({ error: 'Invalid CSRF token' });
  next();
}
function validUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol); } catch { return false; }
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
  }
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip) || /^::ffff:127\./i.test(ip);
  return true;
}
async function safeRemoteUrl(value) {
  if (!validUrl(value)) throw new Error('Invalid URL');
  const u = new URL(value);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0') throw new Error('Local host blocked');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private address blocked');
  } else {
    const records = await dns.lookup(host, { all: true });
    if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error('Private host blocked');
  }
  return u.toString();
}
async function fetchSafe(url, options = {}) {
  let current = await safeRemoteUrl(url);
  for (let i = 0; i < 5; i++) {
    const response = await fetch(current, { ...options, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) throw new Error('Unsafe redirect');
      current = await safeRemoteUrl(new URL(loc, current).toString());
      continue;
    }
    return { response, url: current };
  }
  throw new Error('Too many redirects');
}

function readLocalVideos() {
  if (localCache) return localCache.map(v => ({ ...v }));
  const read = file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };
  const primary = read(DATA_FILE);
  if (Array.isArray(primary)) { localCache = primary; return primary.map(v => ({ ...v })); }
  const backup = read(DATA_BACKUP);
  if (Array.isArray(backup)) {
    try { fs.copyFileSync(DATA_BACKUP, DATA_FILE); } catch {}
    localCache = backup; return backup.map(v => ({ ...v }));
  }
  localCache = [];
  try { fs.writeFileSync(DATA_FILE, '[]', 'utf8'); } catch {}
  return [];
}
function writeLocalVideos(videos) {
  const clean = Array.isArray(videos) ? videos : [];
  localCache = clean.map(v => ({ ...v }));
  localWriteQueue = localWriteQueue.then(async () => {
    const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(temp, JSON.stringify(clean, null, 2), 'utf8');
    try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_BACKUP); } catch {}
    fs.renameSync(temp, DATA_FILE);
  }).catch(() => {});
  return localWriteQueue;
}

const diskStorage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, UPLOAD_DIR),
  filename: (_r, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = safeName(path.basename(file.originalname, ext));
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${base}${ext}`);
  }
});
const uploadDisk = multer({
  storage: diskStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 2, fields: 20, fieldSize: 2 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => {
    if (f.fieldname === 'file' && /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(f.originalname) && String(f.mimetype).startsWith('video/')) return cb(null, true);
    if (f.fieldname === 'thumbnail' && /\.(jpg|jpeg|png|webp)$/i.test(f.originalname) && String(f.mimetype).startsWith('image/')) return cb(null, true);
    cb(null, false);
  }
});
const uploadThumb = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1.5 * 1024 * 1024, files: 1 } });

function baseEntry({ id = crypto.randomUUID(), title, subtitle = '', category = 'VIDEO', description = '', source = 'DIRECT', quality = '1080P', mode = 'remote', filename = null, remoteUrl = null, size = 'DIRECT', duration = null }) {
  return {
    id,
    title: String(title || '').trim().slice(0, 120),
    subtitle: String(subtitle || '').trim().slice(0, 180),
    category: String(category || 'VIDEO').trim().toUpperCase().slice(0, 40),
    description: String(description || '').trim().slice(0, 800),
    source: String(source || 'DIRECT').trim().slice(0, 80),
    quality: String(quality || '1080P').trim().slice(0, 20),
    mode,
    filename,
    remoteUrl,
    videoUrl: `/api/media/${id}/stream`,
    downloadUrl: `/api/media/${id}/download`,
    poster: `/api/media/${id}/thumb`,
    duration: duration || null,
    size: String(size || 'DIRECT').slice(0, 60),
    createdAt: new Date().toISOString(),
    thumbFile: null,
    thumbType: null
  };
}
function rowToPublic(r) {
  return {
    id: r.id, title: r.title, subtitle: r.subtitle, category: r.category, description: r.description,
    source: r.source, quality: r.quality, mode: r.mode, filename: r.filename, remoteUrl: r.remote_url,
    videoUrl: `/api/media/${r.id}/stream`, downloadUrl: `/api/media/${r.id}/download`, poster: `/api/media/${r.id}/thumb`,
    duration: r.duration, size: r.size, createdAt: r.created_at
  };
}

async function initDb() {
  if (!pool) return false;
  await pool.query(`CREATE TABLE IF NOT EXISTS media_items (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'VIDEO',
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'DIRECT',
    quality TEXT NOT NULL DEFAULT '1080P',
    mode TEXT NOT NULL DEFAULT 'remote',
    filename TEXT,
    remote_url TEXT,
    size TEXT,
    duration DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    thumb BYTEA,
    thumb_type TEXT,
    thumb_file TEXT
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_items_created_idx ON media_items(created_at DESC);`);
  return true;
}

async function listVideos({ page = 1, limit = 12, q = '' } = {}) {
  page = Math.max(1, Number(page) || 1); limit = Math.min(MAX_PAGE, Math.max(1, Number(limit) || 12));
  const offset = (page - 1) * limit; const needle = String(q || '').trim();
  if (!pool) {
    let rows = readLocalVideos();
    if (needle) { const s = needle.toLowerCase(); rows = rows.filter(v => [v.title, v.subtitle, v.category, v.description].join(' ').toLowerCase().includes(s)); }
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const total = rows.length;
    return { items: rows.slice(offset, offset + limit), total, page, limit, hasMore: offset + limit < total, persistence: 'local-json', temporary: true };
  }
  const pattern = `%${needle}%`;
  const count = await pool.query('SELECT COUNT(*)::int AS total FROM media_items WHERE ($1 = \'\' OR title ILIKE $2 OR subtitle ILIKE $2 OR category ILIKE $2 OR description ILIKE $2)', [needle, pattern]);
  const rows = await pool.query('SELECT id,title,subtitle,category,description,source,quality,mode,filename,remote_url,size,duration,created_at FROM media_items WHERE ($1 = \'\' OR title ILIKE $2 OR subtitle ILIKE $2 OR category ILIKE $2 OR description ILIKE $2) ORDER BY created_at DESC LIMIT $3 OFFSET $4', [needle, pattern, limit, offset]);
  const total = count.rows[0]?.total || 0;
  return { items: rows.rows.map(rowToPublic), total, page, limit, hasMore: offset + limit < total, persistence: 'postgres', temporary: false };
}
async function getVideo(id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) return null;
  if (!pool) return readLocalVideos().find(v => v.id === id) || null;
  const r = await pool.query('SELECT id,title,subtitle,category,description,source,quality,mode,filename,remote_url,size,duration,created_at FROM media_items WHERE id=$1', [id]);
  return r.rows[0] ? rowToPublic(r.rows[0]) : null;
}
async function insertBatch(entries) {
  if (!pool) { await writeLocalVideos([...readLocalVideos(), ...entries]); return entries; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) await client.query('INSERT INTO media_items (id,title,subtitle,category,description,source,quality,mode,filename,remote_url,size,duration,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [e.id,e.title,e.subtitle,e.category,e.description,e.source,e.quality,e.mode,e.filename,e.remoteUrl,e.size,e.duration,e.createdAt]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return entries;
}
async function deleteVideo(id) {
  const v = await getVideo(id); if (!v) return false;
  if (v.filename) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(v.filename))); } catch {} }
  try { fs.unlinkSync(path.join(THUMB_DIR, `${id}.jpg`)); } catch {}
  if (!pool) { await writeLocalVideos(readLocalVideos().filter(x => x.id !== id)); return true; }
  await pool.query('DELETE FROM media_items WHERE id=$1', [id]); return true;
}
async function saveThumb(id, buffer, mime) {
  if (!pool) {
    const filename = `${id}.jpg`;
    fs.writeFileSync(path.join(THUMB_DIR, filename), buffer);
    const rows = readLocalVideos(); const idx = rows.findIndex(v => v.id === id);
    if (idx >= 0) { rows[idx].thumbFile = filename; rows[idx].thumbType = mime || 'image/jpeg'; await writeLocalVideos(rows); }
    return true;
  }
  await pool.query('UPDATE media_items SET thumb=$2, thumb_type=$3 WHERE id=$1', [id, buffer, mime || 'image/jpeg']);
  return true;
}
async function thumbInfo(id) {
  if (!pool) {
    const v = readLocalVideos().find(x => x.id === id); if (!v?.thumbFile) return null;
    const p = path.join(THUMB_DIR, path.basename(v.thumbFile));
    return fs.existsSync(p) ? { path: p, type: v.thumbType || 'image/jpeg' } : null;
  }
  const r = await pool.query('SELECT thumb,thumb_type FROM media_items WHERE id=$1', [id]); return r.rows[0] || null;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(),microphone=(),geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.static(PUBLIC_DIR, { maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0 }));

app.get('/health', async (_req, res) => {
  let database = false;
  if (pool) { try { await pool.query('SELECT 1'); database = true; } catch {} }
  res.json({ ok: true, service: 'gta6-media', persistence: pool ? 'postgres' : 'local-json', temporary: !pool, database });
});
app.get('/api/videos', async (req, res) => {
  try { noStore(res); res.json(await listVideos({ page: req.query.page, limit: req.query.limit, q: String(req.query.q || '').slice(0, 120) })); }
  catch { noStore(res); res.json({ items: [], total: 0, page: 1, limit: 12, hasMore: false, persistence: 'degraded', temporary: true, error: 'Library temporarily unavailable' }); }
});
app.get('/api/videos/:id', async (req, res) => {
  try { const v = await getVideo(req.params.id); if (!v) return res.status(404).json({ error: 'Not found' }); noStore(res); res.json(v); }
  catch { res.status(500).json({ error: 'Item unavailable' }); }
});

app.post('/_access', (req, res) => {
  noStore(res); const ip = requestIp(req);
  if (!allowRate(`login:${ip}`, 8, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts' });
  const a = Buffer.from(String(req.body?.code || '')), b = Buffer.from(ACCESS_CODE);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Denied' });
  const { token, csrf } = createSession();
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gta6_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}; Priority=High${secure}`);
  res.json({ ok: true });
});
app.get('/_access/check', (req, res) => { noStore(res); const rec = sessionRecord(req); res.json(rec ? { ok: true, csrf: rec.csrf } : { ok: false }); });
app.post('/_logout', requireSession, requireCsrf, (req, res) => { const t = cookies(req.headers.cookie || '').gta6_session; sessions.delete(t); res.setHeader('Set-Cookie', 'gta6_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Priority=High'); res.json({ ok: true }); });

app.get(ADMIN_ROUTE, (req, res) => { noStore(res); res.setHeader('Vary', 'Cookie'); res.sendFile(path.join(PUBLIC_DIR, sessionRecord(req) ? 'control-v2.html' : 'access.html')); });
app.get(`${ADMIN_ROUTE}/control`, requireSession, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'control-v2.html')));

app.post('/api/control/batch-add', requireSession, requireCsrf, async (req, res) => {
  if (!allowRate(`batch:${requestIp(req)}`, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests' });
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!raw.length) return res.status(400).json({ error: 'No items' });
  if (raw.length > 100) return res.status(400).json({ error: 'Maximum 100 items per batch' });
  const valid = [], errors = [];
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i] || {}; const title = String(x.title || '').trim(); const description = String(x.description || '').trim(); const url = String(x.url || '').trim();
    if (!url || !validUrl(url)) { errors.push({ index: i, error: 'Invalid URL' }); continue; }
    if (!title) { errors.push({ index: i, error: 'Missing title' }); continue; }
    if (!description) { errors.push({ index: i, error: 'Missing description' }); continue; }
    try { valid.push(baseEntry({ title, description, subtitle: x.subtitle, category: x.category, quality: x.quality, source: x.source, size: x.size, mode: 'remote', remoteUrl: await safeRemoteUrl(url) })); }
    catch (e) { errors.push({ index: i, error: e.message || 'URL rejected' }); }
  }
  if (valid.length) await insertBatch(valid);
  res.json({ ok: true, items: valid, errors, persistence: pool ? 'postgres' : 'local-json', temporary: !pool });
});

app.post('/api/control/add-local', requireSession, requireCsrf, (req, res, next) => {
  uploadDisk.single('file')(req, res, err => err ? res.status(400).json({ error: err.message || 'Upload failed' }) : next());
}, async (req, res) => {
  const file = req.file; if (!file) return res.status(400).json({ error: 'Video file required' });
  const title = String(req.body.title || '').trim(); if (!title) return res.status(400).json({ error: 'Title required' });
  if (pool) return res.status(400).json({ error: 'Local file storage needs a persistent disk. Use a direct URL on this deployment.' });
  const entry = baseEntry({ title, description: req.body.description, subtitle: req.body.subtitle, category: req.body.category, quality: req.body.quality, source: 'LOCAL', mode: 'local', filename: file.filename, size: `${(file.size / 1048576).toFixed(1)} MB`, duration: Number(req.body.duration) > 0 ? Number(req.body.duration) : null });
  try { await insertBatch([entry]); res.json({ ok: true, item: entry, temporary: true }); }
  catch (e) { try { fs.unlinkSync(path.join(UPLOAD_DIR, file.filename)); } catch {} res.status(500).json({ error: e.message || 'Failed' }); }
});

app.post('/api/control/:id/thumb', requireSession, requireCsrf, uploadThumb.single('thumbnail'), async (req, res) => {
  const v = await getVideo(req.params.id); if (!v) return res.status(404).json({ error: 'Not found' });
  if (!req.file || !String(req.file.mimetype).startsWith('image/')) return res.status(400).json({ error: 'Image required' });
  try { await saveThumb(v.id, req.file.buffer, req.file.mimetype); res.json({ ok: true, temporary: !pool }); }
  catch { res.status(500).json({ error: 'Thumbnail save failed' }); }
});
app.delete('/api/control/:id', requireSession, requireCsrf, async (req, res) => {
  if (!allowRate(`mut:${requestIp(req)}`, 60, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests' });
  try { if (!await deleteVideo(req.params.id)) return res.status(404).json({ error: 'Not found' }); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Delete failed' }); }
});

async function pipeRemote(req, res, url, downloadName) {
  const headers = {}; if (req.headers.range) headers.Range = req.headers.range;
  const { response: upstream } = await fetchSafe(url, { headers });
  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) throw new Error(`Remote source returned ${upstream.status}`);
  res.status(upstream.status);
  for (const h of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (downloadName) res.setHeader('Content-Disposition', `attachment; filename="${safeName(downloadName)}"`);
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}
app.get('/api/preview', requireSession, async (req, res) => { try { const u = await safeRemoteUrl(String(req.query.url || '').slice(0, 2048)); await pipeRemote(req, res, u, null); } catch { res.status(502).json({ error: 'Preview unavailable' }); } });
app.get('/api/media/:id/thumb', async (req, res) => {
  const v = await getVideo(req.params.id); if (!v) return res.status(404).end();
  const t = await thumbInfo(v.id);
  if (t?.path) { res.type(t.type || 'image/jpeg'); res.setHeader('Cache-Control','public,max-age=31536000,immutable'); return res.sendFile(t.path); }
  if (t?.thumb) { res.type(t.thumb_type || 'image/jpeg'); res.setHeader('Cache-Control','public,max-age=31536000,immutable'); return res.end(t.thumb); }
  return res.redirect('/assets/hero-side.jpg');
});
app.get('/api/media/:id/stream', async (req, res) => {
  try {
    const v = await getVideo(req.params.id); if (!v) return res.status(404).end();
    if (v.mode === 'local') { const p = path.join(UPLOAD_DIR, path.basename(v.filename || '')); if (!fs.existsSync(p)) return res.status(404).end(); return res.sendFile(p, { acceptRanges: true, maxAge: '1m' }); }
    await pipeRemote(req, res, v.remoteUrl, null);
  } catch { res.status(502).json({ error: 'Media source unavailable' }); }
});
app.get('/api/media/:id/download', async (req, res) => {
  try {
    const v = await getVideo(req.params.id); if (!v) return res.status(404).end();
    if (v.mode === 'local') { const p = path.join(UPLOAD_DIR, path.basename(v.filename || '')); if (!fs.existsSync(p)) return res.status(404).end(); return res.download(p, safeName(`${v.title}${path.extname(p)}`)); }
    const ext = path.extname(new URL(v.remoteUrl).pathname) || '.mp4'; await pipeRemote(req, res, v.remoteUrl, `${safeName(v.title)}${ext}`);
  } catch { res.status(502).send('Download unavailable'); }
});
app.get('/video/:id', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'video.html')));

app.use((req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/_')) return res.status(404).end(); if (req.method !== 'GET' || req.path.includes('.')) return next(); res.sendFile(path.join(PUBLIC_DIR, 'index.html')); });
app.use((err, _req, res, _next) => { if (!res.headersSent) res.status(500).json({ error: 'Server error' }); });
setInterval(() => { for (const [t, rec] of sessions) if (rec.exp < Date.now()) sessions.delete(t); for (const [k, rec] of rate) if (rec.reset < Date.now()) rate.delete(k); }, 60 * 60 * 1000).unref();

(async () => {
  let dbReady = false;
  if (pool) { try { await initDb(); dbReady = true; } catch (e) { console.error('DB unavailable; using local fallback:', e.message); } }
  if (!dbReady && pool) console.warn('Persistence fallback active. DATABASE_URL is configured but unreachable.');
  app.listen(PORT, '0.0.0.0', () => console.log(`GTA VI media server on port ${PORT} // persistence=${dbReady ? 'postgres' : 'local-json'}`));
})();
