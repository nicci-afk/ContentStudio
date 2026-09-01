// Off-site backups. Everything irreplaceable in the studio is JSON (the
// workspace registry, each workspace's profile/media catalog/packages, and
// per-render metadata with chapters and section offsets), so it all bundles
// into one gzipped object and uploads to an S3-compatible bucket, built for
// Cloudflare R2. SigV4 signing is hand-rolled on node:crypto so the
// dependency count stays at zero. Media originals and finished MP4s are not
// included: they are large, and the master copies live on the platforms and
// in the creator's own storage once published.
//
// Configure with env vars (all four required to activate):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Optional: R2_ENDPOINT (any S3-compatible endpoint), R2_PREFIX (default
// "backups"). One bundle per UTC day, kept ~30 days.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { listWorkspaces, stateStore, mediaStore, packageStore } from './store.js';

const DATA_DIR = process.env.CONTENTSTUDIO_DATA || path.join(process.cwd(), 'data');
const STATUS_FILE = path.join(DATA_DIR, 'backup.json');
const KEEP_DAYS = 30;
const DAILY_MS = 22 * 3600 * 1000; // "at least daily" with slack for restarts

const cfg = () => {
  const accountId = process.env.R2_ACCOUNT_ID || '';
  return {
    accessKey: process.env.R2_ACCESS_KEY_ID || '',
    secretKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || '',
    endpoint: process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ''),
    prefix: (process.env.R2_PREFIX || 'backups').replace(/^\/+|\/+$/g, ''),
  };
};

export const backupConfigured = () => {
  const c = cfg();
  return !!(c.accessKey && c.secretKey && c.bucket && c.endpoint);
};

// ---- SigV4 (S3, region "auto" per R2) ------------------------------------

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

async function s3Request(method, key, body = null, contentType = null) {
  const c = cfg();
  const url = new URL(c.endpoint);
  const region = 'auto';
  const service = 's3';
  const canonicalUri = `/${c.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body || Buffer.alloc(0));

  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${c.secretKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const sendHeaders = { ...headers };
  delete sendHeaders.host; // fetch derives it from the URL; it stays in the signature
  sendHeaders.authorization =
    `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;

  return fetch(`${url.origin}${canonicalUri}`, { method, headers: sendHeaders, body: body || undefined });
}

// ---- bundle + status -----------------------------------------------------

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

function collectBundle() {
  // The stores debounce writes; flushing the active workspace first makes
  // sure the files on disk carry the newest in-memory edits.
  try { stateStore.flush(); mediaStore.flush(); packageStore.flush(); } catch { /* best effort */ }
  const bundle = {
    takenAt: new Date().toISOString(),
    registry: readJson(path.join(DATA_DIR, 'workspaces.json')),
    // The media catalog (not the binary files — see the note above) is one
    // shared library now, not one per workspace.
    library: readJson(path.join(DATA_DIR, 'library.json')),
    workspaces: {},
  };
  for (const w of listWorkspaces().items) {
    const dir = path.join(DATA_DIR, 'workspaces', String(w.id).replace(/[^a-z0-9_-]/gi, ''));
    const ws = {
      name: w.name,
      state: readJson(path.join(dir, 'state.json')),
      packages: readJson(path.join(dir, 'packages.json')),
      renders: {},
    };
    const rendersDir = path.join(dir, 'renders');
    let files = [];
    try { files = fs.readdirSync(rendersDir); } catch { /* no renders yet */ }
    for (const f of files) {
      if (f.endsWith('.json')) ws.renders[f.slice(0, -5)] = readJson(path.join(rendersDir, f));
    }
    bundle.workspaces[w.id] = ws;
  }
  return bundle;
}

let status = readJson(STATUS_FILE) || {};
function saveStatus(patch) {
  status = { ...status, ...patch };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch { /* best effort */ }
}

export function backupStatus() {
  return { configured: backupConfigured(), ...status };
}

let running = null;

export function runBackup() {
  if (running) return running;
  running = (async () => {
    if (!backupConfigured()) {
      const error = 'backups not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET';
      saveStatus({ lastAttempt: new Date().toISOString(), lastError: error });
      throw new Error(error);
    }
    const c = cfg();
    const day = new Date().toISOString().slice(0, 10);
    const key = `${c.prefix}/state-${day}.json.gz`;
    saveStatus({ lastAttempt: new Date().toISOString() });
    const body = zlib.gzipSync(Buffer.from(JSON.stringify(collectBundle())), { level: 9 });
    const res = await s3Request('PUT', key, body, 'application/gzip');
    if (!res.ok) {
      const error = `upload failed ${res.status}: ${(await res.text()).slice(0, 300)}`;
      saveStatus({ lastError: error });
      throw new Error(error);
    }
    saveStatus({ lastSuccess: new Date().toISOString(), lastError: null, lastKey: key, lastBytes: body.length });
    // Retention: drop the bundle that just aged past the keep window.
    const old = new Date(Date.now() - KEEP_DAYS * 86400 * 1000).toISOString().slice(0, 10);
    await s3Request('DELETE', `${c.prefix}/state-${old}.json.gz`).catch(() => {});
    return { ok: true, key, bytes: body.length };
  })().finally(() => { running = null; });
  return running;
}

export function scheduleBackups() {
  if (!backupConfigured()) {
    console.log('  backups: off (set the R2_* env vars to enable nightly off-site backups)');
    return;
  }
  const due = () => !status.lastSuccess || Date.now() - Date.parse(status.lastSuccess) > DAILY_MS;
  const tick = () => {
    if (!due()) return;
    runBackup()
      .then((r) => console.log(`  backups: uploaded ${r.key} (${Math.round(r.bytes / 1024)}KB)`))
      .catch((err) => console.warn(`  backups: failed: ${err.message}`));
  };
  setTimeout(tick, 90 * 1000); // settle after boot, then hourly checks
  setInterval(tick, 3600 * 1000).unref?.();
  console.log(`  backups: on (daily to ${cfg().bucket}/${cfg().prefix}, keep ${KEEP_DAYS} days)`);
}
