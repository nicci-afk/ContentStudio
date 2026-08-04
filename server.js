import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dependency).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { stateStore, mediaStore, packageStore, uid, saveMediaFile, readMediaFile, deleteMediaFiles, mediaPath,
  listWorkspaces, createWorkspace, activateWorkspace, renameWorkspace, deleteWorkspace,
  listSnapshots, restoreSnapshot } =
  await import('./lib/store.js');
const { platformList, PLATFORMS } = await import('./lib/platforms.js');
const { buildLlmsTxt, scorePackage, buildJsonLd } = await import('./lib/visibility.js');
const { providerStatus, elevenVoices, elevenClone, elevenTts, heygenAvatars, heygenVoices, heygenGenerate, heygenStatus, heygenQuota, ProviderError } =
  await import('./lib/providers.js');
const { generatePackage, synthesizeBrief, synthesizeVoiceDna, suggestPillars, analyzeMedia, selectMedia, matchCarouselSlides, regenerateCitations, writeReshareComment } =
  await import('./lib/engine.js');
const { startRender, renderJob, renderFile, listRenders, activeRenderIds, renderPoster, previewFile, enqueuePreview, ffmpegPath, startClipsJob, clipsJob } = await import('./lib/render.js');
const { storageReport, cleanupStorage, deleteRender } = await import('./lib/storage.js');
const { backupStatus, runBackup, scheduleBackups } = await import('./lib/backup.js');
const { DEMO_STATE } = await import('./lib/demo.js');

const { registerAuthRoutes, authMiddleware } = await import('./lib/auth.js');

const app = express();

// Auth: magic-link email sign-in (MAGIC_EMAILS allowlist) and/or the studio
// password — both produce a 30-day session cookie. Basic auth still works
// for API tools. /api/health and /llms.txt stay public by design.
app.use(express.json({ limit: '80mb' }));
registerAuthRoutes(app, path.join(__dirname, 'public'));
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err instanceof ProviderError ? (err.status === 401 ? 424 : 502) : 500;
    res.status(status).json({ error: err.message, provider: err.provider || null });
  });
};

// ---- system --------------------------------------------------------------

// Every changed surface sits behind auth, so health carries the running
// commit to make deploys externally verifiable. Render injects
// RENDER_GIT_COMMIT into the runtime; a local checkout asks git instead.
const BUILD = (() => {
  const sha = process.env.RENDER_GIT_COMMIT
    || (() => { try { return execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } })();
  return sha.trim().slice(0, 7) || 'unknown';
})();
const BOOTED_AT = new Date().toISOString();

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0', build: BUILD, bootedAt: BOOTED_AT, providers: providerStatus() });
});

app.get('/api/platforms', (req, res) => res.json({ platforms: platformList() }));

app.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(buildLlmsTxt(stateStore.get().profile, packageStore.get().items));
});

// ---- workspaces (one per business; all data below is workspace-scoped) ---

app.get('/api/workspaces', (req, res) => res.json(listWorkspaces()));

app.post('/api/workspaces', (req, res) => {
  createWorkspace(req.body?.name);
  res.json(listWorkspaces());
});

app.post('/api/workspaces/:id/activate', (req, res) => {
  if (!activateWorkspace(req.params.id)) return res.status(404).json({ error: 'unknown workspace' });
  res.json(listWorkspaces());
});

app.patch('/api/workspaces/:id', (req, res) => {
  if (!renameWorkspace(req.params.id, req.body?.name)) return res.status(400).json({ error: 'name required' });
  res.json(listWorkspaces());
});

app.delete('/api/workspaces/:id', (req, res) => {
  if (!deleteWorkspace(req.params.id)) {
    return res.status(400).json({ error: 'cannot delete the last workspace (or unknown id)' });
  }
  res.json(listWorkspaces());
});

// ---- state ---------------------------------------------------------------

app.get('/api/state', (req, res) => res.json(stateStore.get()));

app.put('/api/state', (req, res) => {
  stateStore.set(req.body);
  res.json({ ok: true });
});

app.patch('/api/state', (req, res) => {
  const { path: keyPath, value } = req.body;
  const state = stateStore.get();
  const keys = String(keyPath).split('.');
  let node = state;
  for (const k of keys.slice(0, -1)) node = node[k] = node[k] || {};
  node[keys.at(-1)] = value;
  stateStore.set(state);
  res.json({ ok: true });
});

