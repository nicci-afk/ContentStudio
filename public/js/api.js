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

  render: (body) => send('POST', '/api/render', body),
  renderStatus: (id) => get(`/api/render/${id}`),
  packageRenders: (pkgId) => get(`/api/packages/${pkgId}/renders`),

  avatars: () => get('/api/avatar/avatars'),
  avatarVoices: () => get('/api/avatar/voices'),
  avatarGenerate: (body) => send('POST', '/api/avatar/generate', body),
  avatarStatus: (id) => get(`/api/avatar/status/${id}`),
};

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
