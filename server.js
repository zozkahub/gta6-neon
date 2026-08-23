const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const ACCESS_CODE = String(process.env.ACCESS_CODE || '1209');
const SESSION_SECRET = String(process.env.SESSION_SECRET || 'local-dev-secret-change-this');
const ADMIN_ROUTE = String(process.env.ADMIN_ROUTE || '/_c9').replace(/\/+$/, '') || '/_c9';
const ROOT = __dirname;
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(ROOT, 'storage'));
const DATA_FILE = path.join(STORAGE_DIR, 'videos.json');
const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
const THUMB_DIR = path.join(STORAGE_DIR, 'generated');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SESSION_TTL = 8 * 60 * 60 * 1000;
const sessions = new Map();
const rate = new Map();

for (const dir of [STORAGE_DIR, UPLOAD_DIR, THUMB_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function safeName(n) { return String(n).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file'; }
function readVideos() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; } }
function writeVideos(v) { fs.writeFileSync(DATA_FILE, JSON.stringify(v, null, 2)); }
function noStore(res) { res.setHeader('Cache-Control', 'no-store'); }
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
function requestIp(req) { return String(req.ip || req.socket.remoteAddress || 'unknown'); }
function allowRate(key, limit, windowMs) {
  const now = Date.now();
  const rec = rate.get(key) || { count: 0, reset: now + windowMs };
  if (rec.reset <= now) { rec.count = 0; rec.reset = now + windowMs; }
  rec.count++;
  rate.set(key, rec);
  return rec.count <= limit;
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
    if ([301,302,303,307,308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) throw new Error('Unsafe redirect');
      current = await safeRemoteUrl(new URL(loc, current).toString());
      continue;
    }
    return { response, url: current };
  }
  throw new Error('Too many redirects');
}

const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, UPLOAD_DIR),
  filename: (_r, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = safeName(path.basename(file.originalname, ext));
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${base}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 2, fields: 20, fieldSize: 2 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => {
    if (f.fieldname === 'file' && /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(f.originalname) && String(f.mimetype).startsWith('video/')) return cb(null, true);
    if (f.fieldname === 'thumbnail' && /\.(jpg|jpeg|png|webp)$/i.test(f.originalname) && String(f.mimetype).startsWith('image/')) return cb(null, true);
    cb(null, false);
  }
});

function posterPathFor(id) { return path.join(THUMB_DIR, `${id}.jpg`); }
function mimeFromPoster(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
function validateId(id) { return /^[a-zA-Z0-9_-]{1,80}$/.test(id); }
function getVideo(id) { return validateId(id) ? readVideos().find(v => v.id === id) : null; }

// Security headers + cache rules.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(),microphone=(),geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.static(PUBLIC_DIR, { maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0 }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'gta6-media' }));
app.get('/api/videos', (_req, res) => { noStore(res); res.json(readVideos().sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))); });