app.get('/api/state/snapshots', (req, res) => res.json({ items: listSnapshots() }));

app.post('/api/state/restore', (req, res) => {
  const restored = restoreSnapshot(req.body?.name);
  if (!restored) return res.status(404).json({ error: 'unknown snapshot' });
  res.json({ ok: true, state: restored });
});

app.post('/api/demo', (req, res) => {
  stateStore.set(structuredClone(DEMO_STATE));
  res.json({ ok: true });
});

// ---- interview + voice DNA ----------------------------------------------

app.post('/api/interview/brief', wrap(async (req, res) => {
  const state = stateStore.get();
  const answers = req.body.answers || {};
  state.profile.interview = { answers, completedAt: new Date().toISOString(), brief: null };
  const brief = await synthesizeBrief(answers, state.profile);
  state.profile.interview.brief = brief;
  stateStore.set(state);
  res.json({ brief });
}));

// Additive: new files stack onto the existing corpus (same filename replaces
// that file), and the fingerprint re-synthesizes from everything combined.
app.post('/api/voice-dna', wrap(async (req, res) => {
  const state = stateStore.get();
  const prior = state.profile.voiceDna || {};
  const incoming = (req.body.files || []).map((f) => ({
    name: f.name, text: String(f.text || '').slice(0, 100000),
  }));
  const kept = (prior.corpus || []).filter((e) => !incoming.some((i) => i.name === e.name));
  const corpus = [...kept, ...incoming.map((f) => ({ name: f.name, text: f.text.slice(0, 20000) }))].slice(-24);
  const summary = await synthesizeVoiceDna(corpus);
  const priorMeta = Object.fromEntries((prior.sources || []).map((s) => [s.name, s]));
  state.profile.voiceDna = {
    sources: corpus.map((f) => ({
      name: f.name, chars: f.text.length,
      addedAt: incoming.some((i) => i.name === f.name)
        ? new Date().toISOString()
        : (priorMeta[f.name]?.addedAt || new Date().toISOString()),
    })),
    corpus,
    summary,
  };
  stateStore.set(state);
  res.json({ voiceDna: state.profile.voiceDna });
}));

app.post('/api/voice-dna/remove', wrap(async (req, res) => {
  const state = stateStore.get();
  const prior = state.profile.voiceDna || {};
  const corpus = (prior.corpus || []).filter((e) => e.name !== req.body?.name);
  const summary = corpus.length ? await synthesizeVoiceDna(corpus) : null;
  state.profile.voiceDna = {
    sources: (prior.sources || []).filter((s) => s.name !== req.body?.name),
    corpus,
    summary,
  };
  stateStore.set(state);
  res.json({ voiceDna: state.profile.voiceDna });
}));

// ---- media ---------------------------------------------------------------

app.get('/api/media', (req, res) => res.json({ items: mediaStore.get().items }));

app.post('/api/media', wrap(async (req, res) => {
  const { name, mime, kind, size, w, h, takenAt, gps, thumbB64, analysisB64, renderB64 } = req.body;
  const id = uid();
  if (thumbB64) saveMediaFile(id, 'thumb', Buffer.from(thumbB64, 'base64'));
  if (analysisB64) saveMediaFile(id, 'analysis', Buffer.from(analysisB64, 'base64'));
  if (renderB64) saveMediaFile(id, 'render', Buffer.from(renderB64, 'base64'));
  const record = {
    id, name, mime, kind: kind || (String(mime).startsWith('video') ? 'video' : 'image'),
    size: size || 0, w: w || null, h: h || null,
    takenAt: takenAt || null, gps: gps || null,
    alt: null, caption: null, keywords: [], place: null, quality: null, storyIdeas: [],
    analyzed: false, hasOriginal: false, addedAt: new Date().toISOString(),
  };
  mediaStore.update((m) => ({ items: [record, ...m.items] }));
  res.json({ item: record });
}));

app.get('/api/media/:id/thumb', (req, res) => {
  const buf = readMediaFile(req.params.id, 'thumb');
  if (!buf) return res.status(404).end();
  res.type('image/jpeg').send(buf);
});

