import fs from 'node:fs';
import crypto from 'node:crypto';
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

const { stateStore, mediaStore, packageStore, tripStore, uid, saveMediaFile, readMediaFile, deleteMediaFiles, mediaPath,
  listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace,
  listSnapshots, restoreSnapshot, readWorkspace, runWithWorkspace, workspaceExists, setWorkspaceLibrary,
  leadStore, ledgerStore, findWorkspaceByLeadKey, findWorkspaceByCaptureId, findLeadByToken } =
  await import('./lib/store.js');
const { platformList, PLATFORMS } = await import('./lib/platforms.js');
const { buildLlmsTxt, scorePackage, buildJsonLd } = await import('./lib/visibility.js');
const { providerStatus, elevenVoices, elevenClone, elevenTts, heygenAvatars, heygenVoices, heygenGenerate, heygenStatus, heygenQuota, ProviderError, usageReport } =
  await import('./lib/providers.js');
const { checkAsset } = await import('./lib/gate.js');
const hooksLib = await import('./lib/hooks.js');
const trendInputs = await import('./lib/trendinputs.js');
const thumbsLib = await import('./lib/thumbs.js');
const feedbackLib = await import('./lib/feedback.js');
const reviewsLib = await import('./lib/reviews.js');
const entityLib = await import('./lib/entitymon.js');
const pacing = await import('./lib/pacing.js');
const magnetsLib = await import('./lib/magnets.js');
const metaLib = await import('./lib/meta.js');
const { sendMail, mailConfigured } = await import('./lib/mail.js');
const { claudeJson } = await import('./lib/providers.js');
const { leadFrom } = await import('./lib/leads.js');
const { getVoiceCard, DEFAULT_CARD } = await import('./lib/voice.js');
const { attachThumbnails, hookContext, trackedLink } = await import('./lib/engine.js');
const { STATUSES, getKnowledgeBase } = await import('./lib/facts.js');
const { generatePackage, generatePlatforms, synthesizeBrief, synthesizeVoiceDna, suggestPillars, analyzeMedia, selectMedia, matchCarouselSlides, regenerateCitations, writeReshareComment } =
  await import('./lib/engine.js');
const { startRender, renderCapabilities, renderJob, renderFile, rendersDir, listRenders, activeRenderIds, renderPoster, previewFile, enqueuePreview, ffmpegPath, startClipsJob, clipsJob } = await import('./lib/render.js');
const { storageReport, cleanupStorage, deleteRender, diskFree } = await import('./lib/storage.js');
const { registerMediaRoutes } = await import('./lib/media-routes.js');
const { catalog, albumStore, currentLibrary } = await import('./lib/store.js');
const { withAlbumContext } = await import('./lib/albums.js');
const { mediaStatusFor } = await import('./lib/moderation.js');
const shortsLib = await import('./lib/shorts.js');
const { fixNames, fixSrt } = await import('./lib/namefix.js');
const gLib = await import('./lib/google.js');
const measureLib = await import('./lib/measure.js');
const editLib = await import('./lib/edit.js');
const trendLib = await import('./lib/trends.js');
const { backupStatus, runBackup, scheduleBackups } = await import('./lib/backup.js');
const { getPlan, normalizePlan, planQueue, runPlan, planRunning, schedulePlan, FACT_LABELS, MAX_PER_RUN, DAILY_DRAFT_CAP } = await import('./lib/plan.js');
const { DEMO_STATE } = await import('./lib/demo.js');
const { lintProfile } = await import('./lib/lint.js');
const { auditUrl } = await import('./lib/crawl.js');
const { submitIndexNow, newIndexNowKey } = await import('./lib/indexnow.js');
const { buildSiteSetupKit } = await import('./lib/sitekit.js');
const { normalizeTrip, upsertTrips, tripStatus, pickTrip, tripContextBlock, mediaInTrip, parseIcs, todayISO } = await import('./lib/trips.js');
const { EVENT_SIZES, EVENT_TIMINGS, leadChannel, upsertLead, notifyLead, sendLeadToMeta, leadSummary, leadStatuses, newLeadKey, buildAppsScript, sendResourceEmail, nextSequenceStep, inSendWindow, sendSequenceEmail } = await import('./lib/leads.js');
const { loadManifest, findResource, resourcePath } = await import('./lib/resources.js');

const { registerAuthRoutes, authMiddleware } = await import('./lib/auth.js');

const app = express();

// Auth: magic-link email sign-in (MAGIC_EMAILS allowlist) and/or the studio
// password — both produce a 30-day session cookie. Basic auth still works
// for API tools. /api/health and /llms.txt stay public by design.
app.use(express.json({ limit: '80mb' }));
registerAuthRoutes(app, path.join(__dirname, 'public'));
app.use(authMiddleware);

// Per-browser workspace: the cs_ws cookie (set when a workspace is picked)
// or an X-Workspace header (API tools) decides which business this request
// reads and writes, so two people can work in different brands at once.
const WS_COOKIE = 'cs_ws';
const setWsCookie = (res, id) =>
  res.setHeader('Set-Cookie',
    `${WS_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${process.env.NODE_ENV === 'development' ? '' : '; Secure'}`);