app.post('/_access', (req, res) => {
  noStore(res);
  const ip = requestIp(req);
  if (!allowRate(`login:${ip}`, 8, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts' });
  const supplied = Buffer.from(String(req.body?.code || ''));
  const expected = Buffer.from(ACCESS_CODE);
  const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!ok) return res.status(401).json({ error: 'Denied' });
  const { token, csrf } = createSession();
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gta6_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}; Priority=High${secure}`);
  res.json({ ok: true });
});
app.get('/_access/check', (req, res) => { noStore(res); const rec = sessionRecord(req); res.json(rec ? { ok: true, csrf: rec.csrf } : { ok: false }); });
app.post('/_logout', requireSession, requireCsrf, (req, res) => { const t = cookies(req.headers.cookie || '').gta6_session; sessions.delete(t); res.setHeader('Set-Cookie', 'gta6_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Priority=High'); res.json({ ok: true }); });

app.get(ADMIN_ROUTE, (req, res) => { noStore(res); res.setHeader('Vary', 'Cookie'); res.sendFile(path.join(PUBLIC_DIR, sessionRecord(req) ? 'control.html' : 'access.html')); });
app.get(`${ADMIN_ROUTE}/control`, requireSession, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'control.html')));

app.post('/api/control/add', requireSession, requireCsrf, (req, res, next) => {
  if (!allowRate(`mut:${requestIp(req)}`, 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests' });
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }])(req, res, err => err ? res.status(400).json({ error: err.message || 'Upload failed' }) : next());
}, async (req, res) => {
  let filePath = null; let thumbPath = null;
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    if (!title) return res.status(400).json({ error: 'Title required' });
    const direct = String(req.body.directUrl || '').trim().slice(0, 2048);
    const file = req.files?.file?.[0] || null;
    const thumb = req.files?.thumbnail?.[0] || null;
    if (!direct && !file) return res.status(400).json({ error: 'Direct URL or file required' });
    if (direct && file) return res.status(400).json({ error: 'Use either a direct URL or a local file' });
    if (thumb && !file) return res.status(400).json({ error: 'Thumbnail requires a local video file' });
    const id = crypto.randomUUID();
    const entry = {
      id,
      title,
      subtitle: String(req.body.subtitle || '').trim().slice(0, 180),
      category: String(req.body.category || 'VIDEO').trim().toUpperCase().slice(0, 40),
      description: String(req.body.description || '').trim().slice(0, 800),
      source: String(req.body.source || 'DIRECT').trim().slice(0, 80),
      quality: String(req.body.quality || '1080P').trim().slice(0, 20),
      mode: direct ? 'remote' : 'local',
      filename: null,
      remoteUrl: null,
      videoUrl: `/api/media/${id}/stream`,
      downloadUrl: `/api/media/${id}/download`,
      poster: `/api/media/${id}/thumb`,
      duration: null,
      size: null,
      createdAt: new Date().toISOString()
    };

    if (file) {
      filePath = path.join(UPLOAD_DIR, path.basename(file.filename));
      entry.filename = file.filename;
      entry.duration = Number(req.body.duration) > 0 && Number(req.body.duration) < 86400 ? Number(req.body.duration) : null;
      entry.size = `${(file.size / 1048576).toFixed(1)} MB`;
      if (thumb) {
        thumbPath = posterPathFor(id);
        fs.copyFileSync(thumb.path, thumbPath);
      }
      if (thumb?.path) { try { fs.unlinkSync(thumb.path); } catch {} }
      if (!fs.existsSync(thumbPath || '')) entry.poster = '/assets/hero-2.jpg';
    } else {
      entry.remoteUrl = await safeRemoteUrl(direct);
      entry.size = String(req.body.size || 'DIRECT').slice(0, 40);
    }

    const videos = readVideos(); videos.push(entry); writeVideos(videos);
    res.json({ ok: true, video: entry });
  } catch (e) {
    for (const p of [filePath, thumbPath]) if (p) { try { fs.unlinkSync(p); } catch {} }
    if (req.files?.thumbnail?.[0]?.path) { try { fs.unlinkSync(req.files.thumbnail[0].path); } catch {} }
    res.status(400).json({ error: e.message || 'Failed' });
  }
});

app.delete('/api/control/:id', requireSession, requireCsrf, (req, res) => {
  if (!allowRate(`mut:${requestIp(req)}`, 60, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests' });
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (v.filename) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(v.filename))); } catch {} }
  try { fs.unlinkSync(posterPathFor(v.id)); } catch {}
  writeVideos(readVideos().filter(x => x.id !== v.id));
  res.json({ ok: true });
});

async function pipeRemote(req, res, url, downloadName) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.method === 'HEAD') {
    const { response } = await fetchSafe(url, { method: 'HEAD', headers });
    if (!response.ok) throw new Error(`Remote source returned ${response.status}`);
    res.status(response.status);
    for (const h of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) { const v=response.headers.get(h); if(v) res.setHeader(h,v); }
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.end();
  }
  const { response: upstream } = await fetchSafe(url, { headers });
  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) throw new Error(`Remote source returned ${upstream.status}`);
  res.status(upstream.status);
  for (const h of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) { const v=upstream.headers.get(h); if(v) res.setHeader(h,v); }
  res.setHeader('Cache-Control','public, max-age=60');
  if (downloadName) res.setHeader('Content-Disposition', `attachment; filename="${safeName(downloadName)}"`);
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

app.get('/api/media/:id/thumb', (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).end();
  if (!v.filename) return res.redirect('/assets/hero-2.jpg');
  const p = posterPathFor(v.id);
  if (!fs.existsSync(p)) return res.redirect('/assets/hero-2.jpg');
  res.type(mimeFromPoster(p));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(p);
});

app.get('/api/media/:id/stream', async (req, res) => {
  try {
    const v = getVideo(req.params.id); if (!v) return res.status(404).end();
    if (v.mode === 'local') {
      const p = path.join(UPLOAD_DIR, path.basename(v.filename || ''));
      if (!fs.existsSync(p)) return res.status(404).end();
      return res.sendFile(p, { acceptRanges: true, cacheControl: true, maxAge: '1m' });
    }
    await pipeRemote(req, res, v.remoteUrl, null);
  } catch { res.status(502).json({ error: 'Media source unavailable' }); }
});

app.get('/api/media/:id/download', async (req, res) => {
  try {
    const v = getVideo(req.params.id); if (!v) return res.status(404).end();
    if (v.mode === 'local') {
      const p = path.join(UPLOAD_DIR, path.basename(v.filename || ''));
      if (!fs.existsSync(p)) return res.status(404).end();
      return res.download(p, safeName(`${v.title}${path.extname(p)}`));
    }
    const ext = path.extname(new URL(v.remoteUrl).pathname) || '.mp4';
    await pipeRemote(req, res, v.remoteUrl, `${safeName(v.title)}${ext}`);
  } catch { res.status(502).send('Download unavailable'); }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/_')) return res.status(404).end();
  if (req.method !== 'GET' || req.path.includes('.')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use((err, _req, res, _next) => { if (!res.headersSent) res.status(500).json({ error: 'Server error' }); });

setInterval(() => { for (const [t, rec] of sessions) if (rec.exp < Date.now()) sessions.delete(t); for (const [k, rec] of rate) if (rec.reset < Date.now()) rate.delete(k); }, 60 * 60 * 1000).unref();
app.listen(PORT, () => console.log(`GTA VI media server on http://localhost:${PORT}`));
