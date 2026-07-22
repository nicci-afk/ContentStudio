// Server-side clients for Claude (generation + vision), ElevenLabs (voice
// clone + TTS), and HeyGen (avatar video). Keys stay in .env — never shipped
// to the browser.

// Base URLs are env-overridable so local tests can stand in for providers.
const ANTHROPIC_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const ELEVEN_URL = process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io';
const HEYGEN_URL = process.env.HEYGEN_API_URL || 'https://api.heygen.com';

export const providerStatus = () => ({
  anthropic: !!process.env.ANTHROPIC_API_KEY,
  elevenlabs: !!process.env.ELEVENLABS_API_KEY,
  heygen: !!process.env.HEYGEN_API_KEY,
  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
});

export class ProviderError extends Error {
  constructor(provider, status, detail) {
    super(`${provider} error ${status}: ${detail}`);
    this.provider = provider;
    this.status = status;
  }
}

export async function claude({ system, messages, maxTokens = 4096, temperature = 1 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ProviderError('anthropic', 401, 'ANTHROPIC_API_KEY not configured');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    }),
  });
  if (!res.ok) throw new ProviderError('anthropic', res.status, (await res.text()).slice(0, 500));
  const data = await res.json();
  return data.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || '';
}

export function parseJsonReply(raw) {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  const lastBrace = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastBrace > 0) s = s.slice(0, lastBrace + 1);
  return JSON.parse(s);
}

export async function claudeJson(opts, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const raw = await claude(opts);
    try {
      return parseJsonReply(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new ProviderError('anthropic', 502, `unparseable JSON response: ${lastErr?.message}`);
}

export function imageBlock(base64, mediaType = 'image/jpeg') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
}

// List endpoints get a retry (providers hiccup) and a 10-minute cache that
// serves stale data when the provider is briefly down — a flaky upstream
// should never blank a working panel.
const listCache = new Map();

async function cachedList(key, fn, ttlMs = 10 * 60 * 1000) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  try {
    const data = await fn();
    listCache.set(key, { data, ts: Date.now() });
    return data;
  } catch (err) {
    if (hit) return hit.data;
    throw err;
  }
}

async function getJsonWithRetry(provider, url, headers) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    throw new ProviderError(provider, res.status, (await res.text()).slice(0, 300));
  }
  throw new ProviderError(provider, 502, 'retries exhausted');
}

// ---- ElevenLabs ----------------------------------------------------------

function elevenHeaders(extra = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new ProviderError('elevenlabs', 401, 'ELEVENLABS_API_KEY not configured');
  return { 'xi-api-key': key, ...extra };
}

export function elevenVoices() {
  return cachedList('eleven-voices', async () => {
    const data = await getJsonWithRetry('elevenlabs', `${ELEVEN_URL}/v1/voices`, elevenHeaders());
    return (data.voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category,
      description: v.description || v.labels?.description || '',
      preview: v.preview_url || null,
    }));
  });
}

export async function elevenClone({ name, description, samples }) {
  const form = new FormData();
  form.append('name', name);
  if (description) form.append('description', description);
  for (const s of samples) {
    const buf = Buffer.from(s.b64, 'base64');
    form.append('files', new Blob([buf], { type: s.mime || 'audio/mpeg' }), s.name || 'sample.mp3');
  }
  const res = await fetch(`${ELEVEN_URL}/v1/voices/add`, {
    method: 'POST',
    headers: elevenHeaders(),
    body: form,
  });
  if (!res.ok) throw new ProviderError('elevenlabs', res.status, (await res.text()).slice(0, 500));
  listCache.delete('eleven-voices');
  return res.json();
}

// Narration pacing: a speed under 1 reads calmer and more welcoming, over 1
// reads urgent. Only sent when it differs from neutral so existing voices
// keep their stored delivery.
const voiceSettings = (stability, similarity, speed) => ({
  stability,
  similarity_boost: similarity,
  ...(speed && speed !== 1 ? { speed: Math.min(1.2, Math.max(0.7, speed)) } : {}),
});