app.use((req, res, next) => {
  const fromCookie = (req.headers.cookie || '').split(';').map((c) => c.trim())
    .find((c) => c.startsWith(`${WS_COOKIE}=`))?.slice(WS_COOKIE.length + 1);
  const id = String(req.headers['x-workspace'] || fromCookie || '');
  if (id && workspaceExists(id)) return runWithWorkspace(id, next);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    // 401 -> 424 (needs auth/config) and 429 pass through as-is (the
    // provider client already retries transient 429s with backoff, so one
    // reaching here means the caller should back off too); anything else
    // provider-side collapses to a generic 502.
    const status = err instanceof ProviderError
      ? (err.status === 401 ? 424 : err.status === 429 ? 429 : 502)
      : 500;
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

// Workspace-scoped on purpose: this is a public, unauthenticated route a
// crawler can hit at any time, so it must never depend on whichever
// workspace a human happens to have open in the UI right now (the bug the
// bare stateStore/packageStore singletons have everywhere else). This URL
// on contentstudio-zc9j.onrender.com is a source for each brand's own
// website to fetch from, not the URL a crawler will ever check: llms.txt
// is only ever looked for at a site's own domain root, so the real fix per
// brand is getting this content served from https://<their domain>/llms.txt.
app.get('/llms.txt', (req, res) => {
  const id = req.query.workspace;
  const ws = id ? readWorkspace(String(id)) : null;
  if (!ws) {
    const items = listWorkspaces().items;
    res.status(400).type('text/plain').send(
      `Add ?workspace=<id> to this URL. Known workspaces:\n${items.map((w) => `${w.id}  ${w.name}`).join('\n')}`
    );
    return;
  }
  res.type('text/plain').send(buildLlmsTxt(ws.state.profile, ws.packages.items));
});

// ---- workspaces (one per business; all data below is workspace-scoped) ---

app.get('/api/workspaces', (req, res) => res.json(listWorkspaces()));

app.post('/api/workspaces', (req, res) => {
  const id = createWorkspace(req.body?.name, req.body?.library);
  setWsCookie(res, id);
  runWithWorkspace(id, () => res.json(listWorkspaces()));
});

// Picking a workspace only points THIS browser at it; nobody else's view
// (and no server-wide pointer) changes.
app.post('/api/workspaces/:id/activate', (req, res) => {
  if (!workspaceExists(req.params.id)) return res.status(404).json({ error: 'unknown workspace' });
  setWsCookie(res, req.params.id);
  runWithWorkspace(req.params.id, () => res.json(listWorkspaces()));
});

app.patch('/api/workspaces/:id', (req, res) => {
  const { name, library } = req.body || {};
  if (library && !setWorkspaceLibrary(req.params.id, library)) return res.status(400).json({ error: 'bad library or workspace' });
  if (name && !renameWorkspace(req.params.id, name)) return res.status(400).json({ error: 'name required' });
  if (!name && !library) return res.status(400).json({ error: 'name or library required' });
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
  // The Content Plan is server-owned (the scheduler records topic status and
  // run times in it), so a whole-state save from any other view keeps the
  // stored plan instead of overwriting it with that tab's older copy.
  const storedPlan = stateStore.get()?.profile?.contentPlan;
  if (storedPlan && req.body?.profile) req.body.profile.contentPlan = storedPlan;
  // Same for the quality-module data saved through their own routes
  // (knowledge base, voice card, posting exceptions): a stale tab must never
  // roll them back.
  const stored = stateStore.get()?.profile || {};
  if (req.body?.profile) {
    for (const k of ['knowledgeBase', 'voiceCard']) if (stored[k] !== undefined) req.body.profile[k] = stored[k];
    if (stored.business?.bookingUrl && req.body.profile.business && req.body.profile.business.bookingUrl === undefined) req.body.profile.business.bookingUrl = stored.business.bookingUrl;
    if (stored.publishing?.automation) req.body.profile.publishing = { ...(req.body.profile.publishing || {}), automation: stored.publishing.automation };
  }
  stateStore.set(req.body);
  res.json({ ok: true, warnings: lintProfile(stateStore.get().profile || {}) });
});

// Rule breaks sitting in the creator's own profile text (blocklisted words,
// disparaging vocabulary, dashes). Pure string checks, no model tokens.
app.get('/api/profile/lint', (req, res) => res.json({ warnings: lintProfile(stateStore.get().profile || {}) }));

// Once-per-site setup prompt (freshness dates, IndexNow key file, Meta Pixel,
// paid-social link template). The IndexNow key is minted on first use and
// kept on the workspace profile so the key file the site serves never changes.
app.get('/api/site-setup-kit', (req, res) => {
  const state = stateStore.get();
  const biz = (state.profile.business = state.profile.business || {});
  if (!biz.indexNowKey) {
    biz.indexNowKey = newIndexNowKey();
    stateStore.set(state);
  }
  res.json({ markdown: buildSiteSetupKit(state.profile, biz.indexNowKey), indexNowKey: biz.indexNowKey });
});

// ---- leads ---------------------------------------------------------------
// The Google Form bridge (Apps Script) posts each application here with a
// per-workspace secret. Auth is the key, not a session, so this one path is
// public in lib/auth.js. Rate limited per IP; unknown keys are counted harder.

const leadHits = new Map();
const leadFails = new Map();
const hit = (map, key, max, windowMs) => {
  const now = Date.now();
  const e = map.get(key);
  if (!e || e.reset < now) { map.set(key, { n: 1, reset: now + windowMs }); return false; }
  e.n += 1;
  return e.n > max;
};
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

const record = (id, patch) => leadStore.update((d) => ({ ...d, items: d.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
const stamp = (o) => ({ ...o, at: new Date().toISOString() });
const errStatus = (err) => ({ status: 'error', reason: String(err.message).slice(0, 200) });

// Shared after-reply work for a new lead. Runs inside the workspace context.
async function leadSideEffects(lead, { capiEvent, capiEventId } = {}) {
  const biz = stateStore.get().profile?.business || {};
  const brand = biz.name || 'your business';
  const settings = leadStore.get().settings || {};
  try {
    record(lead.id, { notify: stamp(await notifyLead(lead, { to: settings.notifyEmail || process.env.LEAD_NOTIFY_EMAIL, brand })) });
  } catch (err) { record(lead.id, { notify: stamp(errStatus(err)) }); }
  try {
    record(lead.id, { capi: stamp(await sendLeadToMeta(lead, { pixelId: biz.metaPixelId, site: biz.links?.website, brand, eventName: capiEvent, eventId: capiEventId })) });
  } catch (err) { record(lead.id, { capi: stamp(errStatus(err)) }); }
}

app.post('/api/leads/ingest', wrap(async (req, res) => {
  const ip = clientIp(req);
  if (hit(leadHits, ip, 120, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many requests' });
  if (JSON.stringify(req.body || {}).length > 20000) return res.status(413).json({ error: 'payload too large' });
  const wsId = findWorkspaceByLeadKey(req.get('x-ingest-key'));
  if (!wsId) {
    if (hit(leadFails, ip, 20, 15 * 60 * 1000)) return res.status(429).json({ error: 'too many requests' });
    return res.status(401).json({ error: 'invalid key' });
  }
  await runWithWorkspace(wsId, async () => {
    const out = upsertLead(leadStore, req.body, { stage: 'application' });
    if (out.error) return res.status(400).json({ error: out.error });
    const { lead, firstApplication } = out;
    res.json({ ok: true, id: lead.id, tier: lead.score.tier, duplicate: out.duplicate });
    // Alert and Meta event once per person for the application, even when they
    // first arrived by downloading a resource.
    if (firstApplication) await leadSideEffects(lead, { capiEvent: 'SubmitApplication', capiEventId: `${lead.id}-app` });
  });
}));

// ---- public sign-up for a free resource (landing page form) --------------
// The page holds only a non-secret capture id. Safeguards: the request must
// come from the workspace's own site origin, a honeypot field, per-IP and
// global rate limits, one delivery email per address per resource per day,
// and an explicit email consent that is recorded with its wording and time.

const captureHits = new Map();
const captureGlobal = { n: 0, reset: 0 };
const originsFor = (wsId) => {
  const site = (readWorkspace(wsId)?.state?.profile?.business?.links?.website || '').trim();
  let host = '';
  try { host = new URL(site).hostname.replace(/^www\./, ''); } catch { /* none */ }
  const extra = (process.env.LEAD_ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return host ? [`https://${host}`, `https://www.${host}`, ...extra] : extra;
};
const corsHeaders = (res, origin) => {
  res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400' });
};
const publicBase = (req) => `${String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0]}://${req.get('host')}`;
const CONSENT_TEXT_V1 = 'Email me this resource and occasional notes about The Conscious Creator. I can unsubscribe at any time.';
// Per-brand email context from the workspace manifest and profile (host shown in the footer, accent color).
const siteHostOf = (manifest, biz) => manifest?.siteHost || (() => { try { return new URL(biz?.links?.website || '').hostname.replace(/^www\./, ''); } catch { return ''; } })();
const mailCtx = (manifest) => ({ siteHost: siteHostOf(manifest, stateStore.get().profile?.business), accent: manifest?.accent });

// Preflight: the page posts to /api/leads/capture?id=<captureId> so the browser's
// OPTIONS request already names the workspace whose site origin may call it.
app.options('/api/leads/capture', (req, res) => {
  const origin = req.get('origin') || '';
  const wsId = findWorkspaceByCaptureId(req.query.id);
  if (wsId && originsFor(wsId).includes(origin)) corsHeaders(res, origin);
  res.status(204).end();
});

// Optional self-reported source (a fixed list, so free text never lands here).
const HOW_HEARD = ['An AI assistant (ChatGPT, Claude, Perplexity, or similar)', 'Google or Bing search', 'Instagram or Facebook', 'LinkedIn', 'YouTube', 'A friend or colleague', 'Podcast or event', 'Email', 'Somewhere else'];
app.post('/api/leads/capture', wrap(async (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  if (captureGlobal.reset < now) { captureGlobal.n = 0; captureGlobal.reset = now + 60 * 60 * 1000; }
  if (++captureGlobal.n > 200 || hit(captureHits, ip, 12, 60 * 60 * 1000)) return res.status(429).json({ error: 'too many requests, please try again later' });
  const b = req.body || {};
  const wsId = findWorkspaceByCaptureId(b.captureId);
  if (!wsId) return res.status(404).json({ error: 'unknown form' });
  const origin = req.get('origin') || '';
  if (!originsFor(wsId).includes(origin)) return res.status(403).json({ error: 'origin not allowed' });
  corsHeaders(res, origin);
  if (String(b.hp || '').trim()) return res.json({ ok: true }); // honeypot: pretend success, store nothing
  if (b.emailConsent !== true) return res.status(400).json({ error: 'please tick the box to receive your resource by email' });
  if (b.magnet) return captureMagnet(req, res, wsId, b);
  const resource = findResource(wsId, String(b.resource || ''));
  if (!resource) return res.status(400).json({ error: 'unknown resource' });
  await runWithWorkspace(wsId, async () => {
    const tags = {
      utm_source: b.utm_source, utm_medium: b.utm_medium, utm_campaign: b.utm_campaign, utm_content: b.utm_content, fbclid: b.fbclid, page: b.page,
      referrer: String(b.referrer || '').toLowerCase().replace(/[^a-z0-9.\-]/g, ''),
    };
    const out = upsertLead(leadStore, {
      firstName: b.firstName, email: b.email, yearsAdvisor: b.yearsAdvisor, agency: b.agency,
      howHeard: HOW_HEARD.includes(b.howHeard) ? b.howHeard : '',
      role: b.role, eventSize: EVENT_SIZES.includes(b.eventSize) ? b.eventSize : '', eventTiming: EVENT_TIMINGS.includes(b.eventTiming) ? b.eventTiming : '',
      consent: b.adConsent === true, sourceTags: tags, fbc: b.fbc, fbp: b.fbp,
    }, { stage: 'resource', resource: resource.slug, optIn: { at: new Date().toISOString(), text: (loadManifest(wsId) || {}).consentText || CONSENT_TEXT_V1, page: String(b.page || '').slice(0, 300) } });
    if (out.error) return res.status(400).json({ error: out.error });
    const { lead } = out;
    const base = publicBase(req);
    leadStore.update((d) => (d.settings?.publicBase === base ? d : { ...d, settings: { ...(d.settings || {}), publicBase: base } }));
    const downloadUrl = `${base}/r/${lead.token}/${resource.slug}.pdf`;
    res.json({ ok: true, eventId: lead.id, downloadUrl, message: 'Check your inbox. Your resource is on its way.' });

    const manifest = loadManifest(wsId) || {};
    const biz = stateStore.get().profile?.business || {};
    const settings = leadStore.get().settings || {};
    // One delivery email per address per resource per day (blocks email bombing).
    const recent = (lead.deliveries || []).find((d) => d.slug === resource.slug && Date.now() - Date.parse(d.at) < 24 * 3600 * 1000);
    if (!recent && !lead.unsubscribed) {
      try {
        const r = await sendResourceEmail({
          lead, resource, brand: manifest.legalName || biz.name || 'The Conscious Creator', person: manifest.person || biz.person?.name || '', address: manifest.senderAddress || '',
          downloadUrl, unsubUrl: `${base}/unsubscribe/${lead.token}`,
          applyUrl: manifest.applyUrl || '', lookInsideUrl: manifest.lookInsideUrl || '', replyTo: settings.notifyEmail, ...mailCtx(manifest),
        });
        leadStore.update((d) => ({ ...d, items: d.items.map((x) => (x.id === lead.id ? { ...x, delivery: stamp(r), deliveries: [...(x.deliveries || []), { slug: resource.slug, at: new Date().toISOString() }] } : x)) }));
      } catch (err) { record(lead.id, { delivery: stamp(errStatus(err)) }); }
    }
    if (out.newResource) {
      // Alert and Meta Lead event once per person for a first resource.
      const firstResource = !out.duplicate;
      if (firstResource || lead.capi?.status !== 'sent') await leadSideEffects(lead, { capiEvent: 'Lead', capiEventId: lead.id });
    }
  });
}));

// Interactive lead magnet sign-up: same safeguards as a resource (origin,
// honeypot, rate limits, recorded consent), plus only known option ids and
// clamped numbers are kept from the visitor's answers.
async function captureMagnet(req, res, wsId, b) {
  await runWithWorkspace(wsId, async () => {
    const m = magnetsLib.getMagnet(String(b.magnet || ''));
    if (!m || m.status !== 'approved') return res.status(400).json({ error: 'unknown form' });
    const sub = magnetsLib.sanitizeSubmission(m, b);
    const tags = {
      utm_source: b.utm_source, utm_medium: b.utm_medium, utm_campaign: b.utm_campaign, utm_content: b.utm_content, page: b.page,
      referrer: String(b.referrer || '').toLowerCase().replace(/[^a-z0-9.\-]/g, ''),
    };
    const out = upsertLead(leadStore, { firstName: b.firstName, email: b.email, consent: b.adConsent === true, sourceTags: tags, fbc: b.fbc, fbp: b.fbp },
      { stage: 'resource', resource: `magnet:${m.slug}`, optIn: { at: new Date().toISOString(), text: m.consentText, page: String(b.page || '').slice(0, 300) } });
    if (out.error) return res.status(400).json({ error: out.error });
    const { lead } = out;
    const entry = { slug: m.slug, kind: m.kind, resultKey: sub.resultKey, ...(sub.answers ? { answers: sub.answers } : {}), ...(sub.inputs ? { inputs: sub.inputs, outputs: sub.outputs } : {}), at: new Date().toISOString() };
    record(lead.id, { magnets: [...(lead.magnets || []), entry].slice(-20) });
    const base = publicBase(req);
    leadStore.update((d) => (d.settings?.publicBase === base ? d : { ...d, settings: { ...(d.settings || {}), publicBase: base } }));
    res.json({ ok: true, eventId: lead.id, resultKey: sub.resultKey, message: 'Check your inbox. Your result is on its way.' });

    const manifest = loadManifest(wsId) || {};
    const biz = stateStore.get().profile?.business || {};
    const settings = leadStore.get().settings || {};
    const fresh = leadStore.get().items.find((x) => x.id === lead.id) || lead;
    const recent = (fresh.deliveries || []).find((d) => d.slug === `magnet:${m.slug}` && Date.now() - Date.parse(d.at) < 24 * 3600 * 1000);
    if (!recent && !fresh.unsubscribed) {
      try {
        if (!mailConfigured()) throw new Error('no email provider configured');
        const r = m.results.find((x) => x.key === sub.resultKey);
        const linked = r?.resourceSlug ? findResource(wsId, r.resourceSlug) : null;
        const { subject, html } = magnetsLib.resultEmail({ m, lead: fresh, submission: sub, brand: manifest.legalName || biz.name || '', person: manifest.person || biz.person?.name || '', unsubUrl: `${base}/unsubscribe/${fresh.token}`, downloadUrl: linked ? `${base}/r/${fresh.token}/${linked.slug}.pdf` : '', ...mailCtx(manifest) });
        await sendMail({ to: fresh.email, subject, html, from: leadFrom(manifest.person || biz.person?.name || ''), replyTo: settings.notifyEmail || undefined, headers: { 'List-Unsubscribe': `<${base}/unsubscribe/${fresh.token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
        leadStore.update((d) => ({ ...d, items: d.items.map((x) => (x.id === lead.id ? { ...x, delivery: stamp({ status: 'sent' }), deliveries: [...(x.deliveries || []), { slug: `magnet:${m.slug}`, at: new Date().toISOString() }] } : x)) }));
      } catch (err) { record(lead.id, { delivery: stamp(errStatus(err)) }); }
    }
    if (out.newResource && (!out.duplicate || lead.capi?.status !== 'sent')) await leadSideEffects(lead, { capiEvent: 'Lead', capiEventId: lead.id });
  });
}

// Tokenized download of a resource PDF. The token is per lead and unguessable.
app.get('/r/:token/:file', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  const hit1 = findLeadByToken(req.params.token);
  if (!hit1) return res.status(404).type('text').send('This link is not valid.');
  const slug = req.params.file.replace(/\.pdf$/i, '');
  const resource = findResource(hit1.wsId, slug);
  const file = resource && resourcePath(hit1.wsId, resource);
  if (!file) return res.status(404).type('text').send('This resource is not available.');
  runWithWorkspace(hit1.wsId, () => {
    leadStore.update((d) => ({ ...d, items: d.items.map((x) => (x.id === hit1.lead.id ? { ...x, downloads: (x.downloads || 0) + 1, lastDownloadAt: new Date().toISOString() } : x)) }));
  });
  res.set('Cache-Control', 'private, no-store');
  res.type('application/pdf');
  res.set('Content-Disposition', `inline; filename="${slug}.pdf"`);
  res.sendFile(file);
});

// One-click unsubscribe (also the List-Unsubscribe target).
const unsub = (req, res, post) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  const found = findLeadByToken(req.params.token);
  if (found) {
    runWithWorkspace(found.wsId, () => {
      record(found.lead.id, { unsubscribed: true, unsubscribedAt: new Date().toISOString() });
    });
  }
  if (post) return res.status(200).end();
  const brand = found ? (readWorkspace(found.wsId)?.state?.profile?.business?.name || 'this list') : 'this list';
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title><body style="font-family:Georgia,serif;max-width:480px;margin:12vh auto;padding:0 20px;color:#0d1216"><h1 style="font-weight:400">You are unsubscribed.</h1><p>${found ? `You will not receive further emails from ${brand.replace(/[<>&"]/g, '')}.` : 'This link is no longer active, so there is nothing more to do.'}</p></body>`);
};
app.get('/unsubscribe/:token', (req, res) => unsub(req, res, false));
app.post('/unsubscribe/:token', (req, res) => unsub(req, res, true));


// ---- follow-up scheduler -------------------------------------------------
// Runs every 15 minutes. Off by default per workspace (settings.sequenceEnabled).
// Sends at most one email per eligible lead per tick, only in local business
// hours, and stops for anyone who unsubscribed, applied, or was marked
// applied, won or lost. A step that fails three times is skipped, never spammed.
let sequenceRunning = false;
async function runSequences(nowMs = Date.now()) {
  if (sequenceRunning || (!process.env.SEQUENCE_IGNORE_WINDOW && !inSendWindow(nowMs))) return;
  sequenceRunning = true;
  try {
    for (const w of listWorkspaces().items) {
      await runWithWorkspace(w.id, async () => {
        const settings = leadStore.get().settings || {};
        const manifest = loadManifest(w.id);
        if (!settings.sequenceEnabled || !manifest?.sequence?.length) return;
        const base = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || settings.publicBase;
        if (!base) return;
        for (const lead of leadStore.get().items.slice()) {
          const due = nextSequenceStep(lead, manifest.sequence, nowMs);
          if (!due.step) continue;
          const patchSeq = (fn) => leadStore.update((d) => ({ ...d, items: d.items.map((x) => (x.id === lead.id ? { ...x, sequence: fn(x.sequence || { sent: [], failures: {} }) } : x)) }));
          try {
            const r = await sendSequenceEmail({
              lead, step: due.step, brand: manifest.legalName || '', person: manifest.person || '', address: manifest.senderAddress || '',
              unsubUrl: `${base}/unsubscribe/${lead.token}`, replyTo: settings.notifyEmail, ...mailCtx(manifest),
            });
            if (r.status === 'sent') patchSeq((q) => ({ ...q, sent: [...(q.sent || []), { day: due.step.day, at: new Date().toISOString() }] }));
          } catch (err) {
            patchSeq((q) => ({ ...q, failures: { ...(q.failures || {}), [due.step.day]: ((q.failures || {})[due.step.day] || 0) + 1 }, lastError: String(err.message).slice(0, 160) }));
          }
        }
      });
    }
  } finally { sequenceRunning = false; }
}
if (!process.env.DISABLE_SEQUENCES) {
  setTimeout(() => runSequences().catch(() => {}), Number(process.env.SEQUENCE_FIRST_RUN_MS || 90 * 1000)).unref?.();
  setInterval(() => runSequences().catch(() => {}), 15 * 60 * 1000).unref?.();
}

app.get('/api/leads', (req, res) => {
  const d = leadStore.get();
  const s = d.settings || {};
  res.json({
    items: d.items.map((l) => ({ ...l, channel: leadChannel(l) })),
    summary: leadSummary(d.items),
    statuses: leadStatuses(),
    settings: {
      notifyEmail: s.notifyEmail || process.env.LEAD_NOTIFY_EMAIL || '',
      keyMinted: !!s.ingestKey,
      captureId: s.captureId || '',
      sequence: { enabled: s.sequenceEnabled === true, steps: ((loadManifest(listWorkspaces().activeId) || {}).sequence || []).map((x) => ({ day: x.day, subject: x.subject })) },
      resources: (loadManifest(listWorkspaces().activeId) || {}).resources || [],
      capi: { tokenSet: !!process.env.META_CAPI_TOKEN, pixelId: stateStore.get().profile?.business?.metaPixelId || '', testMode: !!process.env.META_TEST_EVENT_CODE },
    },
  });
});

// Mints the ingest key on first use and returns the ready-to-paste script.
app.get('/api/leads/setup', (req, res) => {
  const d = leadStore.get();
  const settings = { ...(d.settings || {}) };
  if (!settings.ingestKey || !settings.captureId) {
    settings.ingestKey = settings.ingestKey || newLeadKey();
    settings.captureId = settings.captureId || newLeadKey().slice(0, 20);
    leadStore.set({ ...d, settings });
  }
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  const endpoint = `${proto}://${req.get('host')}/api/leads/ingest`;
  res.json({ endpoint, ingestKey: settings.ingestKey, captureId: settings.captureId, captureEndpoint: `${proto}://${req.get('host')}/api/leads/capture`, appsScript: buildAppsScript({ endpoint, key: settings.ingestKey }) });
});

app.put('/api/leads/settings', (req, res) => {
  const d = leadStore.get();
  const patch = {};
  if (req.body?.notifyEmail !== undefined) {
    const to = String(req.body.notifyEmail || '').trim().toLowerCase();
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'enter a valid email address' });
    patch.notifyEmail = to;
  }
  if (req.body?.sequenceEnabled !== undefined) patch.sequenceEnabled = req.body.sequenceEnabled === true;
  leadStore.set({ ...d, settings: { ...(d.settings || {}), ...patch } });
  res.json({ ok: true });
});

// Send one follow-up email to the owner as a preview. Never touches a lead.
app.post('/api/leads/sequence/test', wrap(async (req, res) => {
  const manifest = loadManifest(listWorkspaces().activeId) || {};
  const step = (manifest.sequence || []).find((x) => x.day === Number(req.body?.day));
  const to = leadStore.get().settings?.notifyEmail;
  if (!step) return res.status(400).json({ error: 'unknown step' });
  if (!to) return res.status(400).json({ error: 'set your notification email first' });
  const base = `${String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0]}://${req.get('host')}`;
  try {
    const r = await sendSequenceEmail({
      lead: { firstName: 'Friend', email: to }, step, to, subjectPrefix: '[PREVIEW] ',
      brand: manifest.legalName || '', person: manifest.person || '', address: manifest.senderAddress || '',
      unsubUrl: `${base}/unsubscribe/preview`, replyTo: to, ...mailCtx(manifest),
    });
    res.json({ ok: true, ...r });
  } catch (err) { res.status(502).json({ error: String(err.message).slice(0, 200) }); }
}));

app.patch('/api/leads/:id', (req, res) => {
  const d = leadStore.get();
  if (!d.items.some((x) => x.id === req.params.id)) return res.status(404).json({ error: 'not found' });
  const patch = {};
  if (req.body?.status !== undefined) {
    if (!leadStatuses().includes(req.body.status)) return res.status(400).json({ error: 'unknown status' });
    patch.status = req.body.status;
    // Stage timestamps close the attribution loop (booked call, signed).
    const now = new Date().toISOString();
    if (req.body.status === 'call_booked') patch.bookedAt = now;
    if (req.body.status === 'won') patch.wonAt = now;
  }
  if (req.body?.notes !== undefined) patch.notes = String(req.body.notes).slice(0, 2000);
  leadStore.set({ ...d, items: d.items.map((x) => (x.id === req.params.id ? { ...x, ...patch, bookedAt: x.bookedAt || patch.bookedAt, wonAt: x.wonAt || patch.wonAt, updatedAt: new Date().toISOString() } : x)) });
  res.json({ ok: true });
});

// Deletion on request (a lead's right to be forgotten).
app.delete('/api/leads/:id', (req, res) => {
  const d = leadStore.get();
  leadStore.set({ ...d, items: d.items.filter((x) => x.id !== req.params.id) });
  res.json({ ok: true });
});

// ---- Visibility Ledger ----------------------------------------------------
// Fixed buyer questions per workspace, checked monthly (and on demand) to see
// whether AI answers name the brand and cite its own pages. Answers from other
// assistants are pasted in by hand. See lib/ledger.js.
const { ENGINES, MONTH_MS, newQuestions, summarize, runClaudeCheck, recordManual, suggestQuestions } = await import('./lib/ledger.js');
const ledgerRunning = new Set();
const ledgerView = (wsId) => {
  const data = ledgerStore.get();
  const sum = summarize(data);
  return {
    settings: { enabled: !!data.settings?.enabled, terms: data.settings?.terms || [], domains: data.settings?.domains || [], lastRunAt: data.settings?.lastRunAt || null },
    questions: sum.questions, byEngine: sum.byEngine, history: sum.history.slice(0, 24),
    engines: ENGINES, running: ledgerRunning.has(wsId) || sum.runs.some((r) => r.status === 'running'),
    aiConfigured: !!process.env.ANTHROPIC_API_KEY,
  };
};
const startLedgerRun = (wsId) => {
  ledgerRunning.add(wsId);
  runWithWorkspace(wsId, () => runClaudeCheck(ledgerStore, stateStore.get().profile))
    .catch((err) => console.error('ledger run failed:', err.message))
    .finally(() => ledgerRunning.delete(wsId));
};
app.get('/api/ledger', (req, res) => res.json(ledgerView(listWorkspaces().activeId)));
app.put('/api/ledger/questions', (req, res) => {
  const list = Array.isArray(req.body?.questions) ? req.body.questions : [];
  ledgerStore.update((d) => ({ ...d, questions: newQuestions(d.questions || [], list) }));
  res.json(ledgerView(listWorkspaces().activeId));
});
app.put('/api/ledger/settings', (req, res) => {
  const b = req.body || {};
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 20);
  ledgerStore.update((d) => ({ ...d, settings: {
    ...(d.settings || {}),
    ...(b.enabled !== undefined ? { enabled: b.enabled === true } : {}),
    ...(b.terms !== undefined ? { terms: list(b.terms) } : {}),
    ...(b.domains !== undefined ? { domains: list(b.domains) } : {}),
  } }));
  res.json(ledgerView(listWorkspaces().activeId));
});
app.post('/api/ledger/suggest', wrap(async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
  res.json({ questions: await suggestQuestions(stateStore.get().profile) });
}));
app.post('/api/ledger/run', (req, res) => {
  const wsId = listWorkspaces().activeId;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (ledgerRunning.has(wsId)) return res.status(409).json({ error: 'a check is already running' });
  if (!ledgerStore.get().questions?.length) return res.status(400).json({ error: 'add at least one question first' });
  startLedgerRun(wsId);
  res.status(202).json({ started: true });
});
app.post('/api/ledger/manual', (req, res) => {
  try { recordManual(ledgerStore, stateStore.get().profile, req.body || {}); } catch (err) { return res.status(400).json({ error: err.message }); }
  res.json(ledgerView(listWorkspaces().activeId));
});
app.delete('/api/ledger/runs/:id', (req, res) => {
  ledgerStore.update((d) => ({ ...d, runs: (d.runs || []).filter((r) => r.id !== req.params.id) }));
  res.json(ledgerView(listWorkspaces().activeId));
});
// Monthly auto-check: only for workspaces that switched it on and have questions.
let ledgerSweeping = false;
async function sweepLedgers(nowMs = Date.now()) {
  if (ledgerSweeping || !process.env.ANTHROPIC_API_KEY) return;
  ledgerSweeping = true;
  try {
    for (const w of listWorkspaces().items) {
      if (ledgerRunning.has(w.id)) continue;
      const due = await runWithWorkspace(w.id, async () => {
        const d = ledgerStore.get();
        const last = Date.parse(d.settings?.lastRunAt || '') || 0;
        return d.settings?.enabled && d.questions?.length && nowMs - last >= MONTH_MS;
      });
      if (due) { startLedgerRun(w.id); while (ledgerRunning.has(w.id)) await new Promise((r) => setTimeout(r, 5000)); }
    }
  } finally { ledgerSweeping = false; }
}
if (!process.env.DISABLE_LEDGER) {
  setTimeout(() => sweepLedgers().catch(() => {}), Number(process.env.LEDGER_FIRST_RUN_MS || 5 * 60 * 1000)).unref?.();
  setInterval(() => sweepLedgers().catch(() => {}), 6 * 3600 * 1000).unref?.();
}

// Token and prompt-cache ledger for this server process (resets on restart).
app.get('/api/usage', (req, res) => res.json(usageReport()));

app.patch('/api/state', (req, res) => {
  const { path: keyPath, value } = req.body;
  const state = stateStore.get();
  const keys = String(keyPath).split('.');
  let node = state;
  for (const k of keys.slice(0, -1)) node = node[k] = node[k] || {};
  node[keys.at(-1)] = value;
  stateStore.set(state);
  // Only profile edits can introduce a profile rule break.
  res.json({ ok: true, ...(keys[0] === 'profile' ? { warnings: lintProfile(state.profile || {}) } : {}) });
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

// ---- media, ingest, moderation, albums (lib/media-routes.js) -------------
// Everything below is scoped to the requesting workspace's library. Held and
// unscreened items never reach the package, render or publish paths.
registerMediaRoutes(app, { wrap, stateStore, ffmpegPath });

// ---- strategy ------------------------------------------------------------

app.post('/api/pillars/suggest', wrap(async (req, res) => {
  const result = await suggestPillars(stateStore.get().profile);
  res.json(result);
}));

// ---- trips ---------------------------------------------------------------
// Manual first: trips are entered or picked from a calendar export. Each one
// keeps its source and the calendar's event id, so a later automatic sync
// can update the same trips instead of duplicating them.

app.get('/api/trips', (req, res) => {
  const today = todayISO();
  const items = tripStore.get().items.map((t) => ({ ...t, status: tripStatus(t, today) }));
  const picked = pickTrip(tripStore.get().items, today);
  res.json({ today, items, autoPickId: picked?.id || null });
});

app.post('/api/trips/upsert', (req, res) => {
  const incoming = Array.isArray(req.body?.trips) ? req.body.trips.slice(0, 200) : [];
  if (!incoming.length) return res.status(400).json({ error: 'trips[] required' });
  tripStore.update((s) => ({ items: upsertTrips(s.items, incoming) }));
  res.json({ items: tripStore.get().items.map((t) => ({ ...t, status: tripStatus(t, todayISO()) })) });
});

app.put('/api/trips/:id', (req, res) => {
  let hit = null;
  tripStore.update((s) => ({
    items: s.items.map((t) => {
      if (t.id !== req.params.id) return t;
      hit = normalizeTrip({ ...t, ...req.body, id: t.id, createdAt: t.createdAt, source: t.source, externalId: t.externalId });
      return hit || t;
    }),
  }));
  if (!hit) return res.status(400).json({ error: 'a trip needs a name and a valid start date (YYYY-MM-DD)' });
  res.json({ trip: hit });
});

app.delete('/api/trips/:id', (req, res) => {
  tripStore.update((s) => ({ items: s.items.filter((t) => t.id !== req.params.id) }));
  res.json({ ok: true });
});

// Parses a Google Calendar (.ics) export and proposes upcoming all-day or
// multi-day events. Nothing is saved: the creator ticks the trips.
app.post('/api/trips/ics', (req, res) => {
  const text = String(req.body?.ics || '');
  if (!text.includes('BEGIN:VCALENDAR')) return res.status(400).json({ error: 'that does not look like a calendar (.ics) export' });
  const have = new Set(tripStore.get().items.map((t) => t.externalId).filter(Boolean));
  const candidates = parseIcs(text).slice(0, 300).map((c) => ({ ...c, exists: !!(c.externalId && have.has(c.externalId)) }));
  res.json({ candidates, total: candidates.length });
});

// ---- content plan (autopilot drafting; drafts only, never approves) -------

const planJobs = new Map();
const activeWsId = () => listWorkspaces().activeId;

app.get('/api/plan', (req, res) => {
  const plan = getPlan(stateStore.get().profile);
  res.json({
    plan, factLabels: FACT_LABELS, maxPerRun: MAX_PER_RUN, dailyCap: DAILY_DRAFT_CAP,
    running: planRunning(activeWsId()),
  });
});

app.put('/api/plan', (req, res) => {
  const plan = normalizePlan(req.body || {}, stateStore.get().profile?.contentPlan || {});
  const state = stateStore.get();
  state.profile = { ...(state.profile || {}), contentPlan: plan };
  stateStore.set(state);
  res.json({ plan });
});

// Job-based like /api/generate: a run can take minutes. Switched-off plans
// answer immediately with a reason and start nothing.
app.post('/api/plan/run', (req, res) => {
  const wsId = activeWsId();
  const itemId = req.body?.itemId ? String(req.body.itemId) : undefined;
  if (!stateStore.get().profile?.contentPlan?.enabled) {
    return res.json({ ran: false, reason: 'Content Plan is switched off for this business.' });
  }
  if (planRunning(wsId)) return res.json({ ran: false, reason: 'A run is already in progress for this business.' });
  const jobId = uid();
  const job = { id: jobId, status: 'running', result: null, error: null };
  planJobs.set(jobId, job);
  runPlan(wsId, { itemId })
    .then((result) => { job.result = result; job.status = 'done'; })
    .catch((err) => { job.status = 'error'; job.error = err.message; });
  res.json({ ran: true, jobId });
});

app.get('/api/plan/run/:jobId', (req, res) => {
  const job = planJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(job);
});

app.get('/api/plan/queue', (req, res) => res.json(planQueue(activeWsId())));

// ---- generation (job-based so the UI can show live progress) -------------

const jobs = new Map();

// Module 4 entry point: one core idea in, native outputs out (Instagram,
// LinkedIn, Facebook by default), each validated on its own.
app.post('/api/formats', (req, res, next) => {
  const b = req.body || {};
  // One entity per call: the voice card and knowledge base are this workspace's.
  if (b.entityId && b.entityId !== listWorkspaces().activeId) return res.status(400).json({ error: 'entity_id must be the active workspace; switch to that business first' });
  const refs = b.asset_refs || b.assetRefs || [];
  req.body = { topic: b.core_idea || b.coreIdea || b.topic, angle: b.angle, hookId: b.hook_id || b.hookId, mediaIds: refs, platforms: b.platforms?.length ? b.platforms : ['instagram_post', 'linkedin', 'facebook'], quick: true, ctaUrl: b.ctaUrl, pillarId: b.pillarId, tripId: b.tripId, autoMedia: !refs.length };
  req.url = '/api/generate';
  next();
});

app.post('/api/generate', wrap(async (req, res) => {
  const { topic, angle, pillarId, seriesId, platforms, mediaIds, ctaUrl, autoMedia, quick, reelStyle, tripId, hookId } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  const state = stateStore.get();
  const profile = state.profile;
  const pillar = (profile.pillars || []).find((p) => p.id === pillarId) || null;
  const series = (profile.series || []).find((s) => s.id === seriesId) || null;

  // Trip awareness: 'auto' (default) leans on the active or just-finished
  // trip, a trip id picks that one, 'none' turns it off.
  const trips = tripStore.get().items;
  const today = todayISO();
  const trip = tripId === 'none' ? null
    : tripId && tripId !== 'auto' ? (trips.find((t) => t.id === tripId) || null)
    : pickTrip(trips, today);
  const tripBlock = tripId === 'none' ? '' : tripContextBlock(trips, trip, today);

  const jobId = uid();
  const job = { id: jobId, status: 'running', progress: { done: 0, total: (platforms?.length || 14) + (quick ? 0 : 1) }, package: null, error: null };
  jobs.set(jobId, job);

  (async () => {
    let media = mediaStore.get().items.filter((m) => (mediaIds || []).includes(m.id));
    let mediaSelection = null;
    let mediaFromTrip = 0;
    if (!media.length && autoMedia) {
      job.progress = { platform: 'selecting media from your library', done: 0, total: job.progress.total };
      // Footage shot during the trip window comes first when there is enough of it.
      const all = mediaStore.get().items;
      const fromTrip = mediaInTrip(all, trip);
      const pool = fromTrip.length >= 3 ? fromTrip : all;
      mediaFromTrip = fromTrip.length >= 3 ? fromTrip.length : 0;
      const sel = await selectMedia({ profile, topic, angle, pillar, items: withAlbumContext(pool, currentLibrary()), count: quick ? 3 : 8 });
      media = mediaStore.get().items.filter((m) => sel.ids.includes(m.id));
      mediaSelection = sel;
    }
    const pkg = await generatePackage({
      profile, topic, angle, pillar, series, media, ctaUrl, quick: !!quick, reelStyle: reelStyle === 'music' ? 'music' : null, tripBlock, tripId: trip?.id || null, hookId: hookId || null,
      platformIds: platforms,
      onProgress: (p) => { job.progress = p; },
    });
    if (trip && mediaFromTrip) pkg.tripMedia = mediaFromTrip;
    if (mediaSelection) {
      pkg.mediaSelection = mediaSelection.reasons;
      pkg.mediaSelectionMode = mediaSelection.mode;
      pkg.mediaSelectionError = mediaSelection.error || null;
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
      pillarId: p.pillarId, seriesId: p.seriesId, kind: p.kind || 'package',
      platforms: Object.keys(p.platforms || {}),
      score: p.visibility?.score ?? null, grade: p.visibility?.grade ?? null,
    })),
  });
});

app.get('/api/packages/:id', (req, res) => {
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'not found' });
  // mediaStatus lets the Publish Run page leave out anything held or
  // unscreened: the last gate before a file reaches a platform.
  res.json({ package: pkg, mediaStatus: mediaStatusFor([...(pkg.mediaIds || []), ...((pkg.carouselPlan?.slides || []).map((x) => x.mediaId))]) });
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
      p.platforms[platformId].fields[field] = field === 'transcript' && typeof value === 'string' ? fixNames(value) : value;
      if (p.platforms[platformId].gate) p.platforms[platformId].gate = checkAsset(platformId, p.platforms[platformId].fields, profile, hookContext(p));
      if (p.thumbnails?.[platformId]) { const t = p.thumbnails[platformId]; const probs = thumbsLib.checkBrief(t, { fields: p.platforms[platformId].fields, profile }); p.thumbnails[platformId] = { ...t, problems: probs, status: probs.length ? 'blocked' : 'passed' }; }
      p.contentModifiedAt = new Date().toISOString();
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
  const { platformId, approved, override } = req.body || {};
  if (!platformId) return res.status(400).json({ error: 'platformId required' });
  let pkg = null;
  let refused = null;
  const profile = stateStore.get().profile;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      if (!p.platforms?.[platformId]) return p;
      p.approvals = { ...(p.approvals || {}) };
      // Fail closed: an asset that breaks the voice card or carries an
      // unverified claim cannot be approved without an explicit, logged override.
      const gate = approved ? checkAsset(platformId, p.platforms[platformId].fields, profile, hookContext(p)) : null;
      if (gate) p.platforms[platformId].gate = gate;
      if (gate?.status === 'blocked' && override !== true) { refused = gate; return p; }
      if (approved) p.approvals[platformId] = { approved: true, at: new Date().toISOString(), ...(gate?.status === 'blocked' ? { override: true } : {}) };
      else delete p.approvals[platformId];
      return (pkg = p);
    }),
  }));
  if (refused) return res.status(409).json({ error: 'blocked by the quality gate: fix the cited voice or fact issues, add the fact to the knowledge base, or approve with override', gate: refused });
  if (!pkg) return res.status(404).json({ error: 'unknown package/platform' });
  res.json({ package: pkg });
});

// Knowledge base (Module 5): per-entity claims the gate may let through.
app.get('/api/knowledge', (req, res) => res.json({ entries: getKnowledgeBase(stateStore.get().profile) }));
app.put('/api/knowledge', (req, res) => {
  const entries = (Array.isArray(req.body?.entries) ? req.body.entries : []).slice(0, 500)
    .map((e) => ({ id: String(e.id || uid()), claim: String(e.claim || '').slice(0, 500), status: STATUSES.includes(e.status) ? e.status : 'unverified', source: String(e.source || '').slice(0, 300), date: e.date ? String(e.date).slice(0, 10) : null }))
    .filter((e) => e.claim);
  stateStore.update((s) => ({ ...s, profile: { ...s.profile, knowledgeBase: entries } }));
  res.json({ entries: getKnowledgeBase(stateStore.get().profile) });
});

// Re-run the gate over a package (after knowledge base or copy changes).
app.post('/api/packages/:id/gate', (req, res) => {
  const profile = stateStore.get().profile;
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      for (const [id, a] of Object.entries(p.platforms || {})) a.gate = checkAsset(id, a.fields, profile, hookContext(p));
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  res.json({ package: pkg, gates: Object.fromEntries(Object.entries(pkg.platforms).map(([id, a]) => [id, { status: a.gate.status, voice: a.gate.voice, format: a.gate.format, blocked: a.gate.blocked }])) });
});

// ---- quality modules: voice card, hooks, trends, thumbnails, feedback ------

// Module 1: the voice card for this entity (defaults + the owner's additions).
app.get('/api/voice-card', (req, res) => {
  const profile = stateStore.get().profile;
  res.json({ card: getVoiceCard(profile), own: profile.voiceCard || {}, defaults: DEFAULT_CARD });
});
app.put('/api/voice-card', (req, res) => {
  const b = req.body || {};
  const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 300);
  const patterns = (Array.isArray(b.banned_patterns) ? b.banned_patterns : []).slice(0, 50).map((p, i) => ({ id: String(p.id || `own-${i}`).slice(0, 40), label: String(p.label || p.id || 'custom pattern').slice(0, 120), re: String(p.re || '') }))
    .filter((p) => { try { new RegExp(p.re, 'im'); return !!p.re; } catch { return false; } });
  const voiceCard = { banned_phrases: lines(b.banned_phrases), banned_patterns: patterns, style_targets: typeof b.style_targets === 'object' && b.style_targets ? b.style_targets : {} };
  stateStore.update((s) => ({ ...s, profile: { ...s.profile, voiceCard } }));
  res.json({ card: getVoiceCard(stateStore.get().profile), own: voiceCard, defaults: DEFAULT_CARD });
});

// Module 2: hook library.
app.get('/api/hooks', (req, res) => res.json({ hooks: hooksLib.listHooks({ includeRetired: true }), ranked: hooksLib.rankHooks({ platform: req.query.platform || '*', niche: stateStore.get().profile?.business?.niche || '*' }).map((h) => h.id), patterns: hooksLib.PATTERNS }));
app.post('/api/hooks', (req, res) => {
  try { res.json({ hook: hooksLib.saveHook(req.body || {}) }); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/hooks/:id', (req, res) => {
  if (req.params.id.startsWith('seed-')) return res.status(400).json({ error: 'seed templates cannot be deleted' });
  hooksLib.deleteHook(req.params.id);
  res.json({ ok: true });
});
// Try a fill without generating anything: shows exactly why it would fail.
app.post('/api/hooks/test', (req, res) => {
  const entry = hooksLib.getHook(req.body?.templateId);
  if (!entry) return res.status(404).json({ error: 'unknown template' });
  res.json(hooksLib.fillHook(entry, req.body?.slots || {}, stateStore.get().profile));
});

// Module 3: trend inputs (a weekly trends.json).
app.get('/api/trend-inputs', (req, res) => res.json({ trends: trendInputs.listTrends(), ttlDays: trendInputs.TTL_DAYS }));
app.post('/api/trend-inputs', (req, res) => res.json(trendInputs.importTrends(req.body)));
app.delete('/api/trend-inputs/:id', (req, res) => { trendInputs.deleteTrend(req.params.id); res.json({ trends: trendInputs.listTrends() }); });

// Module 6: (re)build thumbnail briefs for a package's video assets.
app.post('/api/packages/:id/thumbnails', wrap(async (req, res) => {
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const media = (mediaStore.get().items || []).filter((m) => (pkg.mediaIds || []).includes(m.id));
  const work = { ...pkg };
  await attachThumbnails(work, stateStore.get().profile, media);
  let out = null;
  packageStore.update((s) => ({ items: s.items.map((p) => (p.id === pkg.id ? (out = { ...p, thumbnails: work.thumbnails || {} }) : p)) }));
  res.json({ package: out });
}));
app.patch('/api/packages/:id/thumbnails/:platformId', (req, res) => {
  const profile = stateStore.get().profile;
  let out = null;
  packageStore.update((s) => ({ items: s.items.map((p) => {
    if (p.id !== req.params.id || !p.thumbnails?.[req.params.platformId]) return p;
    const t = { ...p.thumbnails[req.params.platformId] };
    if (req.body?.overlay_text !== undefined) t.overlay_text = String(req.body.overlay_text).slice(0, 80);
    if (req.body?.visual_direction !== undefined) t.visual_direction = String(req.body.visual_direction).slice(0, 600);
    const probs = thumbsLib.checkBrief(t, { fields: p.platforms?.[req.params.platformId]?.fields, profile });
    out = { ...p, thumbnails: { ...p.thumbnails, [req.params.platformId]: { ...t, problems: probs, status: probs.length ? 'blocked' : 'passed' } } };
    return out;
  }) }));
  if (!out) return res.status(404).json({ error: 'unknown package or no brief for that platform' });
  res.json({ package: out });
});

// Module 7: performance numbers per asset, the report, and manual runs.
app.post('/api/packages/:id/performance', (req, res) => {
  const { platformId } = req.body || {};
  const metrics = feedbackLib.cleanMetrics(req.body || {});
  let out = null;
  packageStore.update((s) => ({ items: s.items.map((p) => {
    if (p.id !== req.params.id || !p.platforms?.[platformId]) return p;
    out = { ...p, performance: { ...(p.performance || {}), [platformId]: { ...metrics, updatedAt: new Date().toISOString(), source: 'manual' } } };
    return out;
  }) }));
  if (!out) return res.status(404).json({ error: 'unknown package/platform' });
  res.json({ package: out, ignored: Object.keys(req.body || {}).filter((k) => /like/i.test(k)).length ? 'likes are not a metric and were ignored' : undefined });
});
app.get('/api/feedback/report', (req, res) => res.json(feedbackLib.report()));
app.post('/api/feedback/run', (req, res) => {
  const job = ['weekly', 'biweekly', 'monthly', 'quarterly'].includes(req.body?.job) ? req.body.job : null;
  if (!job) return res.status(400).json({ error: 'job must be weekly, biweekly, monthly or quarterly' });
  res.json({ ran: feedbackLib.runDue(Date.now(), job), report: feedbackLib.report() });
});
app.put('/api/feedback/settings', (req, res) => {
  studioStore.update((s) => ({ ...s, settings: { ...(s.settings || {}), feedbackAuto: req.body?.auto !== false } }));
  res.json({ auto: studioStore.get().settings.feedbackAuto });
});

// Closed-loop attribution: post -> lead -> booked call -> signed agreement.
app.get('/api/attribution', (req, res) => {
  const pkgs = packageStore.get().items;
  const attr = feedbackLib.attributeLeads(pkgs, leadStore.get().items || []);
  const rows = [];
  for (const p of pkgs) {
    for (const platformId of Object.keys(p.platforms || {})) {
      const a = attr[p.id]?.[platformId];
      const clicks = p.bookingClicks?.[platformId] || 0;
      if (!a && !clicks && !p.publishedUrls?.[platformId]) continue;
      rows.push({ pkgId: p.id, topic: p.topic, platformId, publishedUrl: p.publishedUrls?.[platformId] || null, bookingClicks: clicks, leads: a?.leads || 0, booked: a?.booked || 0, signed: a?.signed || 0, metrics: p.performance?.[platformId] || null });
    }
  }
  res.json({ rows: rows.sort((x, y) => y.signed - x.signed || y.booked - x.booked || y.leads - x.leads), bookingUrl: stateStore.get().profile?.business?.bookingUrl || '' });
});

// Book-a-brief-call path. Public, tracked redirects to the owner's calendar
// link (profile.business.bookingUrl): /book/<lead token> from emails, and
// /book/c/<capture id>?p=<package>&s=<platform> from content CTAs.
const bookingTarget = (wsId, extra) => {
  const url = readWorkspace(wsId)?.state?.profile?.business?.bookingUrl;
  if (!url) return null;
  try { const u = new URL(url); for (const [k, v] of Object.entries(extra)) if (v) u.searchParams.set(k, v); return u.toString(); } catch { return null; }
};
app.get('/book/c/:captureId', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  const wsId = findWorkspaceByCaptureId(req.params.captureId);
  const pkgId = String(req.query.p || '').slice(0, 40);
  const platformId = String(req.query.s || '').slice(0, 40);
  const target = wsId && bookingTarget(wsId, { utm_source: platformId, utm_medium: 'organic', utm_content: pkgId });
  if (!target) return res.status(404).type('text').send('This booking link is not active.');
  runWithWorkspace(wsId, () => {
    packageStore.update((s) => ({ items: s.items.map((p) => (p.id === pkgId && p.platforms?.[platformId] ? { ...p, bookingClicks: { ...(p.bookingClicks || {}), [platformId]: ((p.bookingClicks || {})[platformId] || 0) + 1 } } : p)) }));
  });
  res.redirect(302, target);
});
app.get('/book/:token', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  const found = findLeadByToken(req.params.token);
  const target = found && bookingTarget(found.wsId, { utm_source: 'email', utm_medium: 'email', utm_content: found.lead.source?.utm_content || '' });
  if (!target) return res.status(404).type('text').send('This booking link is not active.');
  runWithWorkspace(found.wsId, () => record(found.lead.id, { bookingClicks: (found.lead.bookingClicks || 0) + 1, lastBookingClickAt: new Date().toISOString() }));
  res.redirect(302, target);
});

// Reviews: request automation (off by default) and velocity.
app.get('/api/reviews', (req, res) => {
  const st = reviewsLib.reviewState();
  const leads = leadStore.get().items || [];
  res.json({ ...st, velocity: reviewsLib.velocity(st.counts), eligible: reviewsLib.eligible(leads, st).map((l) => ({ id: l.id, name: `${l.firstName || ''} ${l.lastName || ''}`.trim(), email: l.email, wonAt: l.wonAt || null })), requested: leads.filter((l) => l.reviewRequest).length });
});
app.put('/api/reviews/settings', (req, res) => res.json(reviewsLib.saveReviewSettings(req.body || {})));
app.post('/api/reviews/counts', (req, res) => {
  try { res.json(reviewsLib.recordCount(req.body || {})); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/reviews/send', wrap(async (req, res) => {
  const biz = stateStore.get().profile?.business || {};
  const out = await reviewsLib.runReviewRequests({ brand: biz.name || '', person: biz.person?.name || '', base: publicBase(req), force: true });
  res.json(out);
}));

// Entity consistency monitoring.
app.get('/api/entity-check', (req, res) => res.json({ ...entityLib.entityState(), expected: entityLib.expectedEntity(stateStore.get().profile), targets: entityLib.targets(stateStore.get().profile, entityLib.entityState().urls) }));
app.put('/api/entity-check/settings', (req, res) => res.json(entityLib.saveEntitySettings(req.body || {})));
app.post('/api/entity-check/run', wrap(async (req, res) => res.json(await entityLib.runEntityCheck(stateStore.get().profile))));

// Anti-flag publishing protocol: per-asset suggested times, variance checks
// and the posting exceptions for this funnel.
app.get('/api/packages/:id/publish-plan', (req, res) => {
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const profile = stateStore.get().profile;
  const all = packageStore.get().items;
  const history = [];
  const recent = [];
  for (const p of all) {
    for (const [pid, at] of Object.entries(p.publishedAt || {})) history.push({ platformId: pid, at });
    if (p.id !== pkg.id) for (const pid of Object.keys(p.publishedUrls || {})) recent.push({ pkgId: p.id, platformId: pid, fields: p.platforms?.[pid]?.fields || {}, at: p.publishedAt?.[pid] || p.createdAt });
  }
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const approved = Object.keys(pkg.platforms || {}).filter((id) => pkg.approvals?.[id]?.approved && !pkg.publishedUrls?.[id]);
  const plan = pacing.schedule(approved, { seed: pkg.id, history, tz: profile?.publishing?.timezone || 'America/Chicago' });
  const allowed = pacing.allowedPlatforms(profile);
  res.json({
    assets: plan.map((x) => ({ ...x, automationAllowed: allowed.includes(x.platformId), variance: pacing.varianceIssue(x.platformId, pkg.platforms[x.platformId]?.fields, recent) })),
    allowed, instruction: pacing.instructionFor(allowed),
  });
});
app.put('/api/publishing/automation', (req, res) => {
  const { platformId, allowed, volumeJustified, note } = req.body || {};
  if (!platformId) return res.status(400).json({ error: 'platformId required' });
  const wsId = listWorkspaces().activeId;
  if (allowed) {
    const others = listWorkspaces().items.map((w) => ({ id: w.id, name: w.name, profile: readWorkspace(w.id)?.state?.profile }));
    const verdict = pacing.canGrant(wsId, others, { volumeJustified: volumeJustified === true });
    if (!verdict.ok) return res.status(409).json({ error: verdict.reason });
  }
  stateStore.update((s) => {
    const pub = { ...(s.profile.publishing || {}) };
    const auto = { ...(pub.automation || {}) };
    if (allowed) auto[platformId] = { allowed: true, grantedAt: new Date().toISOString(), note: String(note || '').slice(0, 200) };
    else delete auto[platformId];
    return { ...s, profile: { ...s.profile, publishing: { ...pub, automation: auto } } };
  });
  res.json({ allowed: pacing.allowedPlatforms(stateStore.get().profile) });
});

// Interactive lead magnets (quiz and calculator).
app.get('/api/magnets', (req, res) => res.json({ magnets: magnetsLib.listMagnets() }));
app.post('/api/magnets/draft', wrap(async (req, res) => {
  const { kind, topic, audience } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic required' });
  if (!providerStatus().anthropic) return res.status(409).json({ error: 'drafting a lead magnet needs the Claude key' });
  const profile = stateStore.get().profile;
  const { masterContext } = await import('./lib/engine.js');
  const m = await magnetsLib.draftMagnet({
    profile, kind: kind === 'calculator' ? 'calculator' : 'quiz', topic: String(topic).slice(0, 200), audience: String(audience || '').slice(0, 200),
    ask: (prompt) => claudeJson({ system: masterContext(profile), usageBucket: 'generate', maxTokens: 4000, messages: [{ role: 'user', content: prompt }] }),
  });
  res.json({ magnet: m });
}));
app.put('/api/magnets/:slug', (req, res) => {
  if (!magnetsLib.getMagnet(req.params.slug)) return res.status(404).json({ error: 'unknown magnet' });
  res.json({ magnet: magnetsLib.saveMagnet(req.body || {}, stateStore.get().profile, { slug: req.params.slug }) });
});
app.post('/api/magnets/:slug/approve', (req, res) => {
  try { res.json({ magnet: magnetsLib.approveMagnet(req.params.slug, stateStore.get().profile, { approved: req.body?.approved !== false, override: req.body?.override === true }) }); } catch (err) { res.status(err.status || 400).json({ error: err.message, problems: err.problems }); }
});
app.delete('/api/magnets/:slug', (req, res) => { magnetsLib.deleteMagnet(req.params.slug); res.json({ ok: true }); });
app.post('/api/magnets/:slug/try', (req, res) => {
  const m = magnetsLib.getMagnet(req.params.slug);
  if (!m) return res.status(404).json({ error: 'unknown magnet' });
  try { res.json(magnetsLib.sanitizeSubmission(m, req.body || {})); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/magnets/:slug/embed', (req, res) => {
  const m = magnetsLib.getMagnet(req.params.slug);
  if (!m) return res.status(404).json({ error: 'unknown magnet' });
  if (m.status !== 'approved') return res.status(409).json({ error: 'approve the magnet first' });
  const d = leadStore.get();
  let captureId = d.settings?.captureId;
  if (!captureId) { captureId = newLeadKey().slice(0, 20); leadStore.set({ ...d, settings: { ...(d.settings || {}), captureId } }); }
  const manifest = loadManifest(listWorkspaces().activeId) || {};
  const site = stateStore.get().profile?.business?.links?.website || '';
  res.json({ html: magnetsLib.embedHtml(m, { endpoint: `${publicBase(req)}/api/leads/capture`, captureId, accent: manifest.accent || '#00566b' }), site, note: site ? `Paste this into a page on ${site}. Sign-ups are accepted only from that site.` : 'Add your website to the profile first: sign-ups are accepted only from your own site.' });
});

// Meta metrics by API (saves, shares, follows).
app.get('/api/meta', (req, res) => res.json(metaLib.metaStatus()));
app.put('/api/meta/connect', (req, res) => res.json(metaLib.saveMetaAuth(req.body || {})));
app.delete('/api/meta', (req, res) => res.json(metaLib.disconnectMeta()));
app.post('/api/meta/sync', wrap(async (req, res) => {
  try { res.json(await metaLib.syncMeta()); } catch (err) { res.status(409).json({ error: err.message }); }
}));

// Published-URL registry: where each asset actually went live. Feeds
// llms.txt canonical URLs, JSON-LD url/sameAs/SeekToAction, and the
// cross_surface check (which counts live URLs, not drafts).
app.post('/api/packages/:id/published', async (req, res) => {
  const { platformId, url } = req.body || {};
  if (!platformId) return res.status(400).json({ error: 'platformId required' });
  // A pasted YouTube link in any common shape (youtu.be, watch?v=, Studio)
  // becomes the one canonical Shorts URL, so the registry never holds two
  // spellings of the same video.
  const u = shortsLib.normalizeYouTubeUrl(url, platformId);
  if (u && !/^https?:\/\/\S+$/i.test(u)) return res.status(400).json({ error: 'the URL must start with http(s)://' });
  const profile = stateStore.get().profile;
  let pkg = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      p.publishedUrls = { ...(p.publishedUrls || {}) };
      p.publishedAt = { ...(p.publishedAt || {}) };
      if (u) { p.publishedUrls[platformId] = u; p.publishedAt[platformId] = p.publishedAt[platformId] || new Date().toISOString(); }
      else { delete p.publishedUrls[platformId]; delete p.publishedAt[platformId]; }
      p.jsonld = buildJsonLd(p, profile);
      p.visibility = scorePackage(p, profile);
      return (pkg = p);
    }),
  }));
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  // Crawler-view audit: what does a plain, non-JavaScript bot see at this
  // URL? Never blocks registration; the audit is stored beside the URL.
  let audit = null;
  if (u) audit = await auditUrl(u);
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== req.params.id) return p;
      const rest = { ...(p.crawlerAudit || {}) };
      if (audit) rest[platformId] = audit;
      else delete rest[platformId];
      return { ...p, crawlerAudit: rest };
    }),
  }));
  pkg = packageStore.get().items.find((p) => p.id === req.params.id) || pkg;
  // A page that renders correctly for bots is worth announcing: submit it
  // to IndexNow (Bing and other participants) once the site serves our key
  // file. Skipped quietly until the Site setup kit has been used.
  let indexNow = null;
  const nowKey = profile.business?.indexNowKey;
  if (u && audit?.passed && nowKey) {
    indexNow = await submitIndexNow(u, nowKey);
    packageStore.update((s) => ({
      items: s.items.map((p) => (p.id === req.params.id ? { ...p, indexNow: { ...(p.indexNow || {}), [platformId]: indexNow } } : p)),
    }));
    pkg = packageStore.get().items.find((p) => p.id === req.params.id) || pkg;
  }
  // A Short that came through the import flow can be checked against what
  // YouTube actually published (the live title against the planned one).
  let verification = null;
  if (u && platformId === 'youtube_shorts' && pkg.kind === 'short') {
    verification = await shortsLib.verifyLive(pkg.id).catch(() => null);
    packageStore.update((s) => ({
      items: s.items.map((p) => {
        if (p.id !== pkg.id) return p;
        p.jsonld = buildJsonLd(p, profile);
        return p;
      }),
    }));
    pkg = packageStore.get().items.find((p) => p.id === req.params.id) || pkg;
  }
  res.json({ package: pkg, audit, indexNow, verification });
});

