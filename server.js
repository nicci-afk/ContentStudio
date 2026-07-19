import fs from 'node:fs';
import path from 'node:path';
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

const { stateStore, mediaStore, packageStore, uid, saveMediaFile, readMediaFile, deleteMediaFiles } =
  await import('./lib/store.js');
const { platformList, PLATFORMS } = await import('./lib/platforms.js');
const { buildLlmsTxt, scorePackage, buildJsonLd } = await import('./lib/visibility.js');
const { providerStatus, elevenVoices, elevenClone, elevenTts, heygenAvatars, heygenVoices, heygenGenerate, heygenStatus, ProviderError } =
  await import('./lib/providers.js');
const { generatePackage, synthesizeBrief, synthesizeVoiceDna, suggestPillars, analyzeMedia } =
  await import('./lib/engine.js');
const { DEMO_STATE } = await import('./lib/demo.js');

const app = express();
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err instanceof ProviderError ? (err.status === 401 ? 424 : 502) : 500;
    res.status(status).json({ error: err.message, provider: err.provider || null });
  });
};

// ---- system --------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0', providers: providerStatus() });
});

app.get('/api/platforms', (req, res) => res.json({ platforms: platformList() }));

app.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(buildLlmsTxt(stateStore.get().profile, packageStore.get().items));
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

app.post('/api/voice-dna', wrap(async (req, res) => {
  const state = stateStore.get();
  const files = (req.body.files || []).map((f) => ({ name: f.name, text: String(f.text || '').slice(0, 100000) }));
  const summary = await synthesizeVoiceDna(files);
  state.profile.voiceDna = {
    sources: files.map((f) => ({ name: f.name, chars: f.text.length, addedAt: new Date().toISOString() })),
    corpus: files.map((f) => ({ name: f.name, text: f.text.slice(0, 20000) })),
    summary,
  };
  stateStore.set(state);
  res.json({ voiceDna: state.profile.voiceDna });
}));

// ---- media ---------------------------------------------------------------

app.get('/api/media', (req, res) => res.json({ items: mediaStore.get().items }));

app.post('/api/media', wrap(async (req, res) => {
  const { name, mime, kind, size, w, h, takenAt, gps, thumbB64, analysisB64 } = req.body;
  const id = uid();
  if (thumbB64) saveMediaFile(id, 'thumb', Buffer.from(thumbB64, 'base64'));
  if (analysisB64) saveMediaFile(id, 'analysis', Buffer.from(analysisB64, 'base64'));
  const record = {
    id, name, mime, kind: kind || (String(mime).startsWith('video') ? 'video' : 'image'),
    size: size || 0, w: w || null, h: h || null,
    takenAt: takenAt || null, gps: gps || null,
    alt: null, caption: null, keywords: [], place: null, quality: null, storyIdeas: [],
    analyzed: false, addedAt: new Date().toISOString(),
  };
  mediaStore.update((m) => ({ items: [record, ...m.items] }));
  res.json({ item: record });
}));

app.get('/api/media/:id/thumb', (req, res) => {
  const buf = readMediaFile(req.params.id, 'thumb');
  if (!buf) return res.status(404).end();
  res.type('image/jpeg').send(buf);
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
  const { topic, angle, pillarId, seriesId, platforms, mediaIds } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  const state = stateStore.get();
  const profile = state.profile;
  const pillar = (profile.pillars || []).find((p) => p.id === pillarId) || null;
  const series = (profile.series || []).find((s) => s.id === seriesId) || null;
  const media = mediaStore.get().items.filter((m) => (mediaIds || []).includes(m.id));

  const jobId = uid();
  const job = { id: jobId, status: 'running', progress: { done: 0, total: (platforms?.length || 12) + 1 }, package: null, error: null };
  jobs.set(jobId, job);

  generatePackage({
    profile, topic, angle, pillar, series, media,
    platformIds: platforms,
    onProgress: (p) => { job.progress = p; },
  })
    .then((pkg) => {
      packageStore.update((s) => ({ items: [pkg, ...s.items] }));
      job.package = pkg;
      job.status = 'done';
    })
    .catch((err) => {
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
  const { avatarId, voiceId, text, title, orientation } = req.body;
  if (!avatarId || !voiceId || !text) return res.status(400).json({ error: 'avatarId, voiceId, text required' });
  res.json(await heygenGenerate({ avatarId, voiceId, text, title, orientation }));
}));

app.get('/api/avatar/status/:id', wrap(async (req, res) => res.json(await heygenStatus(req.params.id))));

// ---- boot ----------------------------------------------------------------

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = Number(process.env.PORT || 4600);
app.listen(port, () => {
  const s = providerStatus();
  console.log(`ContentStudio running → http://localhost:${port}`);
  console.log(`  Claude: ${s.anthropic ? `ready (${s.model})` : 'no key — template mode'} | ElevenLabs: ${s.elevenlabs ? 'ready' : 'no key'} | HeyGen: ${s.heygen ? 'ready' : 'no key'}`);
});
