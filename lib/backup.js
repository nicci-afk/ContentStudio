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
import zlib from 'node:zlib';
import { s3Configured, s3Config, putObject, deleteObject } from './s3.js';
import { listWorkspaces, stateStore, mediaStore, packageStore } from './store.js';

const DATA_DIR = process.env.CONTENTSTUDIO_DATA || path.join(process.cwd(), 'data');
const STATUS_FILE = path.join(DATA_DIR, 'backup.json');
const KEEP_DAYS = 30;
const DAILY_MS = 22 * 3600 * 1000; // "at least daily" with slack for restarts

const prefix = () => (process.env.R2_PREFIX || 'backups').replace(/^\/+|\/+$/g, '');

export const backupConfigured = () => s3Configured();

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
    // Photos albums and their AI profiles live beside the catalog.
    albums: readJson(path.join(DATA_DIR, 'albums.json')),
    workspaces: {},
  };
  for (const w of listWorkspaces().items) {
    const dir = path.join(DATA_DIR, 'workspaces', String(w.id).replace(/[^a-z0-9_-]/gi, ''));
    const ws = {
      name: w.name,
      state: readJson(path.join(dir, 'state.json')),
      packages: readJson(path.join(dir, 'packages.json')),
      leads: readJson(path.join(dir, 'leads.json')),
      ledger: readJson(path.join(dir, 'ledger.json')),
      trips: readJson(path.join(dir, 'trips.json')),
      studio: readJson(path.join(dir, 'studio.json')),
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
    const day = new Date().toISOString().slice(0, 10);
    const key = `${prefix()}/state-${day}.json.gz`;
    saveStatus({ lastAttempt: new Date().toISOString() });
    const body = zlib.gzipSync(Buffer.from(JSON.stringify(collectBundle())), { level: 9 });
    try {
      await putObject(key, body, 'application/gzip');
    } catch (err) {
      const error = String(err.message || err).slice(0, 300);
      saveStatus({ lastError: error });
      throw new Error(error);
    }
    saveStatus({ lastSuccess: new Date().toISOString(), lastError: null, lastKey: key, lastBytes: body.length });
    // Retention: drop the bundle that just aged past the keep window.
    const old = new Date(Date.now() - KEEP_DAYS * 86400 * 1000).toISOString().slice(0, 10);
    await deleteObject(`${prefix()}/state-${old}.json.gz`).catch(() => {});
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
  console.log(`  backups: on (daily to ${s3Config().bucket}/${prefix()}, keep ${KEEP_DAYS} days)`);
}