// Full-size download: the strongest stored copy of an item (the real
// video file when the original was uploaded, the full-resolution frame
// otherwise). The filename comes from the alt text so it carries
// keywords wherever the file lands next.
app.get('/api/media/:id/file', (req, res) => {
  const item = mediaStore.get().items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).end();
  const slug = String(item.alt || item.caption || item.name || 'media')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'media';
  if (item.kind === 'video') {
    const original = mediaPath(item.id, 'original');
    if (fs.existsSync(original)) {
      const nameExt = String(item.name || '').split('.').pop().toLowerCase();
      const ext = /^[a-z0-9]{2,4}$/.test(nameExt) ? nameExt : 'mp4';
      res.set('Content-Disposition', `attachment; filename="${slug}.${ext}"`);
      return res.type(item.mime || 'video/mp4').sendFile(original);
    }
  }
  const buf = readMediaFile(item.id, 'render') || readMediaFile(item.id, 'analysis') || readMediaFile(item.id, 'thumb');
  if (!buf) return res.status(404).end();
  res.set('Content-Disposition', `attachment; filename="${slug}.jpg"`);
  res.type('image/jpeg').send(buf);
});

// Muted video download: same original footage, audio track removed on the fly.
// Only available for video items that have an original stored on disk.
app.get('/api/media/:id/file/muted', (req, res) => {
  const item = mediaStore.get().items.find((i) => i.id === req.params.id);
  if (!item || item.kind !== 'video') return res.status(404).end();
  const original = mediaPath(item.id, 'original');
  if (!fs.existsSync(original)) return res.status(404).end();
  const slug = String(item.alt || item.caption || item.name || 'media')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'media';
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-muted.mp4"`);
  const proc = spawn(ffmpegPath(), [
    '-i', original,
    '-c:v', 'copy', '-an',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);
  res.on('close', () => proc.kill());
  proc.on('error', () => { try { res.end(); } catch { /* ignore */ } });
});

// Original video upload: the browser streams the untouched file here after
// import so Auto-Produce can cut real moving clips into b-roll. Streamed
// straight to disk (never buffered in memory) with a hard size cap.
const MAX_ORIGINAL_BYTES = 500 * 1024 * 1024;
app.post('/api/media/:id/original', (req, res) => {
  const item = mediaStore.get().items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.kind !== 'video') return res.status(400).json({ error: 'originals are only stored for videos' });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_ORIGINAL_BYTES) {
    return res.status(413).json({ error: 'video is larger than the 500MB per-file limit' });
  }
  const file = mediaPath(item.id, 'original');
  const partial = `${file}.part`;
  const out = fs.createWriteStream(partial);
  let received = 0;
  let failed = false;
  const abort = (code, message) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(partial, { force: true }, () => {});
    req.destroy();
    if (!res.headersSent) res.status(code).json({ error: message });
  };
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_ORIGINAL_BYTES) abort(413, 'video is larger than the 500MB per-file limit');
  });
  req.on('error', () => abort(400, 'upload interrupted'));
  out.on('error', () => abort(500, 'could not write the video to disk'));
  out.on('finish', () => {
    if (failed) return;
    fs.rename(partial, file, (err) => {
      if (err) return abort(500, 'could not store the video');
      mediaStore.update((m) => ({
        items: m.items.map((i) => (i.id === item.id ? { ...i, hasOriginal: true } : i)),
      }));
      res.json({ ok: true, bytes: received });
    });
  });
  req.pipe(out);
});

app.post('/api/media/:id/analyze', wrap(async (req, res) => {
  const item = mediaStore.get().items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const buf = readMediaFile(item.id, 'analysis') || readMediaFile(item.id, 'thumb');
  if (!buf) return res.status(400).json({ error: 'no analyzable frame stored for this item' });
  const result = await analyzeMedia({
    b64: buf.toString('base64'), name: item.name, kind: item.kind,
    takenAt: item.takenAt, profile: stateStore.get().profile,
  });
  Object.assign(item, {
    alt: result.alt || item.alt,
    caption: result.caption || item.caption,
    keywords: result.keywords || [],
    place: result.place || null,
    quality: result.quality || null,
    storyIdeas: result.storyIdeas || [],
    analyzed: true,
  });
  mediaStore.update((m) => ({ items: m.items.map((i) => (i.id === item.id ? item : i)) }));
  res.json({ item });
}));