// TTS with character-level timestamps so captions sync exactly to speech.
export async function elevenTtsTimed({ voiceId, text, stability = 0.5, similarity = 0.8, speed }) {
  const res = await fetch(`${ELEVEN_URL}/v1/text-to-speech/${voiceId}/with-timestamps`, {
    method: 'POST',
    headers: elevenHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: voiceSettings(stability, similarity, speed),
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.audio_base64) return null;
  return { audio: Buffer.from(data.audio_base64, 'base64'), alignment: data.alignment || null };
}

export async function elevenTts({ voiceId, text, stability = 0.5, similarity = 0.8, speed }) {
  const res = await fetch(`${ELEVEN_URL}/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: elevenHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: voiceSettings(stability, similarity, speed),
    }),
  });
  if (!res.ok) throw new ProviderError('elevenlabs', res.status, (await res.text()).slice(0, 300));
  return Buffer.from(await res.arrayBuffer());
}

// ---- HeyGen (v3 API; v2 is legacy and shuts down on 2026-10-31) ----------

function heygenHeaders(extra = {}) {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new ProviderError('heygen', 401, 'HEYGEN_API_KEY not configured');
  return { 'x-api-key': key, ...extra };
}

// v3 lists avatar "looks"; a look id is the avatar_id for video creation.
// The creator's own (private) looks list first, then a page of public
// presets. Newer avatar generations (Avatar IV/V) only appear here, never
// in the legacy v2 list, so this is also how the creator's current avatars
// become visible at all. The legacy list stays as a fallback while v3
// rolls out.
async function heygenLooksPage(ownership, token) {
  const q = new URLSearchParams({ limit: '50', ownership });
  if (token) q.set('token', token);
  return getJsonWithRetry('heygen', `${HEYGEN_URL}/v3/avatars/looks?${q}`, heygenHeaders());
}

export function heygenAvatars() {
  return cachedList('heygen-avatars', async () => {
    try {
      // Group names are what the HeyGen app shows as "my avatars" (looks
      // are the outfits and scenes inside a group), so the creator finds
      // an avatar here under the exact name they gave it in HeyGen.
      const groupName = new Map();
      try {
        let gtoken = '';
        for (let page = 0; page < 10; page++) {
          const q = new URLSearchParams({ limit: '50', ownership: 'private' });
          if (gtoken) q.set('token', gtoken);
          const g = await getJsonWithRetry('heygen', `${HEYGEN_URL}/v3/avatars?${q}`, heygenHeaders());
          for (const grp of g.data || []) groupName.set(grp.id, grp.name);
          if (!g.has_more || !g.next_token) break;
          gtoken = g.next_token;
        }
      } catch { /* group names are a labeling nicety, never a blocker */ }
      const looks = [];
      for (const ownership of ['private', 'public']) {
        let token = '';
        const maxPages = ownership === 'private' ? 10 : 2;
        for (let page = 0; page < maxPages; page++) {
          const data = await heygenLooksPage(ownership, token);
          for (const l of data.data || []) {
            const grp = ownership === 'private' ? groupName.get(l.group_id) || null : null;
            looks.push({
              id: l.id,
              name: grp && grp !== l.name ? `${grp} · ${l.name || 'look'}` : (l.name || grp || 'Avatar'),
              group: grp,
              gender: l.gender || null,
              kind: l.avatar_type === 'photo_avatar' ? 'talking_photo' : 'avatar',
              preview: l.preview_image_url || null,
              own: ownership === 'private',
            });
          }
          if (!data.has_more || !data.next_token) break;
          token = data.next_token;
        }
      }
      if (looks.length) return looks;
      throw new ProviderError('heygen', 502, 'v3 looks list came back empty');
    } catch {
      const data = await getJsonWithRetry('heygen', `${HEYGEN_URL}/v2/avatars`, heygenHeaders());
      const photos = (data.data?.talking_photos || []).map((p) => ({
        id: p.talking_photo_id,
        name: p.talking_photo_name || 'My photo avatar',
        kind: 'talking_photo',
        preview: p.preview_image_url || null,
      }));
      const avatars = (data.data?.avatars || []).map((a) => ({
        id: a.avatar_id,
        name: a.avatar_name,
        gender: a.gender,
        kind: 'avatar',
        preview: a.preview_image_url || null,
      }));
      return [...photos, ...avatars];
    }
  });
}

export function heygenVoices() {
  return cachedList('heygen-voices', async () => {
    const data = await getJsonWithRetry('heygen', `${HEYGEN_URL}/v2/voices`, heygenHeaders());
    return (data.data?.voices || []).slice(0, 100).map((v) => ({
      id: v.voice_id, name: v.name, language: v.language, gender: v.gender,
    }));
  });
}

// v3 create-video: one script per video (long sections submit as several
// consecutive videos and concat after download). Transparent output rides
// the webm format, which carries a real alpha channel for compositing the
// creator over footage; docs recommend auto aspect and 1080p there.
export async function heygenGenerate({ avatarId, voiceId, text, texts, title, orientation = 'portrait', speed, transparent }) {
  const script = String(texts?.length ? texts.join(' ') : text || '').slice(0, 1500);
  const body = {
    type: 'avatar',
    avatar_id: avatarId,
    script,
    voice_id: voiceId,
    ...(speed && speed !== 1 ? { voice_settings: { speed: Math.min(1.5, Math.max(0.5, speed)) } } : {}),
    title: title || 'ContentStudio render',
    ...(transparent
      ? { output_format: 'webm', aspect_ratio: 'auto', resolution: '1080p' }
      : { output_format: 'mp4', aspect_ratio: orientation === 'portrait' ? '9:16' : '16:9', resolution: '720p' }),
  };
  const res = await fetch(`${HEYGEN_URL}/v3/videos`, {
    method: 'POST',
    headers: heygenHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ProviderError('heygen', res.status, (await res.text()).slice(0, 500));
  const data = await res.json();
  return { videoId: data.data?.video_id, outputFormat: data.data?.output_format || (transparent ? 'webm' : 'mp4') };
}

export async function heygenStatus(videoId) {
  const res = await fetch(`${HEYGEN_URL}/v3/videos/${encodeURIComponent(videoId)}`, {
    headers: heygenHeaders(),
  });
  if (!res.ok) throw new ProviderError('heygen', res.status, (await res.text()).slice(0, 300));
  const data = await res.json();
  const d = data.data || data;
  const raw = String(d.status || '').toLowerCase();
  const status = ['completed', 'success', 'succeeded', 'done'].includes(raw) ? 'completed'
    : ['failed', 'error'].includes(raw) ? 'failed'
      : 'processing';
  return {
    status,
    url: d.video_url || null,
    thumbnail: d.thumbnail_url || null,
    error: d.failure_reason || d.error || null,
  };
}
