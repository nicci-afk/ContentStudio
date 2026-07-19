// Authentication: magic-link email sign-in (allowlisted addresses) with
// 30-day session cookies, plus the STUDIO_PASSWORD as password login and
// Basic-auth fallback for API tools. Sessions persist across restarts.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.CONTENTSTUDIO_DATA || path.join(process.cwd(), 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const MAGIC_TTL = 15 * 60 * 1000;
const COOKIE = 'cs_session';

let store = { sessions: {}, pending: {} };
try {
  if (fs.existsSync(AUTH_FILE)) store = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
} catch { /* fresh store */ }

function persist() {
  const now = Date.now();
  for (const [k, v] of Object.entries(store.sessions)) if (v.exp < now) delete store.sessions[k];
  for (const [k, v] of Object.entries(store.pending)) if (v.exp < now) delete store.pending[k];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(store));
  } catch { /* best effort */ }
}

const token = () => crypto.randomBytes(32).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

export const allowedEmails = () =>
  (process.env.MAGIC_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

const emailConfigured = () =>
  !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) || process.env.MAGIC_TEST_MODE);

export const magicEnabled = () => allowedEmails().length > 0 && emailConfigured();
export const authEnabled = () => !!process.env.STUDIO_PASSWORD || allowedEmails().length > 0;

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

function sessionEmail(req) {
  const t = parseCookies(req)[COOKIE];
  const s = t && store.sessions[t];
  return s && s.exp > Date.now() ? s.email : null;
}

function startSession(res, email) {
  const t = token();
  store.sessions[t] = { email, exp: Date.now() + SESSION_TTL };
  persist();
  res.setHeader('Set-Cookie',
    `${COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${process.env.NODE_ENV === 'development' ? '' : '; Secure'}`);
}

function basicAuthValid(req) {
  const password = process.env.STUDIO_PASSWORD;
  if (!password) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  return safeEqual(decoded.slice(decoded.indexOf(':') + 1), password);
}

const PUBLIC_PREFIXES = ['/auth/', '/login'];
const PUBLIC_PATHS = new Set(['/api/health', '/llms.txt', '/favicon.ico']);

export function authMiddleware(req, res, next) {
  if (!authEnabled()) return next();
  if (PUBLIC_PATHS.has(req.path) || PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  if (sessionEmail(req)) return next();
  if (basicAuthValid(req)) return next();
  if (req.path.startsWith('/api/')) {
    res.set('WWW-Authenticate', 'Basic realm="ContentStudio"');
    return res.status(401).json({ error: 'sign in required' });
  }
  return res.redirect('/login');
}

// ---- email delivery ------------------------------------------------------

async function sendMagicEmail(to, link) {
  const subject = 'Your ContentStudio sign-in link';
  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:440px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 4px">◆ ContentStudio</h2>
      <p style="color:#555">Click to sign in. This link works once and expires in 15 minutes.</p>
      <p style="margin:24px 0"><a href="${link}" style="background:#7c6cff;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Sign in to ContentStudio</a></p>
      <p style="color:#999;font-size:12px">If you didn't request this, ignore this email.</p>
    </div>`;
  if (process.env.MAGIC_TEST_MODE) return { testLink: link };
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.MAGIC_FROM || 'ContentStudio <onboarding@resend.dev>',
        to, subject, html,
      }),
    });
    if (!res.ok) throw new Error(`email send failed: ${(await res.text()).slice(0, 200)}`);
    return {};
  }
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({
    from: process.env.MAGIC_FROM || process.env.SMTP_USER,
    to, subject, html,
  });
  return {};
}

// ---- routes --------------------------------------------------------------

const lastSent = new Map();

export function registerAuthRoutes(app, publicDir) {
  app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));

  app.get('/auth/config', (req, res) => {
    res.json({ magic: magicEnabled(), password: !!process.env.STUDIO_PASSWORD });
  });

  app.post('/auth/magic/request', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!magicEnabled()) return res.status(424).json({ error: 'magic links not configured on this server' });
      if ((lastSent.get(email) || 0) > Date.now() - 60000) {
        return res.json({ ok: true, message: 'If that email is registered, a link is on its way.' });
      }
      if (allowedEmails().includes(email)) {
        const t = token();
        store.pending[t] = { email, exp: Date.now() + MAGIC_TTL };
        persist();
        lastSent.set(email, Date.now());
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const link = `${proto}://${req.headers.host}/auth/magic/verify?token=${t}`;
        const result = await sendMagicEmail(email, link);
        return res.json({ ok: true, message: 'If that email is registered, a link is on its way.', ...(result.testLink ? { testLink: result.testLink } : {}) });
      }
      res.json({ ok: true, message: 'If that email is registered, a link is on its way.' });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/auth/magic/verify', (req, res) => {
    const t = String(req.query.token || '');
    const pending = store.pending[t];
    if (!pending || pending.exp < Date.now()) {
      return res.status(400).send('This sign-in link is invalid or expired. <a href="/login">Request a new one</a>.');
    }
    delete store.pending[t];
    startSession(res, pending.email);
    res.redirect('/');
  });

  app.post('/auth/password', (req, res) => {
    const password = process.env.STUDIO_PASSWORD;
    if (!password) return res.status(424).json({ error: 'password login not configured' });
    if (!safeEqual(String(req.body?.password || ''), password)) {
      return res.status(401).json({ error: 'wrong password' });
    }
    startSession(res, 'password-user');
    res.json({ ok: true });
  });

  app.post('/auth/logout', (req, res) => {
    const t = parseCookies(req)[COOKIE];
    if (t) { delete store.sessions[t]; persist(); }
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
}
