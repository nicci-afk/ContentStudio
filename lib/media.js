// Media storage tiers. Previews, analysis copies and full-quality originals
// live in the object bucket (R2); the Render disk keeps only a small,
// bounded cache. Items created before the bucket existed keep their files on
// disk in the library folder and keep working: every read checks the disk
// first, then the cache, then the bucket.
//
// Per-item record: item.r2 = { thumb, analysis, render, original, preview }
// (true when that kind is in the bucket). Object keys are id-based, so a
// library move or rename never touches storage:
//   <R2_MEDIA_PREFIX>/<item id>/<kind>

import fs from 'node:fs';
import path from 'node:path';
import { mediaPath, saveMediaFile, deleteMediaFiles, catalog } from './store.js';
import { proxyUrl } from './media-proxy.js';
import {
  s3Configured, s3Config, putObject, putFile, getObjectBuffer, getObjectToFile,
  deleteObject, headObject, presign,
} from './s3.js';

const DATA_DIR = process.env.CONTENTSTUDIO_DATA || path.join(process.cwd(), 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'media');
fs.mkdirSync(CACHE_DIR, { recursive: true });

export const KINDS = ['thumb', 'analysis', 'render', 'original', 'preview'];
const CACHE_MAX_BYTES = Number(process.env.MEDIA_CACHE_MB || 2048) * 1024 * 1024;
const CACHE_PROTECT_MS = 2 * 3600 * 1000; // never evict what a render may be reading

export const objectKey = (id, kind) => `${s3Config().mediaPrefix}/${String(id).replace(/[^a-z0-9_-]/gi, '')}/${kind}`;
const cachePath = (id, kind) => path.join(CACHE_DIR, `${String(id).replace(/[^a-z0-9_-]/gi, '')}.${kind}`);
const localPath = (id, kind) => mediaPath(id, kind);
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const touch = (f) => { try { const t = new Date(); fs.utimesSync(f, t, t); } catch { /* best effort */ } };
const contentTypeFor = (kind, item) => (kind === 'original' ? (item?.mime || 'application/octet-stream') : kind === 'preview' ? 'video/mp4' : 'image/jpeg');

export const storedInBucket = (item, kind) => !!item?.r2?.[kind];

// True when this kind of the item can be served from disk, cache or bucket.
export function hasStored(item, kind) {
  return exists(localPath(item.id, kind)) || exists(cachePath(item.id, kind)) || storedInBucket(item, kind);
}

// Path of the kind on disk (library folder or cache) or null; never touches
// the bucket. Routes use it to decide between sending a file and redirecting
// to a signed link.
export function onDisk(item, kind) {
  for (const f of [localPath(item.id, kind), cachePath(item.id, kind)]) {
    if (exists(f)) { touch(f); return f; }
  }
  return null;
}

// Buffer for a stored kind (small files: thumbs, analysis frames, stills).
export async function readMedia(item, kind) {
  for (const f of [localPath(item.id, kind), cachePath(item.id, kind)]) {
    if (exists(f)) { touch(f); return fs.readFileSync(f); }
  }
  if (!storedInBucket(item, kind)) return null;
  const buf = await getObjectBuffer(objectKey(item.id, kind));
  if (buf && kind !== 'original') {
    try { fs.writeFileSync(cachePath(item.id, kind), buf); } catch { /* cache is best effort */ }
    pruneCache();
  }
  return buf;
}

// Best still frame for rendering: full-quality first.
export async function readStill(item) {
  const jpegLike = /^image\/(jpeg|png)$/i.test(item.mime || '');
  if (item.kind === 'image' && jpegLike && item.size && item.size <= 40 * 1024 * 1024 && hasStored(item, 'original')) {
    const orig = await readMedia(item, 'original');
    if (orig) return orig;
  }
  for (const kind of ['render', 'analysis', 'thumb']) {
    const buf = await readMedia(item, kind);
    if (buf) return buf;
  }
  return null;
}

// A local file path for a stored kind, downloading into the cache when the
// bytes only exist in the bucket. For huge originals prefer sourceFor().
export async function localFile(item, kind) {
  for (const f of [localPath(item.id, kind), cachePath(item.id, kind)]) {
    if (exists(f)) { touch(f); return f; }
  }
  if (!storedInBucket(item, kind)) return null;
  const f = cachePath(item.id, kind);
  const bytes = await getObjectToFile(objectKey(item.id, kind), f);
  if (bytes === null) return null;
  pruneCache();
  return f;
}