app.patch('/api/media/:id', (req, res) => {
  let updated = null;
  mediaStore.update((m) => ({
    items: m.items.map((i) => (i.id === req.params.id ? (updated = { ...i, ...req.body, id: i.id }) : i)),
  }));
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json({ item: updated });
});

app.delete('/api/media/:id', (req, res) => {
  deleteMediaFiles(req.params.id);
  mediaStore.update((m) => ({ items: m.items.filter((i) => i.id !== req.params.id) }));
  res.json({ ok: true });
});

// ---- strategy ------------------------------------------------------------

app.post('/api/pillars/suggest', wrap(async (req, res) => {
  const result = await suggestPillars(stateStore.get().profile);
  res.json(result);
}));

// ---- generation (job-based so the UI can show live progress) -------------

const jobs = new Map();

app.post('/api/generate', wrap(async (req, res) => {
  const { topic, angle, pillarId, seriesId, platforms, mediaIds, ctaUrl, autoMedia } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  const state = stateStore.get();
  const profile = state.profile;
  const pillar = (profile.pillars || []).find((p) => p.id === pillarId) || null;
  const series = (profile.series || []).find((s) => s.id === seriesId) || null;

  const jobId = uid();
  const job = { id: jobId, status: 'running', progress: { done: 0, total: (platforms?.length || 14) + 1 }, package: null, error: null };
  jobs.set(jobId, job);

  (async () => {
    let media = mediaStore.get().items.filter((m) => (mediaIds || []).includes(m.id));
    let mediaSelection = null;
    if (!media.length && autoMedia) {
      job.progress = { platform: 'selecting media from your library', done: 0, total: job.progress.total };
      const sel = await selectMedia({ profile, topic, angle, pillar, items: mediaStore.get().items });
      media = mediaStore.get().items.filter((m) => sel.ids.includes(m.id));
      mediaSelection = sel;
    }
    const pkg = await generatePackage({
      profile, topic, angle, pillar, series, media, ctaUrl,
      platformIds: platforms,
      onProgress: (p) => { job.progress = p; },
    });
    if (mediaSelection) {
      pkg.mediaSelection = mediaSelection.reasons;
      pkg.mediaSelectionMode = mediaSelection.mode;
    }
    packageStore.update((s) => ({ items: [pkg, ...s.items] }));
    job.package = pkg;
    job.status = 'done';
  })().catch((err) => {
    job.status = 'error';
    job.error = err.message;
  });

  res.json({ jobId });
}));

app.get('/api/generate/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(job);
});

app.get('/api/packages', (req, res) => {
  res.json({
    items: packageStore.get().items.map((p) => ({
      id: p.id, topic: p.topic, createdAt: p.createdAt, mode: p.mode,
      pillarId: p.pillarId, seriesId: p.seriesId,
      platforms: Object.keys(p.platforms || {}),
      score: p.visibility?.score ?? null, grade: p.visibility?.grade ?? null,
    })),
  });
});

app.get('/api/packages/:id', (req, res) => {
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'not found' });
  res.json({ package: pkg });
});

// Hand-polished chapter titles flow back into the render record (and from
// there into the VideoObject hasPart Clip names) whenever the chapters
// field is edited: lines are matched to the recorded chapter starts.
function syncChapterTitles(pkg, platformId, value) {
  const rec = pkg.renders?.[platformId];
  if (!rec?.chapters?.length) return;
  const lines = String(value || '').split('\n').map((l) => {
    const m = l.match(/^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/);
    return m ? { start: (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]), title: m[4] } : null;
  }).filter(Boolean);
  for (const c of rec.chapters) {
    const hit = lines.find((l) => Math.abs(l.start - c.start) <= 2);
    if (hit) c.title = hit.title;
  }
}

app.patch('/api/packages/:id', (req, res) => {
  const { platformId, field, value } = req.body || {};
  const profile = stateStore.get().profile;
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      if (!p.platforms?.[platformId]?.fields || typeof field !== 'string') return p;
      p.platforms[platformId].fields[field] = value;
      if (field === 'chapters') syncChapterTitles(p, platformId, value);
      p.jsonld = buildJsonLd(p, profile);
      p.visibility = scorePackage(p, profile);
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'unknown package/platform/field' });
  res.json({ package: pkg });
});

