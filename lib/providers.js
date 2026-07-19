// Server-side clients for Claude (generation + vision), ElevenLabs (voice
// clone + TTS), and HeyGen (avatar video). Keys stay in .env — never shipped
// to the browser.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ELEVEN_URL = 'https://api.elevenlabs.io';
const HEYGEN_URL = 'https://api.heygen.com';

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

// ---- ElevenLabs ----------------------------------------------------------

function elevenHeaders(extra = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new ProviderError('elevenlabs', 401, 'ELEVENLABS_API_KEY not configured');
  return { 'xi-api-key': key, ...extra };
}

export async function elevenVoices() {
  const res = await fetch(`${ELEVEN_URL}/v1/voices`, { headers: elevenHeaders() });
  if (!res.ok) throw new ProviderError('elevenlabs', res.status, (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
    description: v.description || v.labels?.description || '',
    preview: v.preview_url || null,
  }));
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
  return res.json();
}

// TTS with character-level timestamps so captions sync exactly to speech.
export async function elevenTtsTimed({ voiceId, text, stability = 0.5, similarity = 0.8 }) {
  const res = await fetch(`${ELEVEN_URL}/v1/text-to-speech/${voiceId}/with-timestamps`, {
    method: 'POST',
    headers: elevenHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability, similarity_boost: similarity },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.audio_base64) return null;
  return { audio: Buffer.from(data.audio_base64, 'base64'), alignment: data.alignment || null };
}

export async function elevenTts({ voiceId, text, stability = 0.5, similarity = 0.8 }) {
  const res = await fetch(`${ELEVEN_URL}/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: elevenHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability, similarity_boost: similarity },
    }),
  });
  if (!res.ok) throw new ProviderError('elevenlabs', res.status, (await res.text()).slice(0, 300));
  return Buffer.from(await res.arrayBuffer());
}

// ---- HeyGen --------------------------------------------------------------

function heygenHeaders(extra = {}) {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new ProviderError('heygen', 401, 'HEYGEN_API_KEY not configured');
  return { 'x-api-key': key, ...extra };
}

export async function heygenAvatars() {
  const res = await fetch(`${HEYGEN_URL}/v2/avatars`, { headers: heygenHeaders() });
  if (!res.ok) throw new ProviderError('heygen', res.status, (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.data?.avatars || []).map((a) => ({
    id: a.avatar_id,
    name: a.avatar_name,
    gender: a.gender,
    preview: a.preview_image_url || null,
  }));
}

export async function heygenVoices() {
  const res = await fetch(`${HEYGEN_URL}/v2/voices`, { headers: heygenHeaders() });
  if (!res.ok) throw new ProviderError('heygen', res.status, (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.data?.voices || []).slice(0, 100).map((v) => ({
    id: v.voice_id, name: v.name, language: v.language, gender: v.gender,
  }));
}

export async function heygenGenerate({ avatarId, voiceId, text, title, orientation = 'portrait' }) {
  const portrait = orientation === 'portrait';
  const res = await fetch(`${HEYGEN_URL}/v2/video/generate`, {
    method: 'POST',
    headers: heygenHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      title: title || 'ContentStudio render',
      dimension: portrait ? { width: 720, height: 1280 } : { width: 1280, height: 720 },
      video_inputs: [{
        character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
        voice: { type: 'text', voice_id: voiceId, input_text: text },
      }],
    }),
  });
  if (!res.ok) throw new ProviderError('heygen', res.status, (await res.text()).slice(0, 500));
  const data = await res.json();
  return { videoId: data.data?.video_id };
}

export async function heygenStatus(videoId) {
  const res = await fetch(`${HEYGEN_URL}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
    headers: heygenHeaders(),
  });
  if (!res.ok) throw new ProviderError('heygen', res.status, (await res.text()).slice(0, 300));
  const data = await res.json();
  return {
    status: data.data?.status,
    url: data.data?.video_url || null,
    thumbnail: data.data?.thumbnail_url || null,
    error: data.data?.error || null,
  };
}