// Where ffmpeg should read an item's original: a local path when one exists,
// otherwise a loopback URL it can seek through with HTTP range requests, so
// a render only transfers the parts of each clip it uses.
export function sourceFor(item, kind = 'original') {
  for (const f of [localPath(item.id, kind), cachePath(item.id, kind)]) {
    if (exists(f)) { touch(f); return { file: f }; }
  }
  if (storedInBucket(item, kind)) {
    // The loopback proxy keeps ffmpeg off DNS and TLS (see media-proxy.js);
    // a signed URL is only the fallback if the proxy is not running.
    const key = objectKey(item.id, kind);
    return { url: proxyUrl(key) || presign('GET', key, { expires: 6 * 3600 }), remote: true };
  }
  return null;
}

// Short-lived signed link, or null when the kind is not in the bucket.
export function mediaUrl(item, kind, expires = 3600) {
  return storedInBucket(item, kind) ? presign('GET', objectKey(item.id, kind), { expires }) : null;
}

// New files go to the bucket when it is configured (so the Render disk never
// fills), otherwise to the library folder. Returns the r2 flag to merge into
// the item record.
export async function storeMedia(id, kind, buffer, item = null) {
  if (s3Configured()) {
    await putObject(objectKey(id, kind), buffer, contentTypeFor(kind, item));
    return { [kind]: true };
  }
  saveMediaFile(id, kind, buffer);
  return {};
}

export async function removeMedia(item) {
  deleteMediaFiles(item.id);
  for (const kind of KINDS) {
    const f = cachePath(item.id, kind);
    if (exists(f)) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    if (storedInBucket(item, kind)) { try { await deleteObject(objectKey(item.id, kind)); } catch { /* best effort */ } }
  }
}

// ---- cache eviction (least recently used, protecting recent files) --------

let pruning = false;
export function pruneCache() {
  if (pruning) return { skipped: true };
  pruning = true;
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter((f) => !f.endsWith('.part'))
      .map((f) => { const p = path.join(CACHE_DIR, f); const st = fs.statSync(p); return { p, size: st.size, t: st.mtimeMs }; });
    let total = files.reduce((a, f) => a + f.size, 0);
    let removed = 0;
    for (const f of files.sort((a, b) => a.t - b.t)) {
      if (total <= CACHE_MAX_BYTES) break;
      if (Date.now() - f.t < CACHE_PROTECT_MS) continue;
      try { fs.unlinkSync(f.p); total -= f.size; removed += 1; } catch { /* raced */ }
    }
    return { bytes: total, removed };
  } catch { return { bytes: 0, removed: 0 }; } finally { pruning = false; }
}

export function cacheReport() {
  let bytes = 0; let files = 0;
  try { for (const f of fs.readdirSync(CACHE_DIR)) { bytes += fs.statSync(path.join(CACHE_DIR, f)).size; files += 1; } } catch { /* empty */ }
  return { bytes, files, maxBytes: CACHE_MAX_BYTES };
}

// ---- migration of the on-disk library into the bucket ----------------------
// Copies each file, verifies the object size matches, flags the item, and only
// then removes the local copy. Idempotent: kinds already flagged are skipped,
// so an interrupted run resumes cleanly, and nothing is deleted before its
// copy is verified.

export const migrationState = { running: false, done: 0, total: 0, bytes: 0, errors: [], startedAt: null, finishedAt: null };

export async function migrateToBucket({ limit = Infinity, dryRun = false, deleteLocal = true } = {}) {
  if (!s3Configured()) throw new Error('object storage is not configured (R2_* env vars)');
  if (migrationState.running) throw new Error('a migration is already running');
  Object.assign(migrationState, { running: true, done: 0, total: 0, bytes: 0, errors: [], startedAt: new Date().toISOString(), finishedAt: null, dryRun });
  try {
    const todo = [];
    for (const item of catalog.all()) {
      for (const kind of KINDS) {
        if (storedInBucket(item, kind)) continue;
        if (exists(localPath(item.id, kind))) todo.push({ item, kind });
      }
    }
    migrationState.total = Math.min(todo.length, limit);
    for (const { item, kind } of todo.slice(0, limit)) {
      const file = localPath(item.id, kind);
      try {
        const size = fs.statSync(file).size;
        if (!dryRun) {
          await putFile(objectKey(item.id, kind), file, contentTypeFor(kind, item));
          const head = await headObject(objectKey(item.id, kind));
          if (!head || head.size !== size) throw new Error(`size mismatch after copy (${head?.size} vs ${size})`);
          catalog.patch(item.id, { r2: { ...(item.r2 || {}), [kind]: true } });
          if (deleteLocal) fs.unlinkSync(file);
        }
        migrationState.bytes += size;
      } catch (err) {
        migrationState.errors.push({ id: item.id, kind, error: String(err.message || err).slice(0, 200) });
      }
      migrationState.done += 1;
    }
    catalog.flush();
    return { ...migrationState };
  } finally {
    migrationState.running = false;
    migrationState.finishedAt = new Date().toISOString();
  }
}