// Per-platform approval: an asset is Draft until the creator approves it,
// and the Publish Run page only ever exposes approved assets. This is the
// human gate in front of any assisted posting flow.
app.post('/api/packages/:id/approve', (req, res) => {
  const { platformId, approved } = req.body || {};
  if (!platformId) return res.status(400).json({ error: 'platformId required' });
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      if (!p.platforms?.[platformId]) return p;
      p.approvals = { ...(p.approvals || {}) };
      if (approved) p.approvals[platformId] = { approved: true, at: new Date().toISOString() };
      else delete p.approvals[platformId];
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'unknown package/platform' });
  res.json({ package: pkg });
});

// Published-URL registry: where each asset actually went live. Feeds
// llms.txt canonical URLs, JSON-LD url/sameAs/SeekToAction, and the
// cross_surface check (which counts live URLs, not drafts).
app.post('/api/packages/:id/published', (req, res) => {
  const { platformId, url } = req.body || {};
  if (!platformId) return res.status(400).json({ error: 'platformId required' });
  const u = String(url || '').trim();
  if (u && !/^https?:\/\/\S+$/i.test(u)) return res.status(400).json({ error: 'the URL must start with http(s)://' });
  const profile = stateStore.get().profile;
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      p.publishedUrls = { ...(p.publishedUrls || {}) };
      if (u) p.publishedUrls[platformId] = u;
      else delete p.publishedUrls[platformId];
      p.jsonld = buildJsonLd(p, profile);
      p.visibility = scorePackage(p, profile);
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  res.json({ package: pkg });
});

// Amplification step: a brand that publishes from a person and reshares
// from its company page needs the second post to carry its own framing,
// and needs the reshare URL recorded. Reshares are stored apart from
// publishedUrls on purpose: the same content on a second surface is
// distribution, not the independent corroboration cross_surface measures.
app.post('/api/packages/:id/reshare', wrap(async (req, res) => {
  const { platformId, url, text: manual, generate } = req.body || {};
  if (!platformId) return res.status(400).json({ error: 'platformId required' });
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const profile = stateStore.get().profile;

  let written = null;
  if (generate) written = await writeReshareComment({ profile, pkg, platformId });
  const u = url == null ? null : String(url).trim();
  if (u && !/^https?:\/\/\S+$/i.test(u)) return res.status(400).json({ error: 'the URL must start with http(s)://' });

  let updated = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== pkg.id) return p;
      p.reshares = { ...(p.reshares || {}) };
      const cur = { ...(p.reshares[platformId] || {}) };
      if (written) { cur.text = written.text; cur.mode = written.mode; }
      if (typeof manual === 'string') cur.text = manual.trim();
      if (u !== null) {
        if (u) { cur.url = u; cur.at = new Date().toISOString(); } else { delete cur.url; delete cur.at; }
      }
      p.reshares[platformId] = cur;
      return (updated = p);
    }),
  }));
  res.json({ package: updated });
}));

// Citation-layer regenerate: rebuilds queryMap/FAQ/citeLines/keywords from
// the package's finished copy. Platform fields are never touched; FAQ
// answers that are already real (no [FILL]) are kept.
app.post('/api/packages/:id/citations', wrap(async (req, res) => {
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const profile = stateStore.get().profile;
  const meta = await regenerateCitations({ profile, pkg });
  let updated = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== pkg.id) return p;
      const kept = (p.faq || []).filter((f) => f?.a && !/\[FILL/i.test(f.a));
      const keptQs = new Set(kept.map((f) => String(f.q).toLowerCase().replace(/\W+/g, ' ').trim()));
      const fresh = (meta.faq || []).filter((f) => f?.q && f?.a
        && !keptQs.has(String(f.q).toLowerCase().replace(/\W+/g, ' ').trim()));
      p.faq = [...kept, ...fresh].slice(0, 6);
      if (meta.queryMap?.length) p.queryMap = meta.queryMap;
      if (meta.citeLines?.length) p.citeLines = meta.citeLines;
      if (meta.keywords?.length) p.keywords = meta.keywords;
      if (meta.entities?.length) p.entities = meta.entities;
      p.definition = p.definition || meta.definition || null;
      p.quotable = p.quotable || meta.quotable || null;
      p.citationsAt = new Date().toISOString();
      delete p.answerLayerError;
      p.jsonld = buildJsonLd(p, profile);
      p.visibility = scorePackage(p, profile);
      return (updated = p);
    }),
  }));
  res.json({ package: updated });
}));

