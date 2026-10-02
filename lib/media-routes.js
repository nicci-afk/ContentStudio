// Media, ingest, moderation and album routes. Everything is scoped to the
// requesting workspace's library (catalog.mine / catalog.inLibrary), so one
// business can never read, list or fetch another library's items, and held
// items never produce a preview, a download or a selectable record.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  catalog, albumStore, uid, mediaStore, isUsable, listWorkspaces, DEFAULT_LIBRARY, currentLibrary,
} from './store.js';
import {
  onDisk, readMedia, mediaUrl, sourceFor, storeMedia, removeMedia, hasStored, objectKey, storedInBucket,
  migrateToBucket, migrationState, cacheReport, KINDS,
} from './media.js';
import {
  s3Configured, presign, putStream, createMultipart, presignPart, completeMultipart, listParts, headObject,
} from './s3.js';
import { analyzeMedia } from './engine.js';
import { applyAnalysis, pendingModeration, holdItem, heldList, approveRelease, revokeRelease, moderationCounts } from './moderation.js';
import { runAnalysis, analysisState, estimateAnalysis, runSafetyScan, scanState } from './analysis.js';
import { albumIdFor, albumList, albumStats, buildAlbumProfile, buildMissingProfiles, albumJob } from './albums.js';

const MAX_LOCAL_ORIGINAL = 500 * 1024 * 1024;
const MAX_BUCKET_ORIGINAL = 5 * 1024 * 1024 * 1024; // one streamed PUT; larger files go through the Mac sync (multipart)
const PROTECTED = new Set(['id', 'moderation', 'r2', 'library', 'photosUuid', 'albums', 'apple', 'videoMeta', 'hasOriginal', 'addedAt']);

const slugFor = (item) => String(item.alt || item.caption || item.name || 'media')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'media';
const extFor = (item, fallback) => {
  const e = String(item.name || '').split('.').pop().toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(e) ? e : fallback;
};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export const itemIdFor = (library, uuid) =>
  `ph${crypto.createHash('sha1').update(`${library}:${uuid}`).digest('hex').slice(0, 14)}`;

