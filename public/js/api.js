const j = (res) => {
  if (!res.ok) return res.json().catch(() => ({})).then((b) => {
    const err = new Error(b.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  });
  return res.json();
};

const get = (url) => fetch(url).then(j);
// Profile saves return lint warnings (blocklisted words, disparaging
// vocabulary, dashes sitting in the creator's own profile text). api.js
// cannot import ui.js without a cycle, so they travel as a DOM event.
const withWarnings = (promise) => promise.then((r) => {
  if (r?.warnings?.length) window.dispatchEvent(new CustomEvent('cs:profile-warnings', { detail: r.warnings }));
  return r;
});
const send = (method, url, body) =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j);

export const api = {
  health: () => get('/api/health'),
  platforms: () => get('/api/platforms'),
  workspaces: () => get('/api/workspaces'),
  createWorkspace: (name, library) => send('POST', '/api/workspaces', { name, library }),
  activateWorkspace: (id) => send('POST', `/api/workspaces/${id}/activate`, {}),
  setWorkspaceLibrary: (id, library) => send('PATCH', `/api/workspaces/${id}`, { library }),
  renameWorkspace: (id, name) => send('PATCH', `/api/workspaces/${id}`, { name }),
  deleteWorkspace: (id) => send('DELETE', `/api/workspaces/${id}`),
  leads: () => get('/api/leads'),
  trips: () => get('/api/trips'),
  upsertTrips: (trips) => send('POST', '/api/trips/upsert', { trips }),
  updateTrip: (id, body) => send('PUT', `/api/trips/${id}`, body),
  deleteTrip: (id) => send('DELETE', `/api/trips/${id}`),
  parseTripsIcs: (ics) => send('POST', '/api/trips/ics', { ics }),
  leadSetup: () => get('/api/leads/setup'),
  leadSettings: (patch) => send('PUT', '/api/leads/settings', patch),
  leadSequenceTest: (day) => send('POST', '/api/leads/sequence/test', { day }),
  leadUpdate: (id, patch) => send('PATCH', `/api/leads/${id}`, patch),
  leadDelete: (id) => send('DELETE', `/api/leads/${id}`),
  ledger: () => get('/api/ledger'),
  ledgerQuestions: (questions) => send('PUT', '/api/ledger/questions', { questions }),
  ledgerSettings: (patch) => send('PUT', '/api/ledger/settings', patch),
  ledgerSuggest: () => send('POST', '/api/ledger/suggest', {}),
  ledgerRun: () => send('POST', '/api/ledger/run', {}),
  ledgerManual: (entry) => send('POST', '/api/ledger/manual', entry),
  ledgerDeleteRun: (id) => send('DELETE', `/api/ledger/runs/${id}`),
  state: () => get('/api/state'),
  saveState: (state) => withWarnings(send('PUT', '/api/state', state)),
  patchState: (path, value) => withWarnings(send('PATCH', '/api/state', { path, value })),
  loadDemo: () => send('POST', '/api/demo', {}),
  siteSetupKit: () => get('/api/site-setup-kit'),

  interviewBrief: (answers) => send('POST', '/api/interview/brief', { answers }),
  voiceDna: (files) => send('POST', '/api/voice-dna', { files }),
  removeVoiceSource: (name) => send('POST', '/api/voice-dna/remove', { name }),

  media: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)]));
    return get(`/api/media${q.toString() ? `?${q}` : ''}`);
  },
  matchMedia: (files) => send('POST', '/api/media/match', { files }),
  migrationStatus: () => get('/api/media/migrate'),
  startMigration: () => send('POST', '/api/media/migrate', {}),
  mediaAnalysis: () => get('/api/media/analysis'),
  startAnalysis: (body = {}) => send('POST', '/api/media/analysis', body),
  moderation: () => get('/api/moderation'),
  approveRelease: (id) => send('POST', `/api/moderation/${id}/release`, {}),
  revokeRelease: (id) => send('DELETE', `/api/moderation/${id}/release`),
  scanLegacy: (body = {}) => send('POST', '/api/moderation/scan', body),
  albums: () => get('/api/albums'),
  album: (id) => get(`/api/albums/${id}`),
  buildAlbumProfile: (id) => send('POST', `/api/albums/${id}/profile`, {}),
  buildAllProfiles: () => send('POST', '/api/albums/profiles', {}),
  profilesJob: () => get('/api/albums/profiles'),
  addMedia: (item) => send('POST', '/api/media', item),
  uploadMediaOriginal: (id, file) =>
    fetch(`/api/media/${id}/original`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    }).then(j),
  analyzeMedia: (id) => send('POST', `/api/media/${id}/analyze`, {}),
  updateMedia: (id, patch) => send('PATCH', `/api/media/${id}`, patch),
  deleteMedia: (id) => send('DELETE', `/api/media/${id}`),

  suggestPillars: () => send('POST', '/api/pillars/suggest', {}),

  generate: (body) => send('POST', '/api/generate', body),
  job: (id) => get(`/api/generate/${id}`),
  packages: () => get('/api/packages'),
  pkg: (id) => get(`/api/packages/${id}`),
  rescore: (id) => send('POST', `/api/packages/${id}/rescore`, {}),
  editPackageField: (id, platformId, field, value) => send('PATCH', `/api/packages/${id}`, { platformId, field, value }),
  deletePackage: (id) => send('DELETE', `/api/packages/${id}`),

  voices: () => get('/api/voice/voices'),
  cloneVoice: (body) => send('POST', '/api/voice/clone', body),
  tts: (body) =>
    fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((res) => {
        if (!res.ok) return res.json().then((b) => { throw new Error(b.error || 'TTS failed'); });
        return res.blob();
      }),

  addPlatforms: (id, platforms) => send('POST', `/api/packages/${id}/platforms`, { platforms }),
  attachMedia: (id, body = {}) => send('POST', `/api/packages/${id}/media`, body),
  carouselMedia: (id) => send('POST', `/api/packages/${id}/carousel-media`, {}),
  approvePlatform: (id, platformId, approved, override = false) => send('POST', `/api/packages/${id}/approve`, { platformId, approved, override }),
  // Quality modules (voice card, knowledge base, hooks, trends, thumbnails, feedback).
  knowledge: () => get('/api/knowledge'),
  saveKnowledge: (entries) => send('PUT', '/api/knowledge', { entries }),
  voiceCard: () => get('/api/voice-card'),
  saveVoiceCard: (card) => send('PUT', '/api/voice-card', card),
  regate: (id) => send('POST', `/api/packages/${id}/gate`, {}),
  hooks: (platform) => get(`/api/hooks${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`),
  saveHook: (h) => send('POST', '/api/hooks', h),
  deleteHook: (id) => send('DELETE', `/api/hooks/${id}`),
  testHook: (templateId, slots) => send('POST', '/api/hooks/test', { templateId, slots }),
  trendInputs: () => get('/api/trend-inputs'),
  importTrendInputs: (trends) => send('POST', '/api/trend-inputs', trends),
  deleteTrendInput: (id) => send('DELETE', `/api/trend-inputs/${id}`),
  buildThumbnails: (id) => send('POST', `/api/packages/${id}/thumbnails`, {}),
  editThumbnail: (id, platformId, patch) => send('PATCH', `/api/packages/${id}/thumbnails/${platformId}`, patch),
  setPerformance: (id, platformId, metrics) => send('POST', `/api/packages/${id}/performance`, { platformId, ...metrics }),
  feedbackReport: () => get('/api/feedback/report'),
  feedbackRun: (job) => send('POST', '/api/feedback/run', { job }),
  feedbackSettings: (auto) => send('PUT', '/api/feedback/settings', { auto }),
  attribution: () => get('/api/attribution'),
  reviews: () => get('/api/reviews'),
  reviewSettings: (patch) => send('PUT', '/api/reviews/settings', patch),
  reviewCount: (entry) => send('POST', '/api/reviews/counts', entry),
  reviewSend: () => send('POST', '/api/reviews/send', {}),
  entityCheck: () => get('/api/entity-check'),
  entitySettings: (patch) => send('PUT', '/api/entity-check/settings', patch),
  entityRun: () => send('POST', '/api/entity-check/run', {}),
  publishPlan: (id) => get(`/api/packages/${id}/publish-plan`),
  setAutomation: (platformId, allowed, extra = {}) => send('PUT', '/api/publishing/automation', { platformId, allowed, ...extra }),
  formats: (body) => send('POST', '/api/formats', body),
  magnets: () => get('/api/magnets'),
  draftMagnet: (body) => send('POST', '/api/magnets/draft', body),
  saveMagnet: (slug, m) => send('PUT', `/api/magnets/${slug}`, m),
  approveMagnet: (slug, approved, override = false) => send('POST', `/api/magnets/${slug}/approve`, { approved, override }),
  deleteMagnet: (slug) => send('DELETE', `/api/magnets/${slug}`),
  tryMagnet: (slug, body) => send('POST', `/api/magnets/${slug}/try`, body),
  magnetEmbed: (slug) => get(`/api/magnets/${slug}/embed`),
  meta: () => get('/api/meta'),
  metaConnect: (body) => send('PUT', '/api/meta/connect', body),
  metaDisconnect: () => send('DELETE', '/api/meta'),
  metaSync: () => send('POST', '/api/meta/sync', {}),
  setPublishedUrl: (id, platformId, url) => send('POST', `/api/packages/${id}/published`, { platformId, url }),
  reshare: (id, body) => send('POST', `/api/packages/${id}/reshare`, body),
  regenCitations: (id) => send('POST', `/api/packages/${id}/citations`, {}),
  editCitations: (id, patch) => send('PATCH', `/api/packages/${id}/citations`, patch),
  setPackageEvent: (id, event) => send('POST', `/api/packages/${id}/event`, event),
  render: (body) => send('POST', '/api/render', body),
  renderCapabilities: () => get('/api/render/capabilities'),
  renderStatus: (id) => get(`/api/render/${id}`),
  packageRenders: (pkgId) => get(`/api/packages/${pkgId}/renders`),
  cutClips: (renderId) => send('POST', `/api/render/${renderId}/clips`, {}),
  clipsStatus: (jobId) => get(`/api/render/clips/${jobId}`),

  shortsRelated: (pkgId) => get(`/api/shorts/related${pkgId ? `?pkg=${pkgId}` : ''}`),
  shortsCreate: (body) => send('POST', '/api/shorts', body),
  shortsProcess: (id, mode, opts) => send('POST', `/api/shorts/${id}/process`, { mode, opts }),
  shortsStatus: (id) => get(`/api/shorts/${id}/status`),
  shortsCover: (id, body) => send('POST', `/api/shorts/${id}/cover`, body),
  shortsPrompt: (id) => get(`/api/shorts/${id}/prompt`),
  shortsEmbedKit: (id) => get(`/api/shorts/${id}/embed-kit`),
  shortsVerify: (id) => send('POST', `/api/shorts/${id}/verify`, {}),
  shortsDeleteSource: (id) => send('POST', `/api/shorts/${id}/source/delete`, {}),
  // XHR rather than fetch so the browser can report upload progress.
  shortsUpload: (id, file, onProgress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/shorts/${id}/source`);
    xhr.setRequestHeader('content-type', file.type || 'video/mp4');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('upload interrupted'));
    xhr.send(file);
  }),

  youtubeStatus: () => get('/api/youtube/status'),
  youtubeDisconnect: () => send('POST', '/api/youtube/disconnect', {}),
  channelAudit: () => get('/api/youtube/channel-audit'),
  measureOverview: () => get('/api/measure/overview'),
  measureInsights: () => send('POST', '/api/measure/insights', {}),
  resultsCheck: (id) => send('POST', `/api/packages/${id}/results/check`, {}),
  resultsManual: (id, body) => send('POST', `/api/packages/${id}/results/manual`, body),
  shortsConsent: (id) => send('POST', `/api/shorts/${id}/consent`, { faces: true, rights: true }),
  shortsTranslate: (id, languages) => send('POST', `/api/shorts/${id}/translate`, { languages }),
  shortsReplies: (id, comments) => send('POST', `/api/shorts/${id}/replies`, { comments }),

  edits: () => get('/api/edits'),
  createEdit: (body) => send('POST', '/api/edits', body),
  edit: (id) => get(`/api/edits/${id}`),
  saveEdit: (id, body) => send('PUT', `/api/edits/${id}`, body),
  deleteEdit: (id) => send('DELETE', `/api/edits/${id}`),
  planEdit: (id, body) => send('POST', `/api/edits/${id}/plan`, body),
  editBeats: (id, assetId, snap) => send('POST', `/api/edits/${id}/beats`, { assetId, snap }),
  renderEdit: (id) => send('POST', `/api/edits/${id}/render`, {}),
  editSocial: (id) => send('POST', `/api/edits/${id}/social`, {}),
  editToShort: (id) => send('POST', `/api/edits/${id}/to-short`, {}),
  templates: () => get('/api/templates'),
  saveTemplate: (body) => send('POST', '/api/templates', body),
  deleteTemplate: (id) => send('DELETE', `/api/templates/${id}`),
  trends: () => get('/api/trends'),
  refreshTrends: () => send('POST', '/api/trends/refresh', {}),
  trendSettings: (body) => send('PUT', '/api/trends/settings', body),
  // Generic streamed upload with progress (assets, reference reels).
  uploadFile: (url, file, onProgress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('upload interrupted'));
    xhr.send(file);
  }),

  plan: () => get('/api/plan'),
  savePlan: (plan) => send('PUT', '/api/plan', plan),
  runPlan: (itemId) => send('POST', '/api/plan/run', itemId ? { itemId } : {}),
  planRunStatus: (id) => get(`/api/plan/run/${id}`),
  planQueue: () => get('/api/plan/queue'),

  avatars: () => get('/api/avatar/avatars'),
  avatarVoices: () => get('/api/avatar/voices'),
  avatarQuota: () => get('/api/avatar/quota'),
  avatarGenerate: (body) => send('POST', '/api/avatar/generate', body),
  avatarStatus: (id) => get(`/api/avatar/status/${id}`),
};

// Prefer the provider voice named after the creator (their HeyGen-linked
// clone) over whatever happens to sit first in the account's voice list.
export function pickOwnVoice(voices) {
  const first = (appState.profile?.business?.person?.name || '').trim().split(/\s+/)[0];
  if (!first || first.length < 2) return null;
  return (voices || []).find((v) => (v.name || '').toLowerCase().includes(first.toLowerCase())) || null;
}

// The creator's pinned voice per role ('narration' = ElevenLabs,
// 'avatar' = HeyGen). An exact id match beats every heuristic, and any
// change made in a voice select is saved back as the new studio-wide
// default, so the chosen voice holds everywhere, every time.
export function preferredVoice(voices, kind) {
  const prefs = appState.profile?.voicePrefs || {};
  const id = kind === 'avatar' ? prefs.avatarVoiceId : prefs.narrationVoiceId;
  return id ? (voices || []).find((v) => v.id === id) || null : null;
}

export function saveVoicePref(kind, id) {
  if (!id) return;
  const prefs = { ...(appState.profile?.voicePrefs || {}) };
  prefs[kind === 'avatar' ? 'avatarVoiceId' : 'narrationVoiceId'] = id;
  if (appState.state?.profile) appState.state.profile.voicePrefs = prefs;
  api.patchState('profile.voicePrefs', prefs).catch(() => { /* sticky best effort */ });
}

export const appState = {
  state: null,
  health: null,
  platforms: [],
  workspaces: { items: [], activeId: null },
  async boot() {
    [this.health, this.state, this.workspaces] = await Promise.all([api.health(), api.state(), api.workspaces()]);
    this.platforms = (await api.platforms()).platforms;
  },
  async reloadWorkspace() {
    [this.state, this.workspaces] = await Promise.all([api.state(), api.workspaces()]);
  },
  get profile() {
    return this.state?.profile || {};
  },
  async save() {
    await api.saveState(this.state);
  },
};