// Hand-edit the AI-answer layer. Generation gets it close; the creator's
// judgment is final, and until now the answer layer was the one surface
// with no in-place editing (the PATCH route only reaches platform fields).
app.patch('/api/packages/:id/citations', (req, res) => {
  const { faq, queryMap, citeLines, definition, quotable } = req.body || {};
  const profile = stateStore.get().profile;
  const cleanList = (v, cap) => (Array.isArray(v)
    ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, cap)
    : String(v || '').split('\n').map((s) => s.replace(/^[-•*]\s*/, '').trim()).filter(Boolean).slice(0, cap));
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      if (Array.isArray(faq)) {
        p.faq = faq
          .map((f) => ({ q: String(f?.q || '').trim(), a: String(f?.a || '').trim() }))
          .filter((f) => f.q && f.a)
          .slice(0, 8);
      }
      if (queryMap != null) p.queryMap = cleanList(queryMap, 20);
      if (citeLines != null) p.citeLines = cleanList(citeLines, 6);
      if (definition != null) p.definition = String(definition).trim() || null;
      if (quotable != null) p.quotable = String(quotable).trim() || null;
      p.jsonld = buildJsonLd(p, profile);
      p.visibility = scorePackage(p, profile);
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  res.json({ package: pkg });
});

// Per-package event facts (the retreat IS an event): dates, place, price.
// Emits Event JSON-LD and the business block's makesOffer.
app.post('/api/packages/:id/event', (req, res) => {
  const allowed = ['name', 'startDate', 'endDate', 'locationName', 'address',
    'price', 'lowPrice', 'highPrice', 'offerCount', 'currency', 'url', 'description'];
  const event = {};
  for (const k of allowed) {
    const v = req.body?.[k];
    if (v != null && String(v).trim()) event[k] = String(v).trim().slice(0, 600);
  }
  const profile = stateStore.get().profile;
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      p.event = Object.keys(event).length ? event : undefined;
      p.jsonld = buildJsonLd(p, profile);
      p.visibility = scorePackage(p, profile);
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  res.json({ package: pkg });
});

app.post('/api/packages/:id/rescore', (req, res) => {
  const state = stateStore.get();
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      p.jsonld = buildJsonLd(p, state.profile);
      p.visibility = scorePackage(p, state.profile);
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'not found' });
  res.json({ package: pkg });
});

app.delete('/api/packages/:id', (req, res) => {
  packageStore.update((s) => ({ items: s.items.filter((p) => p.id !== req.params.id) }));
  res.json({ ok: true });
});

// ---- auto-produce (finished video rendering) -----------------------------