// Re-run the crawler-view audit on an already registered URL (after a site
// fix, for example) without touching the registry.
app.post('/api/packages/:id/audit', async (req, res) => {
  const { platformId } = req.body || {};
  const pkg0 = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg0) return res.status(404).json({ error: 'unknown package' });
  const url = pkg0.publishedUrls?.[platformId];
  if (!url) return res.status(400).json({ error: 'register a published URL for that platform first' });
  const audit = await auditUrl(url);
  packageStore.update((s) => ({
    items: s.items.map((p) => (p.id === req.params.id ? { ...p, crawlerAudit: { ...(p.crawlerAudit || {}), [platformId]: audit } } : p)),
  }));
  res.json({ audit });
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
      p.contentModifiedAt = new Date().toISOString();
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
  const doomed = packageStore.get().items.find((p) => p.id === req.params.id);
  if (doomed?.kind === 'short' && doomed.short?.renderId && doomed.short.status !== 'processing') {
    shortsLib.removeShortFiles(doomed.short.renderId);
  }
  packageStore.update((s) => ({ items: s.items.filter((p) => p.id !== req.params.id) }));
  res.json({ ok: true });
});

// ---- auto-produce (finished video rendering) -----------------------------

app.post('/api/render', wrap(async (req, res) => {
  const { packageId, platformId, voiceId, orientation, avatar, delivery, resolution, music } = req.body;
  const pkg = packageStore.get().items.find((p) => p.id === packageId);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const fields = pkg.platforms?.[platformId]?.fields;
  if (!fields) return res.status(400).json({ error: 'that platform is not in this package' });
  const script = fields.script || fields.body || fields.post || '';
  const hookText = fields.hook || fields.hook_script || '';
  // Music-led render: the on-screen text beats (one per line) are burned
  // in over a silent cut of the requested length.
  let musicOpts = null;
  if (music) {
    const raw = fields.overlay_text || fields.on_image_text || hookText;
    const texts = String(Array.isArray(raw) ? raw.join('\n') : raw)
      .split('\n').map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[-*]\s*|text(?:\s*overlay)?\s*[:\-]\s*)/i, '').trim()).filter(Boolean);
    // The hook field is beat one (so picking another hook option updates the
    // video); the generated overlay text repeats the hook on its first line.
    const hookLine = String(fields.hook || '').trim();
    if (hookLine && hookLine.split(/\s+/).length <= 14) texts.splice(0, texts.length ? 1 : 0, hookLine);
    texts.length = Math.min(texts.length, 12);
    if (!texts.length) return res.status(400).json({ error: 'this reel has no on-screen text beats to burn in. Fill the On-screen text field first' });
    musicOpts = { seconds: Math.min(60, Math.max(8, Math.round(Number(music.seconds) || 30))), texts };
  }
  const renderId = startRender({
    pkg, profile: stateStore.get().profile, platformId, script, hookText, voiceId: voiceId || null,
    orientation: orientation || (platformId === 'youtube_long' ? 'landscape' : 'portrait'),
    avatar: avatar || null,
    delivery: delivery || null,
    resolution: resolution === '4k' ? '4k' : 'hd',
    music: musicOpts,
  });
  res.json({ renderId });
}));