export function registerMediaRoutes(app, { wrap, stateStore, ffmpegPath }) {
  const visible = (i) => i && i.moderation?.status !== 'held';

  // ---- listing ----------------------------------------------------------
  // Paginated and filterable: the library can hold tens of thousands of items.
  app.get('/api/media', (req, res) => {
    const { album, q, kind, sort = 'taken', usable, favorite, from, to } = req.query;
    const limit = Math.min(Math.max(num(req.query.limit, 200), 1), 1000);
    const offset = Math.max(num(req.query.offset, 0), 0);
    let items = catalog.inLibrary().filter(visible);
    if (usable === '1') items = items.filter(isUsable);
    if (kind === 'image' || kind === 'video') items = items.filter((i) => i.kind === kind);
    if (album) items = items.filter((i) => i.albums?.includes(album));
    if (favorite === '1') items = items.filter((i) => i.apple?.favorite);
    if (from) items = items.filter((i) => (i.takenAt || '') >= String(from));
    if (to) items = items.filter((i) => (i.takenAt || '') <= `${String(to)}~`);
    if (q) {
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      items = items.filter((i) => {
        const hay = `${i.name} ${i.alt || ''} ${i.caption || ''} ${(i.keywords || []).join(' ')} ${i.place || ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const by = {
      taken: (a, b) => (b.takenAt || b.addedAt || '').localeCompare(a.takenAt || a.addedAt || ''),
      added: (a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''),
      quality: (a, b) => (b.quality || 0) - (a.quality || 0),
    }[sort] || null;
    if (by) items = [...items].sort(by);
    res.json({ items: items.slice(offset, offset + limit), total: items.length, offset, limit, ...moderationCounts() });
  });

  // Which of these files (name + size) are already in the library? Lets the
  // in-app import skip duplicates and attach footage to "frame only" videos
  // without downloading the whole catalog to the browser.
  app.post('/api/media/match', (req, res) => {
    const want = new Set((req.body?.files || []).slice(0, 3000).map((f) => `${f.name}|${f.size}`));
    const items = [];
    if (want.size) {
      for (const i of catalog.inLibrary()) {
        if (visible(i) && want.has(`${i.name}|${i.size}`)) items.push({ id: i.id, name: i.name, size: i.size, kind: i.kind, hasOriginal: !!i.hasOriginal });
      }
    }
    res.json({ items });
  });

  // Static paths first: Express matches in registration order, and
  // '/api/media/:id' would otherwise swallow 'analysis' and 'migrate'.
  // Library-wide analysis, newest captures first, running in the background.
  app.get('/api/media/analysis', (req, res) => {
    res.json({ state: { ...analysisState }, estimate: estimateAnalysis(currentLibrary(), req.query.duplicates === '1') });
  });
  app.post('/api/media/analysis', wrap(async (req, res) => {
    if (analysisState.running) return res.status(409).json({ error: 'analysis is already running', state: { ...analysisState } });
    const profile = stateStore.get().profile;
    const library = currentLibrary();
    const opts = {
      profile, library, limit: num(req.body?.limit, Infinity),
      concurrency: Math.min(Math.max(num(req.body?.concurrency, 3), 1), 6),
      includeDuplicates: !!req.body?.includeDuplicates,
    };
    const estimate = estimateAnalysis(library, opts.includeDuplicates);
    if (req.body?.dryRun) return res.json({ estimate });
    runAnalysis(opts).catch((err) => { analysisState.stopped = String(err.message || err).slice(0, 200); });
    res.json({ started: true, estimate });
  }));

  // ---- migration of the existing on-disk library into the bucket -------------
  app.get('/api/media/migrate', (req, res) => res.json({ configured: s3Configured(), state: { ...migrationState }, cache: cacheReport() }));
  app.post('/api/media/migrate', wrap(async (req, res) => {
    if (!s3Configured()) return res.status(412).json({ error: 'object storage is not configured (R2_* env vars)' });
    if (migrationState.running) return res.status(409).json({ error: 'already running', state: { ...migrationState } });
    const opts = { limit: num(req.body?.limit, Infinity), dryRun: !!req.body?.dryRun, deleteLocal: req.body?.deleteLocal !== false };
    if (opts.dryRun) return res.json(await migrateToBucket(opts));
    migrateToBucket(opts).catch((err) => migrationState.errors.push({ error: String(err.message || err).slice(0, 200) }));
    res.json({ started: true });
  }));

  app.get('/api/media/:id', (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!visible(item)) return res.status(404).json({ error: 'not found' });
    res.json({ item });
  });

  // ---- browser import (existing flow) ------------------------------------
  app.post('/api/media', wrap(async (req, res) => {
    const { name, mime, kind, size, w, h, takenAt, gps, thumbB64, analysisB64, renderB64 } = req.body;
    const id = uid();
    const record = {
      id, name, mime, kind: kind || (String(mime).startsWith('video') ? 'video' : 'image'),
      size: size || 0, w: w || null, h: h || null,
      takenAt: takenAt || null, gps: gps || null,
      alt: null, caption: null, keywords: [], place: null, quality: null, storyIdeas: [],
      analyzed: false, hasOriginal: false, addedAt: new Date().toISOString(),
      library: currentLibrary(), r2: {},
      // Unscreened until analysis returns a clean safety verdict.
      moderation: pendingModeration(),
    };
    for (const [kindName, b64] of [['thumb', thumbB64], ['analysis', analysisB64], ['render', renderB64]]) {
      if (b64) Object.assign(record.r2, await storeMedia(id, kindName, Buffer.from(b64, 'base64'), record));
    }
    catalog.upsertMany([record]);
    res.json({ item: record });
  }));

  // ---- files -----------------------------------------------------------
  app.get('/api/media/:id/thumb', (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!visible(item)) return res.status(404).end();
    const file = onDisk(item, 'thumb');
    if (file) { res.set('Cache-Control', 'private, max-age=86400'); return res.type('image/jpeg').sendFile(file); }
    const url = mediaUrl(item, 'thumb', 3600);
    if (!url) return res.status(404).end();
    // The redirect itself is cacheable, so the browser keeps one signed URL
    // (and its image) for most of an hour instead of re-signing per view.
    res.set('Cache-Control', 'private, max-age=3000');
    res.redirect(302, url);
  });

  app.get('/api/media/:id/poster', (req, res) => {
    // Larger still for the detail view: the render still, then the analysis frame.
    const item = catalog.mine(req.params.id);
    if (!visible(item)) return res.status(404).end();
    for (const kind of ['render', 'analysis', 'thumb']) {
      const file = onDisk(item, kind);
      if (file) { res.set('Cache-Control', 'private, max-age=86400'); return res.type('image/jpeg').sendFile(file); }
      const url = mediaUrl(item, kind, 3600);
      if (url) { res.set('Cache-Control', 'private, max-age=3000'); return res.redirect(302, url); }
    }
    res.status(404).end();
  });

  // Streaming preview for the detail view (video proxy), when one exists.
  app.get('/api/media/:id/preview', (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!visible(item)) return res.status(404).end();
    const file = onDisk(item, 'preview');
    if (file) return res.type('video/mp4').sendFile(file);
    const url = mediaUrl(item, 'preview', 3600);
    if (!url) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3000');
    res.redirect(302, url);
  });

  // Full-size download: the strongest stored copy (the original when it was
  // uploaded, the full-resolution still otherwise), named from the alt text so
  // keywords travel with the file. Bucket originals go out as a signed
  // redirect, so a 2GB video never streams through the app server.
  app.get('/api/media/:id/file', (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!visible(item)) return res.status(404).end();
    const slug = slugFor(item);
    const dispose = (name) => `attachment; filename="${name}"`;
    const wantsOriginal = item.kind === 'video' || (item.kind === 'image' && hasStored(item, 'original'));
    if (wantsOriginal) {
      const ext = extFor(item, item.kind === 'video' ? 'mp4' : 'jpg');
      const file = onDisk(item, 'original');
      if (file) {
        res.set('Content-Disposition', dispose(`${slug}.${ext}`));
        return res.type(item.mime || 'application/octet-stream').sendFile(file);
      }
      if (storedInBucket(item, 'original')) {
        const url = presign('GET', objectKey(item.id, 'original'), {
          expires: 3600,
          query: { 'response-content-disposition': dispose(`${slug}.${ext}`), 'response-content-type': item.mime || 'application/octet-stream' },
        });
        return res.redirect(302, url);
      }
    }
    (async () => {
      for (const kind of ['render', 'analysis', 'thumb']) {
        const buf = await readMedia(item, kind);
        if (buf) {
          res.set('Content-Disposition', dispose(`${slug}.jpg`));
          return res.type('image/jpeg').send(buf);
        }
      }
      res.status(404).end();
    })().catch(() => res.status(500).end());
  });

  // Muted video download: same footage, audio removed on the fly.
  app.get('/api/media/:id/file/muted', (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!visible(item) || item.kind !== 'video') return res.status(404).end();
    const src = sourceFor(item, 'original');
    if (!src) return res.status(404).end();
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${slugFor(item)}-muted.mp4"`);
    const proc = spawn(ffmpegPath(), [
      '-i', src.file || src.url, '-c:v', 'copy', '-an',
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.pipe(res);
    res.on('close', () => proc.kill());
    proc.on('error', () => { try { res.end(); } catch { /* ignore */ } });
  });

  // Original video upload from the in-app import: streamed, never buffered.
  // With the bucket configured it goes straight there (5GB per file); without
  // it, to disk under the old 500MB cap.
  app.post('/api/media/:id/original', wrap(async (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!visible(item)) return res.status(404).json({ error: 'not found' });
    if (item.kind !== 'video') return res.status(400).json({ error: 'originals are only stored for videos' });
    const declared = Number(req.headers['content-length'] || 0);
    const cap = s3Configured() ? MAX_BUCKET_ORIGINAL : MAX_LOCAL_ORIGINAL;
    if (declared > cap) return res.status(413).json({ error: `video is larger than the ${Math.round(cap / 1024 / 1024)}MB per-file limit here; use the Photos sync tool for files this large` });
    if (s3Configured()) {
      if (!declared) return res.status(411).json({ error: 'content-length required' });
      await putStream(objectKey(item.id, 'original'), req, declared, item.mime || 'video/mp4');
      catalog.patch(item.id, { hasOriginal: true, r2: { ...(item.r2 || {}), original: true } });
      return res.json({ ok: true, bytes: declared });
    }
    const { mediaPath } = await import('./store.js');
    const file = mediaPath(item.id, 'original');
    const partial = `${file}.part`;
    const out = fs.createWriteStream(partial);
    let received = 0; let failed = false;
    const abort = (code, message) => {
      if (failed) return;
      failed = true; out.destroy(); fs.rm(partial, { force: true }, () => {}); req.destroy();
      if (!res.headersSent) res.status(code).json({ error: message });
    };
    req.on('data', (chunk) => { received += chunk.length; if (received > cap) abort(413, 'video is larger than the 500MB per-file limit'); });
    req.on('error', () => abort(400, 'upload interrupted'));
    out.on('error', () => abort(500, 'could not write the video to disk'));
    out.on('finish', () => {
      if (failed) return;
      fs.rename(partial, file, (err) => {
        if (err) return abort(500, 'could not store the video');
        catalog.patch(item.id, { hasOriginal: true });
        res.json({ ok: true, bytes: received });
      });
    });
    req.pipe(out);
  }));

  // ---- analysis -------------------------------------------------------------
  app.post('/api/media/:id/analyze', wrap(async (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!visible(item)) return res.status(404).json({ error: 'not found' });
    const buf = (await readMedia(item, 'analysis')) || (await readMedia(item, 'thumb'));
    if (!buf) return res.status(400).json({ error: 'no analyzable frame stored for this item' });
    const albumNames = new Map(albumStore.inLibrary().map((a) => [a.id, a.name]));
    const result = await analyzeMedia({
      b64: buf.toString('base64'), name: item.name, kind: item.kind, takenAt: item.takenAt,
      profile: stateStore.get().profile, frames: item.videoMeta?.frames || null,
      context: {
        albums: (item.albums || []).map((id) => albumNames.get(id)).filter(Boolean),
        title: item.apple?.title, description: item.apple?.description, place: item.apple?.place,
        labels: item.apple?.labels, keywords: item.apple?.keywords,
      },
    });
    const out = await applyAnalysis(item, result);
    if (out.held) return res.json({ held: true, reason: out.reason, item: null });
    res.json({ item: catalog.byId(item.id), held: false });
  }));

  const PATCHABLE_BLOCK = PROTECTED;
  app.patch('/api/media/:id', (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!visible(item)) return res.status(404).json({ error: 'not found' });
    const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => !PATCHABLE_BLOCK.has(k)));
    res.json({ item: catalog.patch(item.id, patch) });
  });

  app.delete('/api/media/:id', wrap(async (req, res) => {
    const item = catalog.mine(req.params.id);
    if (!item) return res.json({ ok: true });
    await removeMedia(item);
    catalog.remove(item.id);
    res.json({ ok: true });
  }));

  // ---- moderation (private review; metadata only, never an image) -------------
  app.get('/api/moderation', (req, res) => {
    res.json({ counts: moderationCounts(), held: heldList(), scan: { ...scanState } });
  });
  app.post('/api/moderation/:id/release', (req, res) => {
    const item = approveRelease(req.params.id);
    if (!item) return res.status(404).json({ error: 'not a held item' });
    res.json({ ok: true, note: 'Approved. The file uploads again on the next Photos sync, and comes back as a deliberate owner override.' });
  });
  app.delete('/api/moderation/:id/release', (req, res) => {
    const item = revokeRelease(req.params.id);
    if (!item) return res.status(404).json({ error: 'not a held item' });
    res.json({ ok: true });
  });
  // Safety check for items that predate screening.
  app.post('/api/moderation/scan', wrap(async (req, res) => {
    if (scanState.running) return res.status(409).json({ error: 'a scan is already running', scan: { ...scanState } });
    const library = currentLibrary();
    const pending = catalog.inLibrary(library).filter((i) => !i.moderation).length;
    if (req.body?.dryRun) return res.json({ items: pending });
    runSafetyScan({ library, limit: num(req.body?.limit, Infinity) }).catch(() => {});
    res.json({ started: true, items: pending });
  }));

  // ---- albums ---------------------------------------------------------------
  app.get('/api/albums', (req, res) => {
    const library = currentLibrary();
    res.json({
      albums: albumList(library).map((a) => ({
        id: a.id, name: a.name, folder: a.folder || [], stats: a.stats,
        summary: a.profile?.summary || null, themes: a.profile?.themes || [], hasProfile: !!a.profile,
      })),
    });
  });
  app.get('/api/albums/profiles', (req, res) => res.json({ job: { ...albumJob } }));
  app.post('/api/albums/profiles', wrap(async (req, res) => {
    if (albumJob.running) return res.status(409).json({ error: 'already building', job: { ...albumJob } });
    buildMissingProfiles(stateStore.get().profile, currentLibrary(), { limit: num(req.body?.limit, Infinity) }).catch(() => {});
    res.json({ started: true });
  }));
  app.get('/api/albums/:id', (req, res) => {
    const album = albumStore.byId(req.params.id);
    if (!album || (album.library || DEFAULT_LIBRARY) !== currentLibrary()) return res.status(404).json({ error: 'not found' });
    const items = catalog.inLibrary().filter((i) => i.albums?.includes(album.id) && visible(i));
    res.json({ album: { ...album, stats: albumStats(album) }, total: items.length });
  });
  app.post('/api/albums/:id/profile', wrap(async (req, res) => {
    const album = albumStore.byId(req.params.id);
    if (!album || (album.library || DEFAULT_LIBRARY) !== currentLibrary()) return res.status(404).json({ error: 'not found' });
    res.json({ profile: await buildAlbumProfile(album, stateStore.get().profile) });
  }));

  // ---- ingest (the Photos sync tool; Basic auth + X-Workspace) -----------------
  app.get('/api/ingest/status', (req, res) => {
    res.json({
      bucket: s3Configured(), library: currentLibrary(), workspaces: listWorkspaces().items.map((w) => ({ id: w.id, name: w.name, library: w.library || DEFAULT_LIBRARY })),
      counts: { items: catalog.inLibrary().length, ...moderationCounts() }, cache: cacheReport(),
    });
  });

  // Plan: which items are new, which kinds still need uploading, and the signed
  // URLs to upload them with. Safe to call repeatedly; ids are derived from
  // the Photos uuid, so a rerun never duplicates anything.
  app.post('/api/ingest/plan', wrap(async (req, res) => {
    if (!s3Configured()) return res.status(412).json({ error: 'object storage is not configured on the server (R2_* env vars)' });
    const library = currentLibrary();
    const out = [];
    for (const it of (req.body?.items || []).slice(0, 500)) {
      const uuid = String(it.uuid || '');
      if (!uuid) continue;
      const id = itemIdFor(library, uuid);
      const cur = catalog.byId(id);
      if (cur && cur.library !== library) { out.push({ uuid, id, action: 'skip', reason: 'belongs to another library' }); continue; }
      if (cur?.moderation?.status === 'held' && cur.moderation.release !== 'approved') {
        out.push({ uuid, id, action: 'held', reason: cur.moderation.reason });
        continue;
      }
      const have = cur?.r2 || {};
      const want = (it.kinds || []).filter((k) => KINDS.includes(k) && (!have[k] || cur?.moderation?.status === 'held'));
      const urls = {};
      const multipart = [];
      for (const kind of want) {
        if (kind === 'original' || kind === 'preview') multipart.push(kind);
        else urls[kind] = presign('PUT', objectKey(id, kind), { expires: 6 * 3600 });
      }
      out.push({ uuid, id, action: want.length ? 'upload' : 'skip', urls, multipart, have: Object.keys(have).filter((k) => have[k]) });
    }
    res.json({ items: out });
  }));

  // Multipart for large files (originals, preview clips): resumable by design.
  app.post('/api/ingest/multipart/start', wrap(async (req, res) => {
    if (!s3Configured()) return res.status(412).json({ error: 'object storage is not configured' });
    const { id, kind, size, contentType } = req.body || {};
    if (!KINDS.includes(kind) || !id || !(size > 0)) return res.status(400).json({ error: 'id, kind and size are required' });
    const key = objectKey(id, kind);
    const partSize = Math.max(64 * 1024 * 1024, Math.ceil(size / 9000 / (1024 * 1024)) * 1024 * 1024);
    const uploadId = await createMultipart(key, contentType || 'application/octet-stream');
    const count = Math.ceil(size / partSize);
    res.json({ uploadId, partSize, parts: Array.from({ length: count }, (_, i) => ({ n: i + 1, url: presignPart(key, uploadId, i + 1) })) });
  }));
  app.get('/api/ingest/multipart/:id/:kind', wrap(async (req, res) => {
    const parts = await listParts(objectKey(req.params.id, req.params.kind), String(req.query.uploadId || ''));
    if (parts === null) return res.status(404).json({ error: 'upload not found (expired or completed)' });
    res.json({ parts });
  }));
  app.post('/api/ingest/multipart/resign', wrap(async (req, res) => {
    const { id, kind, uploadId, parts } = req.body || {};
    const key = objectKey(id, kind);
    res.json({ parts: (parts || []).slice(0, 10000).map((n) => ({ n, url: presignPart(key, uploadId, n) })) });
  }));
  app.post('/api/ingest/multipart/complete', wrap(async (req, res) => {
    const { id, kind, uploadId, parts } = req.body || {};
    const key = objectKey(id, kind);
    await completeMultipart(key, uploadId, parts || []);
    const head = await headObject(key);
    res.json({ ok: !!head, bytes: head?.size || 0 });
  }));

  // Commit: creates or updates items after their objects exist, records the
  // Photos metadata and album membership, and files anything held on the Mac as
  // a tombstone so the owner can see (by filename only) what stayed local.
  app.post('/api/ingest/commit', wrap(async (req, res) => {
    const library = currentLibrary();
    const accepted = []; const rejected = [];
    const albumRecords = (req.body?.albums || []).filter((a) => a?.uuid && a?.title).map((a) => ({
      id: albumIdFor(library, a.uuid), name: String(a.title).slice(0, 200), uuid: a.uuid,
      folder: (a.folder || []).map(String).slice(0, 6), library, kind: a.kind || 'album',
    }));
    if (albumRecords.length) albumStore.upsertMany(albumRecords);
    const albumIds = new Set(albumRecords.map((a) => a.id));
    const known = new Set(albumStore.inLibrary(library).map((a) => a.id));

    const records = [];
    for (const it of (req.body?.items || []).slice(0, 500)) {
      const uuid = String(it.uuid || '');
      if (!uuid) continue;
      const id = itemIdFor(library, uuid);
      const cur = catalog.byId(id);
      if (cur?.moderation?.status === 'held' && cur.moderation.release !== 'approved') { rejected.push({ uuid, reason: 'held' }); continue; }
      const released = cur?.moderation?.release === 'approved';
      // Every claimed kind must really be in the bucket; a claim is never trusted.
      const r2 = { ...(cur?.r2 || {}) };
      let missing = null;
      await Promise.all(Object.entries(it.kinds || {}).filter(([k, v]) => v && KINDS.includes(k)).map(async ([k]) => {
        const head = await headObject(objectKey(id, k)).catch(() => null);
        if (head) r2[k] = true; else missing = k;
      }));
      if (!r2.thumb && !r2.analysis) { rejected.push({ uuid, reason: `no thumb or analysis frame found${missing ? ` (${missing} missing)` : ''}` }); continue; }
      const albums = (it.albums || []).map((u) => albumIdFor(library, u)).filter((a) => albumIds.has(a) || known.has(a));
      records.push({
        id, photosUuid: uuid, library, name: String(it.name || uuid).slice(0, 200), mime: it.mime || null,
        kind: it.kind === 'video' ? 'video' : 'image', size: num(it.size, 0), w: num(it.w, null), h: num(it.h, null),
        takenAt: it.takenAt || null, gps: it.gps && Number.isFinite(it.gps.lat) ? { lat: it.gps.lat, lon: it.gps.lon } : null,
        place: it.place ? String(it.place).slice(0, 160) : null,
        albums: [...new Set([...(cur?.albums || []), ...albums])],
        apple: it.apple ? {
          title: it.apple.title || null, description: it.apple.description || null, place: it.apple.place || null,
          keywords: (it.apple.keywords || []).slice(0, 30), labels: (it.apple.labels || []).slice(0, 30),
          favorite: !!it.apple.favorite, score: it.apple.score ?? null,
        } : (cur?.apple || null),
        videoMeta: it.videoMeta || cur?.videoMeta || null,
        dupOf: it.dupOf || null,
        r2, hasOriginal: !!r2.original,
        alt: cur?.alt || null, caption: cur?.caption || null, keywords: cur?.keywords || [], quality: cur?.quality ?? null,
        storyIdeas: cur?.storyIdeas || [], analyzed: released ? false : !!cur?.analyzed,
        addedAt: cur?.addedAt || new Date().toISOString(),
        moderation: released
          ? { status: 'pending', override: true, local: 'owner-release', at: new Date().toISOString() }
          : (cur?.moderation || pendingModeration(it.localScreen === 'clear' ? 'clear' : null)),
      });
      accepted.push({ uuid, id });
    }
    catalog.upsertMany(records);

    // Files the Mac kept back: tombstones only, no bytes ever reached the server.
    let heldLocal = 0;
    const tombs = [];
    for (const h of (req.body?.heldLocal || []).slice(0, 2000)) {
      if (!h?.uuid) continue;
      const id = itemIdFor(library, h.uuid);
      const cur = catalog.byId(id);
      if (cur) continue;
      tombs.push({
        id, photosUuid: h.uuid, library, name: String(h.name || h.uuid).slice(0, 200), kind: h.kind === 'video' ? 'video' : 'image',
        takenAt: h.takenAt || null, albums: [], r2: {}, hasOriginal: false, analyzed: false,
        addedAt: new Date().toISOString(),
        moderation: { status: 'held', reason: String(h.reason || 'held on your Mac').slice(0, 200), source: 'mac-local', at: new Date().toISOString() },
      });
      heldLocal += 1;
    }
    catalog.upsertMany(tombs);
    res.json({ accepted: accepted.length, rejected, heldLocal, counts: moderationCounts() });
  }));

  // Items the owner approved for release: the sync tool asks which ones to
  // upload again regardless of its local screen.
  app.get('/api/ingest/releases', (req, res) => {
    res.json({ uuids: heldList().filter((h) => h.releaseApproved && h.photosUuid).map((h) => h.photosUuid) });
  });

}