app.post('/api/render', wrap(async (req, res) => {
  const { packageId, platformId, voiceId, orientation, avatar, delivery } = req.body;
  const pkg = packageStore.get().items.find((p) => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const fields = pkg.platforms?.[platformId]?.fields;
  if (!fields) return res.status(400).json({ error: 'that platform is not in this package' });
  const script = fields.script || fields.body || fields.post || '';
  const hookText = fields.hook || fields.hook_script || '';
  const renderId = startRender({
    pkg, profile: stateStore.get().profile, platformId, script, hookText, voiceId: voiceId || null,
    orientation: orientation || (platformId === 'youtube_long' ? 'landscape' : 'portrait'),
    avatar: avatar || null,
    delivery: delivery || null,
  });
  res.json({ renderId });
}));

app.get('/api/render/:id', (req, res) => {
  const job = renderJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown render' });
  res.json(job);
});

// Render files are id-addressed and never change once written, so the
// browser may cache them for good instead of re-downloading every visit.
const RENDER_CACHE = { maxAge: '365d', immutable: true };

app.get('/api/render/:id/video', (req, res) => {
  const full = renderFile(req.params.id, 'mp4');
  if (!full) return res.status(404).end();
  let file = full;
  if (req.query.q === 'preview') {
    const preview = previewFile(req.params.id);
    if (preview) file = preview;
    else enqueuePreview(req.params.id); // stream full quality this visit, fast next visit
  }
  res.sendFile(file, RENDER_CACHE);
});

// Strip audio on the fly via ffmpeg — video codec copied losslessly, no re-encode.
// Uses fragmented MP4 so the moov atom is at the front and the browser can start
// receiving bytes immediately (no seek needed).
app.get('/api/render/:id/video/muted', (req, res) => {
  const full = renderFile(req.params.id, 'mp4');
  if (!full) return res.status(404).end();
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="video-muted.mp4"');
  const proc = spawn(ffmpegPath(), [
    '-i', full,
    '-c:v', 'copy', '-an',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);
  res.on('close', () => proc.kill());
  proc.on('error', () => { try { res.end(); } catch { /* ignore */ } });
});

app.get('/api/render/:id/poster', wrap(async (req, res) => {
  const file = await renderPoster(req.params.id);
  if (!file) return res.status(404).end();
  res.sendFile(file, RENDER_CACHE);
}));

app.get('/api/render/:id/srt', (req, res) => {
  const file = renderFile(req.params.id, 'srt');
  if (!file) return res.status(404).end();
  res.type('text/plain').sendFile(file, RENDER_CACHE);
});

app.get('/api/packages/:id/renders', (req, res) => {
  res.json({ items: listRenders(req.params.id) });
});

// Chapter-to-clips: cut every chapter of a finished render into a vertical
// 9:16 clip with its caption window re-burned. Local ffmpeg only — no
// provider spend.
app.post('/api/render/:id/clips', wrap(async (req, res) => {
  res.json({ jobId: startClipsJob(req.params.id) });
}));

app.get('/api/render/clips/:jobId', (req, res) => {
  const job = clipsJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown clips job' });
  res.json(job);
});

app.get('/api/render/:id/clip/:n', (req, res) => {
  const n = Number(req.params.n);
  const file = Number.isInteger(n) && n > 0 ? renderFile(req.params.id, `clip-${n}.mp4`) : null;
  if (!file) return res.status(404).end();
  res.set('Content-Disposition', `attachment; filename="chapter-${n}-clip.mp4"`);
  res.sendFile(file, RENDER_CACHE);
});

// Attach library media to a package that already exists. Media was only
// ever selected at generation time, so importing photos afterwards left
// finished packages with nothing visual and no way to fix it short of
// regenerating (which would throw away every hand edit). Alt text comes
// from each item's stored analysis, so this costs one selection call at
// most and nothing at all when the picks are explicit.
app.post('/api/packages/:id/media', wrap(async (req, res) => {
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const state = stateStore.get();
  const items = mediaStore.get().items || [];
  if (!items.length) return res.status(400).json({ error: 'the media library is empty; import photos first' });

  let ids = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds.filter((id) => items.some((m) => m.id === id)) : [];
  let reasons = {};
  let mode = 'manual';
  if (!ids.length) {
    const pillar = (state.profile.pillars || []).find((p) => p.id === pkg.pillarId) || null;
    const sel = await selectMedia({
      profile: state.profile, topic: pkg.topic, angle: pkg.angle, pillar, items,
      count: Math.min(12, Math.max(1, Number(req.body?.count) || 8)),
    });
    ids = sel.ids;
    reasons = sel.reasons;
    mode = sel.mode;
  }
  if (!ids.length) return res.status(400).json({ error: 'no usable media could be selected' });

  const clamp = (s) => String(s || '').replace(/[–—]/g, ',').slice(0, 125);
  let updated = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== pkg.id) return p;
      p.mediaIds = ids;
      p.mediaSelection = reasons;
      p.mediaSelectionMode = mode;
      p.altTexts = { ...(p.altTexts || {}) };
      for (const id of ids) {
        const m = items.find((x) => x.id === id);
        const alt = clamp(m?.alt || m?.caption || m?.name);
        if (alt) p.altTexts[id] = alt;
      }
      p.jsonld = buildJsonLd(p, state.profile);
      p.visibility = scorePackage(p, state.profile);
      return (updated = p);
    }),
  }));
  res.json({ package: updated });
}));

