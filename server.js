import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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
const { providerStatus, elevenVoices, elevenClone, elevenTts, heygenAvatars, heygenVoices, heygenGenerate, heygenStatus, ProviderError } =
  await import('./lib/providers.js');
const { generatePackage, synthesizeBrief, synthesizeVoiceDna, suggestPillars, analyzeMedia, selectMedia } =
  await import('./lib/engine.js');
const { startRender, renderJob, renderFile, listRenders, activeRenderIds } = await import('./lib/render.js');
const { storageReport, cleanupStorage, deleteRender } = await import('./lib/storage.js');
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

app.patch('/api/packages/:id', (req, res) => {
  const { platformId, field, value } = req.body || {};
  const profile = stateStore.get().profile;
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      if (!p.platforms?.[platformId]?.fields || typeof field !== 'string') return p;
      p.platforms[platformId].fields[field] = value;
      p.jsonld = buildJsonLd(p, profile);
      p.visibility = scorePackage(p, profile);
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'unknown package/platform/field' });
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

app.get('/api/render/:id/video', (req, res) => {
  const file = renderFile(req.params.id, 'mp4');
  if (!file) return res.status(404).end();
  res.sendFile(file);
});

app.get('/api/render/:id/srt', (req, res) => {
  const file = renderFile(req.params.id, 'srt');
  if (!file) return res.status(404).end();
  res.type('text/plain').sendFile(file);
});

app.get('/api/packages/:id/renders', (req, res) => {
  res.json({ items: listRenders(req.params.id) });
});

// ---- storage (shared data disk: report, cleanup, render deletion) --------

app.get('/api/storage', (req, res) => res.json(storageReport(activeRenderIds())));

app.post('/api/storage/cleanup', (req, res) => res.json(cleanupStorage(activeRenderIds())));

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
  console.log(`  storage: swept ${Math.round(swept.freedBytes / 1e6)}MB of stale render temp files (${swept.removedTmp} folder(s), ${swept.removedParts} partial upload(s))`);
}

const port = Number(process.env.PORT || 4600);
app.listen(port, () => {
  const s = providerStatus();
  console.log(`ContentStudio running → http://localhost:${port} (build ${BUILD})`);
  console.log(`  Claude: ${s.anthropic ? `ready (${s.model})` : 'no key — template mode'} | ElevenLabs: ${s.elevenlabs ? 'ready' : 'no key'} | HeyGen: ${s.heygen ? 'ready' : 'no key'}`);
});