// Static path before '/api/render/:id'. What this server can render: 4K needs
// memory, so the UI offers it only where it is safe.
app.get('/api/render/capabilities', (req, res) => res.json(renderCapabilities()));

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

// Captions pass through the name corrections on the way out, so a file
// written before a correction existed still downloads right; no long cache,
// because the corrected text can differ from what a browser already holds.
app.get('/api/render/:id/srt', (req, res) => {
  const file = renderFile(req.params.id, 'srt');
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'no-cache').type('text/plain').send(fixSrt(fs.readFileSync(file, 'utf8')));
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

// Add platform assets to an existing package (job-based: several platforms
// take a while). Existing assets, approvals, published URLs, and hand edits
// are never touched.
app.post('/api/packages/:id/platforms', wrap(async (req, res) => {
  const pkg = packageStore.get().items.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown package' });
  const wanted = Array.isArray(req.body?.platforms) ? req.body.platforms : [];
  if (!wanted.length) return res.status(400).json({ error: 'platforms[] required' });
  const state = stateStore.get();
  const media = (mediaStore.get().items || []).filter((m) => (pkg.mediaIds || []).includes(m.id));

  const jobId = uid();
  const job = { id: jobId, status: 'running', progress: { done: 0, total: wanted.length }, packageId: pkg.id, error: null };
  jobs.set(jobId, job);

  (async () => {
    const added = await generatePlatforms({
      profile: state.profile, pkg, platformIds: wanted, media,
      tripBlock: (() => { const ts = tripStore.get().items; const t = ts.find((x) => x.id === pkg.tripId); return t ? tripContextBlock(ts, t) : ''; })(),
      onProgress: (p) => { job.progress = p; },
    });
    packageStore.update((s) => ({
      items: s.items.map((p) => {
        if (p.id !== pkg.id) return p;
        p.platforms = { ...(p.platforms || {}), ...added };
        if (p.ctaUrl) {
          p.links = { ...(p.links || {}) };
          for (const id of Object.keys(added)) {
            if (!p.links[id]) p.links[id] = trackedLink(p.ctaUrl, id, p.topic, p.id);
          }
        }
        p.jsonld = buildJsonLd(p, state.profile);
        p.visibility = scorePackage(p, state.profile);
        job.package = p;
        return p;
      }),
    }));
    // New video assets need their thumbnail briefs (Module 6).
    const merged = packageStore.get().items.find((x) => x.id === pkg.id);
    if (merged && Object.keys(added).some(thumbsLib.isVideoPlatform)) {
      await attachThumbnails(merged, state.profile, media);
      packageStore.update((s) => ({ items: s.items.map((x) => (x.id === merged.id ? { ...x, thumbnails: merged.thumbnails } : x)) }));
      job.package = { ...job.package, thumbnails: merged.thumbnails };
    }
    packageStore.update((s) => ({
      items: s.items.map((p) => {
        return p;
      }),
    }));
    job.added = Object.keys(added);
    job.status = 'done';
  })().catch((err) => {
    job.status = 'error';
    job.error = String(err.message).slice(0, 300);
  });

  res.json({ jobId });
}));

// Same tracked-link shape generation uses, so a platform added later gets
// the identical utm treatment as one written at generation time.
function trackedLinkFor(base, platformId, topic) {
  try {
    const url = new URL(base);
    url.searchParams.set('utm_source', platformId);
    url.searchParams.set('utm_medium', 'organic');
    url.searchParams.set('utm_campaign', String(topic).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50));
    return url.toString();
  } catch {
    return base;
  }
}

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
  let selectionError = null;
  if (!ids.length) {
    const pillar = (state.profile.pillars || []).find((p) => p.id === pkg.pillarId) || null;
    const sel = await selectMedia({
      profile: state.profile, topic: pkg.topic, angle: pkg.angle, pillar, items: withAlbumContext(items, currentLibrary()),
      count: Math.min(12, Math.max(1, Number(req.body?.count) || 8)),
    });
    ids = sel.ids;
    reasons = sel.reasons;
    mode = sel.mode;
    selectionError = sel.error || null;
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
      p.mediaSelectionError = selectionError;
      p.altTexts = { ...(p.altTexts || {}) };
      p.mediaKinds = {};
      for (const id of ids) {
        const m = items.find((x) => x.id === id);
        const alt = clamp(m?.alt || m?.caption || m?.name);
        if (alt) p.altTexts[id] = alt;
        if (m?.kind) p.mediaKinds[id] = m.kind;
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
  const { slides, mode, error } = await matchCarouselSlides({ profile, pkg, items: withAlbumContext(mediaStore.get().items, currentLibrary()) });
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

// ---- reel to YouTube Short (import a finished reel, optimize, post) -------

const shortPkg = (id) => packageStore.get().items.find((p) => p.id === id && p.kind === 'short') || null;
const originOf = (req) => `${String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0]}://${req.get('host')}`;

// Published pages from this brand a Short can point at (the long-form video,
// the article, the site page): the link graph that ties a Short to the
// content it supports.
app.get('/api/shorts/related', (req, res) => {
  res.json({ items: shortsLib.relatedContent(String(req.query.pkg || '')) });
});

app.post('/api/shorts', (req, res) => {
  const { name, size, topic } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (Number(size) > shortsLib.MAX_SOURCE_BYTES) return res.status(413).json({ error: 'the video is larger than the 500MB limit' });
  const pkg = shortsLib.createShortDraft({ name, size, topic, profile: stateStore.get().profile });
  res.json({ package: pkg });
});

// Streamed straight to disk (never buffered), same approach as library originals.
app.post('/api/shorts/:id/source', (req, res) => {
  const pkg = shortPkg(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown import' });
  if (pkg.short.status === 'processing') return res.status(409).json({ error: 'this import is being processed right now' });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > shortsLib.MAX_SOURCE_BYTES) return res.status(413).json({ error: 'the video is larger than the 500MB limit' });
  const free = diskFree();
  if (free && free.freeBytes < Math.max(1536 * 1024 * 1024, declared * 2 + 256 * 1024 * 1024)) {
    return res.status(507).json({ error: 'the data disk is nearly full. Run storage cleanup before importing' });
  }
  const paths = shortsLib.shortPaths(pkg.short.renderId);
  const out = fs.createWriteStream(paths.sourcePart);
  const hash = crypto.createHash('sha256');
  let received = 0;
  let failed = false;
  const abort = (code, message) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(paths.sourcePart, { force: true }, () => {});
    req.destroy();
    if (!res.headersSent) res.status(code).json({ error: message });
  };
  req.on('data', (chunk) => {
    received += chunk.length;
    hash.update(chunk);
    if (received > shortsLib.MAX_SOURCE_BYTES) abort(413, 'the video is larger than the 500MB limit');
  });
  req.on('error', () => abort(400, 'upload interrupted'));
  out.on('error', () => abort(500, 'could not write the video to disk'));
  out.on('finish', () => {
    if (failed) return;
    fs.rename(paths.sourcePart, paths.source, (err) => {
      if (err) return abort(500, 'could not store the video');
      res.json({ package: shortsLib.markUploaded(pkg.id, received, hash.digest('hex')) });
    });
  });
  req.pipe(out);
});

// mode: full (first run) | reencode (new master, keep the copy) | rewrite
// (new copy and cover from the existing master).
app.post('/api/shorts/:id/process', (req, res) => {
  const pkg = shortPkg(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown import' });
  const b = req.body || {};
  const mode = ['full', 'reencode', 'rewrite'].includes(b.mode) ? b.mode : 'full';
  const o = b.opts || {};
  const opts = {
    audio: o.audio === 'mute' ? 'mute' : 'keep',
    normalize: o.normalize !== false,
    fit: o.fit === 'crop' ? 'crop' : 'blur',
    transcribe: o.transcribe !== false,
    keepSource: !!o.keepSource,
    hosted: !!o.hosted,
    hostedBy: String(o.hostedBy || '').trim().slice(0, 80),
    commission: !!o.commission,
    scheduleAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(o.scheduleAt || '') ? o.scheduleAt : null,
    aiContent: !!o.aiContent,
    caption: String(o.caption || '').slice(0, 4000),
    notes: String(o.notes || '').slice(0, 2000),
    tripId: o.tripId && o.tripId !== 'none' ? String(o.tripId) : 'none',
    filmedOn: /^\d{4}-\d{2}-\d{2}$/.test(o.filmedOn || '') ? o.filmedOn : null,
    related: /^https?:\/\//.test(o.related?.url || '') ? { url: String(o.related.url), label: String(o.related.label || '').slice(0, 90) } : null,
    ctaUrl: /^https?:\/\//.test(o.ctaUrl || '') ? String(o.ctaUrl) : null,
    language: /^[a-z]{2,3}$/.test(o.language || '') ? o.language : 'en',
  };
  if (mode !== 'full') {
    // Follow-up runs only change what was named; everything else carries over.
    const prev = pkg.short.opts || {};
    for (const k of Object.keys(opts)) if (!(k in o)) opts[k] = prev[k] ?? opts[k];
  }
  try {
    shortsLib.startShortProcess(pkg.id, opts, mode);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  res.json({ ok: true });
});

app.get('/api/shorts/:id/status', (req, res) => {
  const short = shortsLib.shortStatus(req.params.id);
  if (!short) return res.status(404).json({ error: 'unknown import' });
  res.json({ short });
});

app.post('/api/shorts/:id/cover', wrap(async (req, res) => {
  if (!shortPkg(req.params.id)) return res.status(404).json({ error: 'unknown import' });
  const pkg = await shortsLib.remakeCover(req.params.id, { n: req.body?.n, text: req.body?.text });
  const profile = stateStore.get().profile;
  packageStore.update((s) => ({ items: s.items.map((p) => {
    if (p.id !== pkg.id) return p;
    p.jsonld = buildJsonLd(p, profile);
    p.visibility = scorePackage(p, profile);
    return p;
  }) }));
  res.json({ package: shortPkg(req.params.id) });
}));

app.get('/api/shorts/:id/cover', (req, res) => {
  const pkg = shortPkg(req.params.id);
  if (!pkg?.short?.renderId) return res.status(404).end();
  const file = shortsLib.shortPaths(pkg.short.renderId).cover;
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Disposition', `attachment; filename="${shortsLib.downloadNames(pkg).cover}"`);
  res.type('image/jpeg').sendFile(file);
});

app.post('/api/shorts/:id/source/delete', (req, res) => {
  if (!shortPkg(req.params.id)) return res.status(404).json({ error: 'unknown import' });
  res.json({ freedBytes: shortsLib.deleteSource(req.params.id) });
});

// The prompt only exists once the creator has approved the copy, the same
// human gate the Publish Run page enforces.
app.get('/api/shorts/:id/prompt', (req, res) => {
  const pkg = shortPkg(req.params.id);
  if (!pkg?.platforms?.youtube_shorts) return res.status(404).json({ error: 'unknown import' });
  if (!pkg.approvals?.youtube_shorts?.approved) return res.status(409).json({ error: 'approve the copy first' });
  if (!pkg.short?.consent?.faces) return res.status(409).json({ error: 'confirm the consent checklist first' });
  res.json({
    prompt: shortsLib.buildPostingPrompt({ pkg, profile: stateStore.get().profile, origin: originOf(req), workspaceId: listWorkspaces().activeId }),
    files: shortsLib.downloadNames(pkg),
  });
});

app.post('/api/shorts/:id/consent', (req, res) => {
  if (!shortPkg(req.params.id)) return res.status(404).json({ error: 'unknown import' });
  try { res.json({ package: shortsLib.setConsent(req.params.id, req.body || {}) }); } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/shorts/:id/translate', wrap(async (req, res) => {
  if (!shortPkg(req.params.id)) return res.status(404).json({ error: 'unknown import' });
  try { res.json({ package: await shortsLib.translateCaptions(req.params.id, req.body?.languages) }); } catch (err) { res.status(409).json({ error: err.message }); }
}));

app.get('/api/shorts/:id/captions/:lang', (req, res) => {
  const pkg = shortPkg(req.params.id);
  const file = shortsLib.captionFile(pkg, req.params.lang);
  if (!file) return res.status(404).end();
  res.set('Content-Disposition', `attachment; filename="${shortsLib.downloadNames(pkg).translations[req.params.lang]}"`);
  res.set('Cache-Control', 'no-cache').type('text/plain').send(fixSrt(fs.readFileSync(file, 'utf8')));
});

app.post('/api/shorts/:id/replies', wrap(async (req, res) => {
  if (!shortPkg(req.params.id)) return res.status(404).json({ error: 'unknown import' });
  try { res.json({ replies: await shortsLib.draftReplies(req.params.id, req.body?.comments) }); } catch (err) { res.status(409).json({ error: err.message }); }
}));

app.get('/api/shorts/:id/embed-kit', (req, res) => {
  const pkg = shortPkg(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'unknown import' });
  try {
    res.json(shortsLib.buildEmbedKit({ pkg, profile: stateStore.get().profile }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post('/api/shorts/:id/verify', wrap(async (req, res) => {
  if (!shortPkg(req.params.id)) return res.status(404).json({ error: 'unknown import' });
  try {
    res.json({ verification: await shortsLib.verifyLive(req.params.id) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}));

// ---- measurement loop: YouTube connection, results, insights ---------------

app.get('/api/youtube/status', (req, res) => {
  res.json({
    config: gLib.googleConfig(), connected: gLib.isConnected(), channel: gLib.connectedChannel(),
    redirectUri: gLib.redirectUri(originOf(req)),
  });
});

// Each business connects its own channel. The state value carries the
// workspace through Google's consent page and back.
app.get('/api/youtube/connect', (req, res) => {
  try {
    res.redirect(gLib.startConnect({ workspaceId: listWorkspaces().activeId, base: originOf(req) }));
  } catch (err) {
    res.status(400).type('text/plain').send(err.message);
  }
});

app.get('/api/youtube/callback', wrap(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/#/shorts?yt=${encodeURIComponent(`Google said: ${String(error).slice(0, 80)}`)}`);
  const ws = gLib.takeState(String(state || ''));
  if (!ws || !code) return res.status(400).type('text/plain').send('That connection link expired. Go back and press Connect YouTube again.');
  try {
    const channel = await runWithWorkspace(ws, () => gLib.finishConnect({ code: String(code), base: originOf(req) }));
    res.redirect(`/#/shorts?yt=${encodeURIComponent(`Connected: ${channel.title}`)}`);
  } catch (err) {
    res.redirect(`/#/shorts?yt=${encodeURIComponent(String(err.message).slice(0, 160))}`);
  }
}));

app.post('/api/youtube/disconnect', (req, res) => { gLib.disconnect(); res.json({ ok: true }); });

app.get('/api/youtube/channel-audit', wrap(async (req, res) => {
  if (!gLib.isConnected()) return res.status(409).json({ error: 'connect YouTube first' });
  res.json(await measureLib.channelAudit(stateStore.get().profile));
}));

app.get('/api/measure/overview', (req, res) => res.json(measureLib.overview()));

app.post('/api/measure/insights', wrap(async (req, res) => {
  try { res.json({ insights: await measureLib.generateInsights() }); } catch (err) { res.status(409).json({ error: err.message }); }
}));

app.post('/api/packages/:id/results/check', wrap(async (req, res) => {
  try {
    const snapshot = await measureLib.takeSnapshot(req.params.id);
    res.json({ snapshot, package: packageStore.get().items.find((p) => p.id === req.params.id) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}));

app.post('/api/packages/:id/results/manual', (req, res) => {
  try {
    const manual = measureLib.saveManual(req.params.id, req.body || {});
    res.json({ manual, package: packageStore.get().items.find((p) => p.id === req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- editor: edit lists, templates, trend watch --------------------------------

// Streams a request body to disk (never buffered) with a size cap.
function streamToFile(req, res, dest, maxBytes, onDone) {
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(part);
  let received = 0;
  let failed = false;
  const abort = (code, message) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(part, { force: true }, () => {});
    req.destroy();
    if (!res.headersSent) res.status(code).json({ error: message });
  };
  if (Number(req.headers['content-length'] || 0) > maxBytes) return abort(413, `the file is larger than the ${Math.round(maxBytes / 1e6)}MB limit`);
  req.on('data', (c) => { received += c.length; if (received > maxBytes) abort(413, `the file is larger than the ${Math.round(maxBytes / 1e6)}MB limit`); });
  req.on('error', () => abort(400, 'upload interrupted'));
  out.on('error', () => abort(500, 'could not write the file to disk'));
  out.on('finish', () => {
    if (failed) return;
    fs.rename(part, dest, (err) => (err ? abort(500, 'could not store the file') : Promise.resolve(onDone(received)).catch((e) => { fs.rm(dest, { force: true }, () => {}); if (!res.headersSent) res.status(400).json({ error: e.message }); })));
  });
  req.pipe(out);
}

app.get('/api/edits', (req, res) => res.json({ items: editLib.listEdits() }));

app.post('/api/edits', (req, res) => res.json({ edit: editLib.createEdit({ title: req.body?.title, brief: req.body?.brief }) }));

app.get('/api/edits/:id', (req, res) => {
  const e = editLib.editStatus(req.params.id);
  if (!e) return res.status(404).json({ error: 'unknown edit' });
  res.json({ edit: e });
});

app.put('/api/edits/:id', wrap(async (req, res) => {
  if (!editLib.getEdit(req.params.id)) return res.status(404).json({ error: 'unknown edit' });
  try { res.json({ edit: await editLib.saveEdl(req.params.id, req.body?.edl, req.body?.title) }); } catch (err) { res.status(400).json({ error: err.message }); }
}));

app.delete('/api/edits/:id', (req, res) => {
  try { res.json({ ok: editLib.deleteEdit(req.params.id) }); } catch (err) { res.status(409).json({ error: err.message }); }
});

app.post('/api/edits/:id/plan', wrap(async (req, res) => {
  if (!editLib.getEdit(req.params.id)) return res.status(404).json({ error: 'unknown edit' });
  const template = req.body?.templateId ? trendLib.getTemplate(String(req.body.templateId)) : null;
  try { res.json({ edit: await editLib.applyPlan(req.params.id, req.body?.brief || {}, template) }); } catch (err) { res.status(409).json({ error: err.message }); }
}));

app.post('/api/edits/:id/assets', (req, res) => {
  if (!editLib.getEdit(req.params.id)) return res.status(404).json({ error: 'unknown edit' });
  const aid = uid();
  const name = String(req.query.name || 'upload').slice(0, 120);
  streamToFile(req, res, editLib.assetPath(req.params.id, aid), editLib.MAX_ASSET_BYTES, async (bytes) => {
    const asset = await editLib.registerAsset(req.params.id, aid, name, bytes);
    res.json({ asset, edit: editLib.getEdit(req.params.id) });
  });
});

app.get('/api/edits/:id/asset/:aid', (req, res) => {
  const e = editLib.getEdit(req.params.id);
  const a = e?.assets?.find((x) => x.id === req.params.aid);
  const f = a && editLib.assetPath(e.id, a.id);
  if (!f || !fs.existsSync(f)) return res.status(404).end();
  res.type(a.kind === 'audio' ? 'audio/mpeg' : a.kind === 'image' ? 'image/jpeg' : 'video/mp4').sendFile(f);
});

app.post('/api/edits/:id/beats', wrap(async (req, res) => {
  const e = editLib.getEdit(req.params.id);
  const a = e?.assets?.find((x) => x.id === req.body?.assetId && x.kind !== 'image');
  if (!a) return res.status(404).json({ error: 'pick an uploaded audio or video file' });
  try {
    const info = await editLib.analyzeBeats(editLib.assetPath(e.id, a.id));
    const startAt = Number(e.edl?.audio?.music?.startAt) || 0;
    const beats = info.beats.filter((t) => t >= startAt).map((t) => Math.round((t - startAt) * 1000) / 1000);
    let edit = e;
    if (req.body?.snap && e.edl.clips.length > 1) edit = await editLib.saveEdl(e.id, editLib.snapToBeats(e.edl, beats));
    res.json({ bpm: info.bpm, beats: beats.slice(0, 80), edit });
  } catch (err) { res.status(409).json({ error: err.message }); }
}));

app.post('/api/edits/:id/render', (req, res) => {
  try { editLib.startEditRender(req.params.id); res.json({ ok: true }); } catch (err) { res.status(409).json({ error: err.message }); }
});

app.post('/api/edits/:id/social', wrap(async (req, res) => {
  try { res.json({ edit: await editLib.writeSocialCopy(req.params.id) }); } catch (err) { res.status(409).json({ error: err.message }); }
}));

app.post('/api/edits/:id/to-short', (req, res) => {
  try { res.json({ packageId: editLib.sendToShort(req.params.id) }); } catch (err) { res.status(409).json({ error: err.message }); }
});

app.get('/api/templates', (req, res) => res.json({ items: trendLib.listTemplates() }));

// A reference reel is read for structure and then deleted: the file is never kept.
app.post('/api/templates/analyze', (req, res) => {
  const tmp = path.join(rendersDir(), `tmp-ref-up-${uid()}.mp4`);
  streamToFile(req, res, tmp, 200 * 1024 * 1024, async () => {
    try { res.json({ template: await trendLib.analyzeReference(tmp, String(req.query.name || '').slice(0, 80)) }); } finally { fs.rmSync(tmp, { force: true }); }
  });
});

app.post('/api/templates', wrap(async (req, res) => {
  const { name, notes, structure, id } = req.body || {};
  try {
    if (notes && !structure) return res.json({ template: await trendLib.templateFromNotes(name || 'My pattern', notes) });
    res.json({ template: trendLib.saveTemplate({ id, name, structure, source: 'manual' }) });
  } catch (err) { res.status(409).json({ error: err.message }); }
}));

app.delete('/api/templates/:id', (req, res) => { trendLib.deleteTemplate(req.params.id); res.json({ ok: true }); });

app.get('/api/trends', (req, res) => res.json(trendLib.trendState()));
app.post('/api/trends/refresh', wrap(async (req, res) => {
  try { await trendLib.runTrendWatch(); res.json(trendLib.trendState()); } catch (err) { res.status(409).json({ error: err.message }); }
}));
app.put('/api/trends/settings', (req, res) => res.json(trendLib.saveTrendSettings(req.body || {})));

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
// Transcripts saved before a name correction existed (or before a new
// misspelling was added to config/name-corrections.json) are corrected once
// at boot: the transcript field, the stored cues, and the schema built from
// them. Only the listed names change; a package with no match is untouched.
function fixStoredTranscripts() {
  let fixed = 0;
  for (const w of listWorkspaces().items) {
    try {
      runWithWorkspace(w.id, () => {
        const profile = stateStore.get().profile;
        packageStore.update((s) => ({
          items: s.items.map((p) => {
            const f = p.platforms?.youtube_shorts?.fields;
            const td = p.short?.transcriptData;
            const before = JSON.stringify([f?.transcript, td]);
            if (f && typeof f.transcript === 'string') f.transcript = fixNames(f.transcript);
            if (td) {
              if (typeof td.text === 'string') td.text = fixNames(td.text);
              for (const c of td.cues || []) c.text = fixNames(c.text);
            }
            if (JSON.stringify([f?.transcript, td]) === before) return p;
            fixed++;
            p.jsonld = buildJsonLd(p, profile);
            p.visibility = scorePackage(p, profile);
            return p;
          }),
        }));
      });
    } catch (err) { console.error(`  namefix: workspace ${w.id}: ${err.message}`); }
  }
  if (fixed) console.log(`  namefix: corrected names in ${fixed} stored transcript(s)`);
}
fixStoredTranscripts();
scheduleBackups();
schedulePlan();
measureLib.scheduleMeasure();
feedbackLib.scheduleFeedback();
metaLib.scheduleMeta();

// Review requests (hourly, off per workspace until switched on) and the
// monthly entity-consistency check (off until switched on).
async function sweepReviewsAndEntity() {
  for (const w of listWorkspaces().items) {
    await runWithWorkspace(w.id, async () => {
      const biz = stateStore.get().profile?.business || {};
      const base = process.env.PUBLIC_BASE_URL || leadStore.get().settings?.publicBase;
      if (base) { try { await reviewsLib.runReviewRequests({ brand: biz.name || '', person: biz.person?.name || '', base }); } catch (err) { console.warn(`reviews ${w.id}: ${err.message}`); } }
      const ent = entityLib.entityState();
      if (ent.auto && (!ent.last || Date.now() - Date.parse(ent.last.at) > 30 * 86400000)) {
        try { await entityLib.runEntityCheck(stateStore.get().profile); } catch (err) { console.warn(`entity ${w.id}: ${err.message}`); }
      }
    });
  }
}
if (!process.env.DISABLE_REVIEWS) {
  setTimeout(() => sweepReviewsAndEntity().catch(() => {}), Number(process.env.REVIEWS_FIRST_RUN_MS || 12 * 60 * 1000)).unref?.();
  setInterval(() => sweepReviewsAndEntity().catch(() => {}), 3600 * 1000).unref?.();
}
trendLib.scheduleTrends();

// The photo catalog and albums write on a multi-second debounce (they can be
// large), so flush them when the platform stops the process on a deploy.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { catalog.flush(); albumStore.flush(); stateStore.flush(); packageStore.flush(); } catch { /* best effort */ }
    process.exit(0);
  });
}

const port = Number(process.env.PORT || 4600);
app.listen(port, () => {
  const s = providerStatus();
  console.log(`ContentStudio running → http://localhost:${port} (build ${BUILD})`);
  console.log(`  Claude: ${s.anthropic ? `ready (${s.model})` : 'no key — template mode'} | ElevenLabs: ${s.elevenlabs ? 'ready' : 'no key'} | HeyGen: ${s.heygen ? 'ready' : 'no key'}`);
});