// AI-match library assets to the carousel's numbered slides, store the
// ordered plan on the package, and (unless applyAlt is false) write the
// per-slide alt text into the carousel's alt_text field.
app.post('/api/packages/:id/carousel-media', wrap(async (req, res) => {
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const profile = stateStore.get().profile;
  const { slides, mode, error } = await matchCarouselSlides({ profile, pkg, items: mediaStore.get().items });
  let updated = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== pkg.id) return p;
      p.carouselPlan = { createdAt: new Date().toISOString(), mode, slides, error: error || undefined };
      const fields = p.platforms?.instagram_carousel?.fields;
      if (fields && req.body?.applyAlt !== false) {
        fields.alt_text = slides.map((sl) => `Slide ${sl.n}: ${sl.alt}`).join('\n');
      }
      p.jsonld = buildJsonLd(p, profile);
      p.visibility = scorePackage(p, profile);
      updated = p;
      return p;
    }),
  }));
  res.json({ package: updated });
}));

// ---- storage (shared data disk: report, cleanup, render deletion) --------

app.get('/api/storage', (req, res) => res.json(storageReport(activeRenderIds())));

app.post('/api/storage/cleanup', (req, res) => res.json(cleanupStorage(activeRenderIds())));

// Off-site backups (Cloudflare R2 / any S3-compatible bucket): status and a
// manual run. The schedule runs daily on its own once the R2_* env vars
// exist.
app.get('/api/backup', (req, res) => res.json(backupStatus()));

app.post('/api/backup', wrap(async (req, res) => res.json(await runBackup())));

app.post('/api/storage/renders/delete', (req, res) => {
  const result = deleteRender(req.body?.workspaceId, req.body?.renderId, activeRenderIds());
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ---- voice (ElevenLabs) --------------------------------------------------

app.get('/api/voice/voices', wrap(async (req, res) => res.json({ voices: await elevenVoices() })));

app.post('/api/voice/clone', wrap(async (req, res) => {
  const { name, description, samples } = req.body;
  if (!name || !samples?.length) return res.status(400).json({ error: 'name and samples required' });
  res.json(await elevenClone({ name, description, samples }));
}));

app.post('/api/voice/tts', wrap(async (req, res) => {
  const { voiceId, text, stability, similarity } = req.body;
  if (!voiceId || !text) return res.status(400).json({ error: 'voiceId and text required' });
  const audio = await elevenTts({ voiceId, text: String(text).slice(0, 9500), stability, similarity });
  res.type('audio/mpeg').send(audio);
}));

// ---- avatar (HeyGen) -----------------------------------------------------

app.get('/api/avatar/avatars', wrap(async (req, res) => res.json({ avatars: await heygenAvatars() })));
app.get('/api/avatar/voices', wrap(async (req, res) => res.json({ voices: await heygenVoices() })));
app.get('/api/avatar/quota', wrap(async (req, res) => res.json(await heygenQuota())));

app.post('/api/avatar/generate', wrap(async (req, res) => {
  const { avatarId, avatarKind, voiceId, text, title, orientation } = req.body;
  if (!avatarId || !voiceId || !text) return res.status(400).json({ error: 'avatarId, voiceId, text required' });
  res.json(await heygenGenerate({ avatarId, avatarKind, voiceId, text, title, orientation }));
}));

app.get('/api/avatar/status/:id', wrap(async (req, res) => res.json(await heygenStatus(req.params.id))));

// ---- boot ----------------------------------------------------------------

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Renders that died mid-flight (crash or deploy restart) leave their temp
// folders behind forever; sweep them at boot, when no job can be running.
const swept = cleanupStorage(new Set());
if (swept.freedBytes > 0) {
  console.log(`  storage: swept ${Math.round(swept.freedBytes / 1e6)}MB of stale render temp files (${swept.removedTmp} folder(s), ${swept.removedParts} partial upload(s), ${swept.removedCacheFiles || 0} aged cache file(s))`);
}
scheduleBackups();

const port = Number(process.env.PORT || 4600);
app.listen(port, () => {
  const s = providerStatus();
  console.log(`ContentStudio running → http://localhost:${port} (build ${BUILD})`);
  console.log(`  Claude: ${s.anthropic ? `ready (${s.model})` : 'no key — template mode'} | ElevenLabs: ${s.elevenlabs ? 'ready' : 'no key'} | HeyGen: ${s.heygen ? 'ready' : 'no key'}`);
});
