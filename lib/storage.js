// Storage maintenance for the shared data disk. Media originals, finished
// renders, the narration cache, and in-flight render temp folders all live
// on the same disk, so renders need visible headroom and anything a crashed
// process left behind (tmp-* folders, .part uploads) needs sweeping.

import fs from 'node:fs';
import path from 'node:path';
import { listWorkspaces } from './store.js';

const DATA_DIR = process.env.CONTENTSTUDIO_DATA || path.join(process.cwd(), 'data');
const WS_ROOT = path.join(DATA_DIR, 'workspaces');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');

const PART_GRACE_MS = 10 * 60 * 1000;

// Cache eviction ages. Narration re-generates for pennies; finished HeyGen
// avatar clips cost real credits, so they stay much longer. Cache hits
// refresh a file's mtime, so anything still in use never ages out.
const CACHE_MAX_AGE_MS = {
  'narration-cache': 45 * 86400 * 1000,
  'avatar-cache': 120 * 86400 * 1000,
};

const wsDir = (id) => path.join(WS_ROOT, String(id).replace(/[^a-z0-9_-]/gi, ''));

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* raced delete */ } }
    }
  }
  return total;
}

const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

export function diskFree() {
  try {
    const s = fs.statfsSync(DATA_DIR);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

// The shared media library (all businesses' photos/videos) lives outside
// any one workspace directory now, so it gets one top-level report instead
// of a per-workspace mediaBytes figure.
export function libraryReport() {
  let bytes = 0;
  let originalBytes = 0;
  const partUploads = [];
  let files = [];
  try { files = fs.readdirSync(LIBRARY_DIR); } catch { /* no library yet */ }
  for (const f of files) {
    const size = fileSize(path.join(LIBRARY_DIR, f));
    bytes += size;
    if (f.endsWith('.original')) originalBytes += size;
    if (f.endsWith('.part')) partUploads.push({ file: f, bytes: size });
  }
  return { bytes, originalBytes, partUploads };
}

export function storageReport(runningIds = new Set()) {
  const { items, activeId } = listWorkspaces();
  const workspaces = items.map((w) => {
    const dir = wsDir(w.id);
    const rendersDir = path.join(dir, 'renders');
    const tmp = [];
    const renders = [];
    let renderFiles = [];
    try { renderFiles = fs.readdirSync(rendersDir); } catch { /* no renders yet */ }
    for (const f of renderFiles) {
      if (f.startsWith('tmp-')) {
        const id = f.slice(4);
        tmp.push({ id, bytes: dirSize(path.join(rendersDir, f)), running: runningIds.has(id) });
      } else if (f.endsWith('.json')) {
        const id = f.slice(0, -5);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(rendersDir, f), 'utf8')); } catch { /* size only */ }
        renders.push({
          id, topic: meta.topic || null, platformId: meta.platformId || null,
          status: meta.status || 'done', createdAt: meta.createdAt || null,
          duration: meta.duration || null, mp4Bytes: fileSize(path.join(rendersDir, `${id}.mp4`)),
        });
      }
    }
    renders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return {
      id: w.id, name: w.name, active: w.id === activeId,
      totalBytes: dirSize(dir),
      narrationCacheBytes: dirSize(path.join(rendersDir, 'narration-cache')),
      avatarCacheBytes: dirSize(path.join(rendersDir, 'avatar-cache')),
      tmp, renders,
    };
  });
  return { disk: diskFree(), dataDirBytes: dirSize(DATA_DIR), library: libraryReport(), workspaces };
}

// Removes render temp folders that no running job owns, plus interrupted
// partial uploads old enough that no live upload can still be writing them.
export function cleanupStorage(runningIds = new Set()) {
  let freedBytes = 0;
  let removedTmp = 0;
  let removedParts = 0;
  let removedCacheFiles = 0;
  for (const w of listWorkspaces().items) {
    const rendersDir = path.join(wsDir(w.id), 'renders');
    let entries = [];
    try { entries = fs.readdirSync(rendersDir); } catch { /* no renders yet */ }
    for (const f of entries) {
      if (!f.startsWith('tmp-') || runningIds.has(f.slice(4))) continue;
      const p = path.join(rendersDir, f);
      freedBytes += dirSize(p);
      fs.rmSync(p, { recursive: true, force: true });
      removedTmp += 1;
    }
    // Age out cache entries nothing has touched in months; without this the
    // narration and avatar caches grow until the disk fills.
    for (const [cacheName, maxAge] of Object.entries(CACHE_MAX_AGE_MS)) {
      const cacheDir = path.join(rendersDir, cacheName);
      let files = [];
      try { files = fs.readdirSync(cacheDir); } catch { continue; }
      for (const f of files) {
        const p = path.join(cacheDir, f);
        try {
          const st = fs.statSync(p);
          if (Date.now() - st.mtimeMs < maxAge) continue;
          freedBytes += st.size;
          fs.unlinkSync(p);
          removedCacheFiles += 1;
        } catch { /* raced delete */ }
      }
    }
  }
  // The shared library is one directory now, not one per workspace.
  let libraryFiles = [];
  try { libraryFiles = fs.readdirSync(LIBRARY_DIR); } catch { /* no library yet */ }
  for (const f of libraryFiles) {
    if (!f.endsWith('.part')) continue;
    const p = path.join(LIBRARY_DIR, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < PART_GRACE_MS) continue;
      freedBytes += fs.statSync(p).size;
      fs.unlinkSync(p);
      removedParts += 1;
    } catch { /* raced delete */ }
  }
  return { freedBytes, removedTmp, removedParts, removedCacheFiles };
}

export function deleteRender(workspaceId, renderId, runningIds = new Set()) {
  const safeId = String(renderId || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safeId) return { error: 'renderId is required' };
  if (runningIds.has(safeId)) return { error: 'this render is running right now' };
  if (!listWorkspaces().items.some((w) => w.id === workspaceId)) return { error: 'unknown workspace' };
  const rendersDir = path.join(wsDir(workspaceId), 'renders');
  let freedBytes = 0;
  let found = false;
  for (const ext of ['mp4', 'srt', 'json', 'jpg', 'preview.mp4', 'previewpart.mp4']) {
    const f = path.join(rendersDir, `${safeId}.${ext}`);
    if (!fs.existsSync(f)) continue;
    freedBytes += fileSize(f);
    fs.unlinkSync(f);
    found = true;
  }
  // Chapter clips cut from this render (<id>.clip-N.mp4) go with it.
  let entries = [];
  try { entries = fs.readdirSync(rendersDir); } catch { /* gone already */ }
  for (const f of entries) {
    if (!f.startsWith(`${safeId}.clip-`)) continue;
    const p = path.join(rendersDir, f);
    freedBytes += fileSize(p);
    try { fs.unlinkSync(p); found = true; } catch { /* raced delete */ }
  }
  return found ? { ok: true, freedBytes } : { error: 'no files found for that render' };
}
