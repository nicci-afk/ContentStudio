const j = (res) => {
  if (!res.ok) return res.json().catch(() => ({})).then((b) => {
    throw new Error(b.error || `${res.status} ${res.statusText}`);
  });
  return res.json();
};

const get = (url) => fetch(url).then(j);
const send = (method, url, body) =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j);

export const api = {
  health: () => get('/api/health'),
  platforms: () => get('/api/platforms'),
  workspaces: () => get('/api/workspaces'),
  createWorkspace: (name) => send('POST', '/api/workspaces', { name }),
  activateWorkspace: (id) => send('POST', `/api/workspaces/${id}/activate`, {}),
  renameWorkspace: (id, name) => send('PATCH', `/api/workspaces/${id}`, { name }),
  deleteWorkspace: (id) => send('DELETE', `/api/workspaces/${id}`),
  state: () => get('/api/state'),
  saveState: (state) => send('PUT', '/api/state', state),
  patchState: (path, value) => send('PATCH', '/api/state', { path, value }),
  loadDemo: () => send('POST', '/api/demo', {}),

  interviewBrief: (answers) => send('POST', '/api/interview/brief', { answers }),
  voiceDna: (files) => send('POST', '/api/voice-dna', { files }),
  removeVoiceSource: (name) => send('POST', '/api/voice-dna/remove', { name }),

  media: () => get('/api/media'),
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

  attachMedia: (id, body = {}) => send('POST', `/api/packages/${id}/media`, body),
  carouselMedia: (id) => send('POST', `/api/packages/${id}/carousel-media`, {}),
  approvePlatform: (id, platformId, approved) => send('POST', `/api/packages/${id}/approve`, { platformId, approved }),
  setPublishedUrl: (id, platformId, url) => send('POST', `/api/packages/${id}/published`, { platformId, url }),
  regenCitations: (id) => send('POST', `/api/packages/${id}/citations`, {}),
  editCitations: (id, patch) => send('PATCH', `/api/packages/${id}/citations`, patch),
  setPackageEvent: (id, event) => send('POST', `/api/packages/${id}/event`, event),
  render: (body) => send('POST', '/api/render', body),
  renderStatus: (id) => get(`/api/render/${id}`),
  packageRenders: (pkgId) => get(`/api/packages/${pkgId}/renders`),
  cutClips: (renderId) => send('POST', `/api/render/${renderId}/clips`, {}),
  clipsStatus: (jobId) => get(`/api/render/clips/${jobId}`),

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
