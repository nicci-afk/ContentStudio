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
  state: () => get('/api/state'),
  saveState: (state) => send('PUT', '/api/state', state),
  patchState: (path, value) => send('PATCH', '/api/state', { path, value }),
  loadDemo: () => send('POST', '/api/demo', {}),

  interviewBrief: (answers) => send('POST', '/api/interview/brief', { answers }),
  voiceDna: (files) => send('POST', '/api/voice-dna', { files }),

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
  deletePackage: (id) => send('DELETE', `/api/packages/${id}`),

  voices: () => get('/api/voice/voices'),
  cloneVoice: (body) => send('POST', '/api/voice/clone', body),
  tts: (body) =>
    fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((res) => {
        if (!res.ok) return res.json().then((b) => { throw new Error(b.error || 'TTS failed'); });
        return res.blob();
      }),

  avatars: () => get('/api/avatar/avatars'),
  avatarVoices: () => get('/api/avatar/voices'),
  avatarGenerate: (body) => send('POST', '/api/avatar/generate', body),
  avatarStatus: (id) => get(`/api/avatar/status/${id}`),
};

export const appState = {
  state: null,
  health: null,
  platforms: [],
  async boot() {
    [this.health, this.state] = await Promise.all([api.health(), api.state()]);
    this.platforms = (await api.platforms()).platforms;
  },
  get profile() {
    return this.state?.profile || {};
  },
  async save() {
    await api.saveState(this.state);
  },
};
