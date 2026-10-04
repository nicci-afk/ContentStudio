// Edit-plan engine: the studio cuts short-form video itself.
//
// An edit is a plain JSON "edit list" (EDL): which library or uploaded clips,
// where each starts and ends, speed, how it fits a vertical frame, a slow push
// in, the transition into it, text overlays, and a music bed with ducking.
// Claude writes the list from a brief (and optionally a template's structure);
// the creator can change any row by hand; ffmpeg renders it. Nothing here ever
// reuses anyone else's footage, voice or sound: sources are her own library
// and her own uploads only.
//
// Rendering works on the 2018 ffmpeg build the server ships, so transitions are
// built from overlay and fade filters rather than xfade.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { uid, mediaStore, mediaPath, studioStore, stateStore, packageStore, workspaceDir } from './store.js';
import { ffmpeg, ffmpegPath, rendersDir, renderPaths, blurFill, findCaptionFont, activeRenderIds, enqueuePreview } from './render.js';
import { probeMedia, probeAny, copyIssues, createShortDraft, markUploaded, startShortProcess } from './shorts.js';
import { masterContext, shortlistForSelection } from './engine.js';
import { claudeJson, providerStatus } from './providers.js';
import { diskFree } from './storage.js';
import { beginJob, endJob, otherJobLabel } from './busy.js';

export const W = 1080;
export const H = 1920;
export const FPS = 30;
const MAX_CLIPS = 40;
const MAX_SECONDS = 180;
const MIN_FREE = 1536 * 1024 * 1024;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;

export const TRANSITIONS = ['cut', 'fade', 'dissolve', 'slideleft', 'slideright', 'slideup', 'fadeblack'];
export const FITS = ['blur', 'crop', 'contain'];
export const TEXT_STYLES = ['hook', 'caption', 'label', 'cta'];
export const POSITIONS = ['top', 'middle', 'bottom', 'lower-third'];
const ANIMATE = ['pop', 'fade', 'none'];

const dashless = (s) => String(s == null ? '' : s).replace(/\s*[—–]\s*/g, ', ');
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const r3 = (n) => Math.round(n * 1000) / 1000;
const edits = () => studioStore.get().edits || [];
const saveEdits = (fn) => studioStore.update((s) => ({ ...s, edits: fn(s.edits || []) }));

// ---- projects --------------------------------------------------------------

export const listEdits = () => edits().map((e) => ({
  id: e.id, title: e.title, status: e.status || 'draft', updatedAt: e.updatedAt, seconds: e.edl?.seconds || 0,
  clips: e.edl?.clips?.length || 0, renderId: e.renderId || null,
})).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

export const getEdit = (id) => edits().find((e) => e.id === id) || null;

export function createEdit({ title, brief }) {
  const e = {
    id: uid(), title: dashless(title || 'New edit').slice(0, 100), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'draft', brief: brief || {}, edl: emptyEdl(title), assets: [], renderId: null, social: null,
  };
  saveEdits((list) => [e, ...list]);
  return e;
}

export const emptyEdl = (title) => ({ version: 1, title: dashless(title || ''), width: W, height: H, fps: FPS, seconds: 0, clips: [], texts: [], audio: { music: null, loudnorm: true } });

const patchEdit = (id, fn) => {
  let out = null;
  saveEdits((list) => list.map((e) => (e.id === id ? (out = fn(e) || e) : e)));
  return out;
};

export function deleteEdit(id) {
  const e = getEdit(id);
  if (!e) return false;
  if (jobs.has(id)) throw new Error('this edit is rendering right now');
  if (e.renderId) removeRenderFiles(e.renderId);
  fs.rmSync(assetDir(id), { recursive: true, force: true });
  saveEdits((list) => list.filter((x) => x.id !== id));
  return true;
}

function removeRenderFiles(rid) {
  const dir = rendersDir();
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${rid}.`)) fs.rmSync(path.join(dir, f), { force: true });
}

// ---- uploaded assets (her own clips and music, per edit) -----------------------

export const assetDir = (editId) => path.join(workspaceDir(), 'edits', String(editId).replace(/[^a-z0-9_-]/gi, ''));
export const assetPath = (editId, assetId) => path.join(assetDir(editId), `${String(assetId).replace(/[^a-z0-9_-]/gi, '')}.bin`);
export { MAX_ASSET_BYTES };

export async function registerAsset(editId, assetId, name, bytes) {
  const file = assetPath(editId, assetId);
  let info;
  const isImage = /\.(jpe?g|png|webp|heic)$/i.test(name);
  try {
    const p = isImage ? { duration: 0, hasVideo: false, hasAudio: false } : await probeAny(file);
    info = { duration: p.duration, hasAudio: p.hasAudio, kind: isImage ? 'image' : p.hasVideo ? 'video' : p.hasAudio ? 'audio' : null };
  } catch {
    info = { kind: null };
  }
  if (!info.kind) { fs.rmSync(file, { force: true }); throw new Error('that file is not a readable video, audio or image'); }
  const asset = { id: assetId, name: String(name).slice(0, 120), kind: info.kind, duration: Math.round((info.duration || 0) * 10) / 10, hasAudio: !!info.hasAudio, bytes };
  patchEdit(editId, (e) => { e.assets = [...(e.assets || []), asset]; return e; });
  return asset;
}

// ---- sources --------------------------------------------------------------------

const probeCache = new Map();
async function probeCached(file) {
  if (!probeCache.has(file)) {
    try { probeCache.set(file, await probeMedia(file)); } catch { probeCache.set(file, null); }
  }
  return probeCache.get(file);
}

// Resolve a clip source to a real file: a library video's original (or its
// still frame when no original was uploaded), a library image, or an asset.
export async function resolveSource(edit, src) {
  if (src?.type === 'asset') {
    const a = (edit.assets || []).find((x) => x.id === src.id);
    const f = a && assetPath(edit.id, a.id);
    if (!a || !fs.existsSync(f)) return null;
    if (a.kind === 'audio') return null;
    const probe = a.kind === 'video' ? await probeCached(f) : null;
    return { path: f, kind: a.kind, duration: a.kind === 'video' ? (probe?.duration || a.duration) : Infinity, hasAudio: a.kind === 'video' && !!probe?.hasAudio, label: a.name };
  }
  if (src?.type === 'media') {
    const item = mediaStore.get().items.find((i) => i.id === src.id);
    if (!item) return null;
    const original = mediaPath(item.id, 'original');
    if (item.kind === 'video' && fs.existsSync(original)) {
      const probe = await probeCached(original);
      return { path: original, kind: 'video', duration: probe?.duration || 0, hasAudio: !!probe?.hasAudio, label: item.alt || item.name };
    }
    for (const k of ['render', 'analysis', 'thumb']) {
      const f = mediaPath(item.id, k);
      if (fs.existsSync(f)) return { path: f, kind: 'image', duration: Infinity, hasAudio: false, label: item.alt || item.name };
    }
  }
  return null;
}

// ---- sanitizing an edit list ------------------------------------------------------

const cleanText = (s, n) => dashless(s).replace(/[\\{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

export function overlapOf(clip, prev) {
  if (!prev) return 0;
  const t = clip.transition || {};
  if (!['fade', 'dissolve', 'slideleft', 'slideright', 'slideup'].includes(t.type)) return 0;
  return Math.min(t.seconds || 0.4, clipSeconds(clip) * 0.45, clipSeconds(prev) * 0.45);
}
export const clipSeconds = (c) => (c.out - c.in) / c.speed;

export function timeline(clips) {
  let t = 0;
  const starts = [];
  clips.forEach((c, i) => {
    const ov = i ? overlapOf(c, clips[i - 1]) : 0;
    t -= ov;
    starts.push(r3(t));
    t += clipSeconds(c);
  });
  return { starts, seconds: r3(t) };
}

export async function sanitizeEdl(raw, edit) {
  const out = emptyEdl(raw?.title || edit.title);
  const assetIds = new Set((edit.assets || []).map((a) => a.id));
  const clips = [];
  for (const c of (raw?.clips || []).slice(0, MAX_CLIPS)) {
    const src = c?.src?.type === 'asset' ? { type: 'asset', id: String(c.src.id) } : { type: 'media', id: String(c?.src?.id || c?.mediaId || '') };
    if (src.type === 'asset' && !assetIds.has(src.id)) continue;
    const res = await resolveSource(edit, src);
    if (!res) continue;
    const speed = num(c.speed, 0.25, 4, 1);
    let inn = num(c.in, 0, 36000, 0);
    let outt = num(c.out, 0.3, 36000, inn + 3);
    if (res.kind === 'image') { inn = 0; outt = num(c.out ?? 3, 0.5, 12, 3); } else if (res.duration) {
      outt = Math.min(outt, res.duration);
      if (inn > outt - 0.3) inn = Math.max(0, outt - 3);
    }
    if (outt - inn < 0.3) continue;
    const z = c.zoom && Number.isFinite(Number(c.zoom.from)) && Number.isFinite(Number(c.zoom.to))
      ? { from: num(c.zoom.from, 1, 1.6, 1), to: num(c.zoom.to, 1, 1.6, 1.1) } : null;
    const tt = TRANSITIONS.includes(c.transition?.type) ? c.transition.type : 'cut';
    clips.push({
      id: String(c.id || `c${clips.length + 1}`).slice(0, 20), src,
      in: r3(inn), out: r3(outt), speed: r3(speed), fit: FITS.includes(c.fit) ? c.fit : 'blur',
      zoom: z && z.to !== z.from ? z : null, audio: c.audio === 'mute' || res.kind !== 'video' ? 'mute' : 'keep',
      volume: num(c.volume, 0, 2, 1),
      transition: { type: clips.length ? tt : 'cut', seconds: r3(num(c.transition?.seconds, 0.15, 1.2, 0.4)) },
    });
  }
  out.clips = clips;
  const tl = timeline(clips);
  out.seconds = tl.seconds;
  if (out.seconds > MAX_SECONDS) throw new Error(`the edit runs ${Math.round(out.seconds)} seconds; the limit is ${MAX_SECONDS}`);
  out.texts = (raw?.texts || []).slice(0, 30).map((t, i) => {
    const text = cleanText(t?.text, 90);
    if (!text) return null;
    const start = num(t.start, 0, Math.max(0.1, out.seconds - 0.3), 0);
    return {
      id: String(t.id || `t${i + 1}`).slice(0, 20), text, start: r3(start), end: r3(num(t.end, start + 0.4, out.seconds || start + 3, Math.min(out.seconds || start + 3, start + 3))),
      style: TEXT_STYLES.includes(t.style) ? t.style : 'caption', position: POSITIONS.includes(t.position) ? t.position : (t.style === 'hook' ? 'top' : 'bottom'),
      animate: ANIMATE.includes(t.animate) ? t.animate : 'pop',
    };
  }).filter(Boolean);
  const m = raw?.audio?.music;
  if (m?.assetId && assetIds.has(String(m.assetId)) && (edit.assets || []).find((a) => a.id === String(m.assetId))?.kind !== 'image') {
    out.audio.music = { assetId: String(m.assetId), volume: num(m.volume, 0.05, 1, 0.35), duck: m.duck !== false, startAt: num(m.startAt, 0, 3600, 0) };
  }
  out.audio.loudnorm = raw?.audio?.loudnorm !== false;
  return out;
}

export async function saveEdl(editId, raw, title) {
  const edit = getEdit(editId);
  if (!edit) throw new Error('unknown edit');
  const edl = await sanitizeEdl(raw, edit);
  return patchEdit(editId, (e) => { e.edl = edl; if (title) e.title = dashless(title).slice(0, 100); e.updatedAt = new Date().toISOString(); if (e.status === 'done') e.status = 'draft'; return e; });
}

// ---- beats -------------------------------------------------------------------------

function pcm(file, seconds) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-t', String(seconds), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', reject);
    proc.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

// Tempo and beat times from the audio itself: an energy envelope, its onset
// flux, an autocorrelation for the period, and a phase search for the offset.
export async function analyzeBeats(file, seconds = 120) {
  const buf = await pcm(file, seconds);
  const n = Math.floor(buf.length / 2);
  if (n < 8000 * 6) throw new Error('that audio is too short to find a beat');
  const hop = 256; const rate = 8000 / hop;
  const frames = Math.floor(n / hop);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < hop; i++) { const v = buf.readInt16LE((f * hop + i) * 2) / 32768; e += v * v; }
    env[f] = Math.sqrt(e / hop);
  }
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, env[f] - env[f - 1]);
  const mean = flux.reduce((a, b) => a + b, 0) / frames;
  for (let f = 0; f < frames; f++) flux[f] = Math.max(0, flux[f] - mean);
  let best = { lag: 0, score: -1 };
  for (let bpm = 70; bpm <= 170; bpm += 0.5) {
    const lag = (60 / bpm) * rate;
    let score = 0;
    for (let k = 1; k * lag < frames; k++) {
      const i = Math.round(k * lag);
      score += flux[i] + (flux[i - 1] || 0) * 0.5 + (flux[i + 1] || 0) * 0.5;
    }
    score /= Math.max(1, Math.floor(frames / lag));
    // Gentle preference for the 90 to 150 range, where people actually cut.
    if (bpm >= 90 && bpm <= 150) score *= 1.1;
    if (score > best.score) best = { lag, score, bpm };
  }
  const period = best.lag / rate;
  let phase = { off: 0, score: -1 };
  for (let o = 0; o < best.lag; o += 0.5) {
    let score = 0;
    for (let t = o; t < frames; t += best.lag) score += flux[Math.round(t)] || 0;
    if (score > phase.score) phase = { off: o, score };
  }
  const beats = [];
  for (let t = phase.off / rate; t < frames / rate; t += period) beats.push(r3(t));
  return { bpm: Math.round(best.bpm * 10) / 10, period: r3(period), beats };
}

// Move clip boundaries onto the nearest beat so cuts land with the music.
export function snapToBeats(edl, beats, minClip = 0.8) {
  if (!beats?.length || edl.clips.length < 2) return edl;
  const clips = edl.clips.map((c) => ({ ...c }));
  let boundary = 0;
  let prevStart = 0;
  for (let i = 0; i < clips.length - 1; i++) {
    const c = clips[i];
    boundary = prevStart + clipSeconds(c);
    const near = beats.reduce((b, t) => (Math.abs(t - boundary) < Math.abs(b - boundary) ? t : b), beats[0]);
    const target = Math.max(prevStart + minClip, Math.abs(near - boundary) <= 0.35 ? near : boundary);
    const newDur = target - prevStart;
    if (c.speed && newDur > 0.2) c.out = r3(c.in + newDur * c.speed);
    prevStart = prevStart + clipSeconds(c);
  }
  return { ...edl, clips, seconds: timeline(clips).seconds };
}

// ---- rendering -----------------------------------------------------------------------

const jobs = new Map();
export const editJob = (id) => jobs.get(id) || null;

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

function layoutFilter(fit) {
  if (fit === 'crop') return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  if (fit === 'contain') return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
  return blurFill(W, H);
}

async function buildSegment({ clip, src, idx, out, fadeIn, fadeOut }) {
  const d = clipSeconds(clip);
  const isVideo = src.kind === 'video';
  const args = [];
  if (isVideo) args.push('-ss', String(clip.in), '-t', String(clip.out - clip.in), '-i', src.path);
  else args.push('-loop', '1', '-framerate', String(FPS), '-t', d.toFixed(3), '-i', src.path);
  const wantsAudio = isVideo && src.hasAudio && clip.audio !== 'mute';
  if (!wantsAudio) args.push('-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const frames = Math.max(1, Math.round(d * FPS));
  const chain = [isVideo ? `setpts=(PTS-STARTPTS)/${clip.speed}` : 'setpts=PTS-STARTPTS', layoutFilter(clip.fit)];
  if (clip.zoom) chain.push(`zoompan=z='${clip.zoom.from}+(${clip.zoom.to}-${clip.zoom.from})*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`);
  chain.push(`fps=${FPS}`, 'setsar=1', 'format=yuv420p');
  if (fadeIn) chain.push(`fade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut) chain.push(`fade=t=out:st=${(d - fadeOut).toFixed(3)}:d=${fadeOut}`);
  let fc = `[0:v]${chain.join(',')}[v]`;
  const afx = [];
  if (wantsAudio) {
    afx.push(atempoChain(clip.speed), 'aresample=48000', `volume=${clip.volume}`, 'apad', `atrim=0:${d.toFixed(3)}`);
    if (fadeIn) afx.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut) afx.push(`afade=t=out:st=${(d - fadeOut).toFixed(3)}:d=${fadeOut}`);
    fc += `;[0:a]${afx.join(',')}[a]`;
  } else {
    fc += `;[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${d.toFixed(3)}[a]`;
  }
  args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', d.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-y', out);
  await ffmpeg(args, 15 * 60 * 1000);
  return d;
}

function overlayExpr(type, s, ov) {
  const p = `min(1,max(0,(t-${s})/${ov}))`;
  if (type === 'slideleft') return `overlay=x='W*(1-${p})':y=0:eval=frame:eof_action=pass`;
  if (type === 'slideright') return `overlay=x='-W*(1-${p})':y=0:eval=frame:eof_action=pass`;
  if (type === 'slideup') return `overlay=x=0:y='H*(1-${p})':eval=frame:eof_action=pass`;
  return 'overlay=eof_action=pass';
}

async function joinSegments({ segs, clips, starts, total, out, tmp }) {
  const ovs = clips.map((c, i) => (i ? overlapOf(c, clips[i - 1]) : 0));
  if (ovs.every((o) => o === 0)) {
    fs.writeFileSync(path.join(tmp, 'list.txt'), segs.map((f) => `file '${path.basename(f)}'`).join('\n'));
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', '-y', path.basename(out)], 10 * 60 * 1000, tmp);
    return;
  }
  const args = ['-f', 'lavfi', '-t', (total + 0.2).toFixed(3), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`];
  segs.forEach((f) => args.push('-i', path.basename(f)));
  const parts = [];
  clips.forEach((c, i) => {
    const t = c.transition?.type;
    const fade = i && ovs[i] && ['fade', 'dissolve'].includes(t) ? `format=yuva420p,fade=t=in:st=0:d=${ovs[i].toFixed(3)}:alpha=1,` : '';
    parts.push(`[${i + 1}:v]${fade}setpts=PTS-STARTPTS+${starts[i]}/TB[v${i}]`);
  });
  let prev = '0:v';
  clips.forEach((c, i) => {
    const label = i === clips.length - 1 ? 'vout' : `o${i}`;
    const ex = i && ovs[i] ? overlayExpr(c.transition.type, starts[i], ovs[i].toFixed(3)) : 'overlay=eof_action=pass';
    parts.push(`[${prev}][v${i}]${ex}[${label}]`);
    prev = label;
  });
  let a = '1:a';
  clips.forEach((c, i) => {
    if (!i) return;
    const label = i === clips.length - 1 ? 'aout' : `ac${i}`;
    parts.push(ovs[i] ? `[${a}][${i + 1}:a]acrossfade=d=${ovs[i].toFixed(3)}:c1=tri:c2=tri[${label}]` : `[${a}][${i + 1}:a]concat=n=2:v=0:a=1[${label}]`);
    a = label;
  });
  if (clips.length === 1) parts.push('[1:a]anull[aout]');
  args.push('-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-y', path.basename(out));
  await ffmpeg(args, 20 * 60 * 1000, tmp);
}

const assT = (x) => { const h = Math.floor(x / 3600); const m = Math.floor((x % 3600) / 60); const s = x % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };

function buildTextAss(texts, family) {
  const base = Math.round(H * 0.042);
  const styles = {
    hook: { size: Math.round(base * 1.6), outline: 8, bold: -1 },
    caption: { size: base, outline: 5, bold: -1 },
    label: { size: Math.round(base * 0.62), outline: 3, bold: -1 },
    cta: { size: Math.round(base * 1.05), outline: 6, bold: -1 },
  };
  // Alignment (numpad) and a margin that stays out of the bottom fifth and the
  // right edge, where YouTube's own interface covers the picture.
  const place = {
    top: { al: 8, mv: Math.round(H * 0.12) }, middle: { al: 5, mv: 0 },
    bottom: { al: 2, mv: Math.round(H * 0.22) }, 'lower-third': { al: 2, mv: Math.round(H * 0.3) },
  };
  const styleLines = [];
  for (const [name, st] of Object.entries(styles)) {
    for (const [pos, pl] of Object.entries(place)) {
      styleLines.push(`Style: ${name}_${pos.replace('-', '')},${family || 'Sans'},${st.size},&H00FFFFFF,&H00000000,&H99000000,${st.bold},${st.outline},2,${pl.al},70,150,${pl.mv}`);
    }
  }
  const anim = { pop: '{\\fad(90,140)\\fscx86\\fscy86\\t(0,170,\\fscx100\\fscy100)}', fade: '{\\fad(250,250)}', none: '' };
  const events = texts.map((t) => `Dialogue: 0,${assT(t.start)},${assT(t.end)},${t.style}_${t.position.replace('-', '')},,0,0,0,,${anim[t.animate] || ''}${t.text}`);
  return `[Script Info]\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n${styleLines.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}

async function finalPass({ joined, out, edl, edit, tmp, total }) {
  const font = findCaptionFont();
  const music = edl.audio.music;
  const musicAsset = music ? (edit.assets || []).find((a) => a.id === music.assetId) : null;
  const needVideo = edl.texts.length && font;
  const needAudio = !!musicAsset || edl.audio.loudnorm;
  if (!needVideo && !needAudio) { fs.copyFileSync(joined, out); return; }
  const args = ['-i', path.basename(joined)];
  if (musicAsset) args.push('-i', assetPath(edit.id, musicAsset.id));
  const parts = [];
  if (needVideo) {
    fs.writeFileSync(path.join(tmp, 'text.ass'), buildTextAss(edl.texts, font.family));
    parts.push(`[0:v]subtitles=text.ass:fontsdir=${path.dirname(font.file)}[vout]`);
  }
  let aLabel = '0:a';
  if (musicAsset) {
    const T = total.toFixed(3);
    parts.push(`[1:a]atrim=start=${music.startAt},asetpts=PTS-STARTPTS,aloop=loop=-1:size=2147483647,atrim=0:${T},volume=${music.volume},afade=t=out:st=${Math.max(0, total - 1.2).toFixed(3)}:d=1.2[m]`);
    if (music.duck) {
      parts.push('[0:a]asplit=2[va][vs]', '[m][vs]sidechaincompress=threshold=0.04:ratio=10:attack=15:release=350[md]', '[va][md]amix=inputs=2:duration=first:dropout_transition=0,volume=2[mix]');
    } else {
      parts.push('[0:a][m]amix=inputs=2:duration=first:dropout_transition=0,volume=2[mix]');
    }
    aLabel = 'mix';
  }
  if (edl.audio.loudnorm) { parts.push(`[${aLabel}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`); aLabel = 'aout'; }
  args.push('-filter_complex', parts.join(';'));
  args.push('-map', needVideo ? '[vout]' : '0:v');
  args.push('-map', aLabel.includes(':') ? aLabel : `[${aLabel}]`);
  if (needVideo) args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p');
  else args.push('-c:v', 'copy');
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', total.toFixed(3), '-movflags', '+faststart', '-y', path.basename(out));
  await ffmpeg(args, 20 * 60 * 1000, tmp);
}

export function startEditRender(editId) {
  const edit = getEdit(editId);
  if (!edit) throw new Error('unknown edit');
  if (!edit.edl?.clips?.length) throw new Error('add at least one clip first');
  if (jobs.has(editId)) throw new Error('this edit is already rendering');
  if (activeRenderIds().size) throw new Error('a video render is running right now. Wait for it to finish.');
  const other = otherJobLabel();
  if (other) throw new Error(`${other} is running right now. Wait for it to finish.`);
  const free = diskFree();
  if (free && free.freeBytes < MIN_FREE) throw new Error('the data disk is nearly full. Run storage cleanup first.');
  const job = { startedAt: Date.now(), step: 'starting' };
  jobs.set(editId, job);
  beginJob(`edit:${editId}`, 'an edit render');
  patchEdit(editId, (e) => { e.status = 'rendering'; e.step = 'starting'; e.error = null; return e; });
  runRender(editId, job).catch((err) => {
    patchEdit(editId, (e) => { e.status = 'error'; e.step = 'failed'; e.error = String(err.message || err).slice(0, 400); return e; });
    console.warn(`edit ${editId}: ${err.message}`);
  }).finally(() => { jobs.delete(editId); endJob(`edit:${editId}`); });
}

export function editStatus(editId) {
  const e = getEdit(editId);
  if (!e) return null;
  if (e.status === 'rendering' && !jobs.has(editId)) {
    return patchEdit(editId, (x) => { x.status = 'error'; x.step = 'interrupted'; x.error = 'the server restarted while rendering. Render again.'; return x; });
  }
  return e;
}

async function runRender(editId, job) {
  const edit = getEdit(editId);
  const edl = edit.edl;
  const rid = uid();
  const dir = rendersDir();
  const tmp = path.join(dir, `tmp-${rid}`);
  fs.mkdirSync(tmp, { recursive: true });
  const step = (s) => { job.step = s; patchEdit(editId, (e) => { e.step = s; return e; }); };
  try {
    const tl = timeline(edl.clips);
    const segs = [];
    for (let i = 0; i < edl.clips.length; i++) {
      step(`cutting clip ${i + 1} of ${edl.clips.length}`);
      const clip = edl.clips[i];
      const src = await resolveSource(edit, clip.src);
      if (!src) throw new Error(`clip ${i + 1} points at something that no longer exists`);
      const next = edl.clips[i + 1];
      const fadeIn = i && clip.transition.type === 'fadeblack' ? r3(clip.transition.seconds / 2) : 0;
      const fadeOut = next?.transition?.type === 'fadeblack' ? r3(next.transition.seconds / 2) : 0;
      const out = path.join(tmp, `seg-${i}.mp4`);
      await buildSegment({ clip, src, idx: i, out, fadeIn, fadeOut });
      segs.push(out);
    }
    step('joining the clips');
    const joined = path.join(tmp, 'joined.mp4');
    await joinSegments({ segs, clips: edl.clips, starts: tl.starts, total: tl.seconds, out: joined, tmp });
    step('adding text and sound');
    const finalFile = path.join(tmp, 'final.mp4');
    await finalPass({ joined, out: finalFile, edl, edit, tmp, total: tl.seconds });
    const paths = renderPaths(rid);
    fs.renameSync(finalFile, paths.mp4);
    if (edit.renderId) removeRenderFiles(edit.renderId);
    fs.writeFileSync(paths.mp4.replace(/\.mp4$/, '.json'), JSON.stringify({
      id: rid, packageId: editId, topic: edit.title, platformId: 'edit', orientation: 'portrait', status: 'done', step: 'done',
      createdAt: new Date().toISOString(), duration: Math.round(tl.seconds), edit: true,
    }, null, 2));
    patchEdit(editId, (e) => { e.status = 'done'; e.step = 'done'; e.renderId = rid; e.renderedAt = new Date().toISOString(); e.renderedSeconds = tl.seconds; return e; });
    enqueuePreview(rid);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- planning with Claude -----------------------------------------------------------

const EDL_SHAPE = `{
  "title": "short working title",
  "clips": [{"src": {"type": "media", "id": "<library id>"}, "in": 0, "out": 3, "speed": 1, "fit": "blur|crop|contain", "zoom": {"from": 1, "to": 1.1} or null, "audio": "keep|mute", "transition": {"type": "cut|fade|dissolve|slideleft|slideright|slideup|fadeblack", "seconds": 0.4}}],
  "texts": [{"text": "", "start": 0, "end": 3, "style": "hook|caption|label|cta", "position": "top|middle|bottom|lower-third", "animate": "pop|fade|none"}],
  "audio": {"music": null, "loudnorm": true},
  "notes": "one sentence on the idea of the cut"
}`;

export async function planEdit({ edit, brief, template, profile }) {
  if (!providerStatus().anthropic) throw new Error('planning needs the Claude key');
  const seconds = Math.min(90, Math.max(8, Math.round(Number(brief?.seconds) || 30)));
  const all = mediaStore.get().items.filter((i) => i.analyzed || i.alt || i.caption);
  const picked = Array.isArray(brief?.mediaIds) && brief.mediaIds.length ? all.filter((i) => brief.mediaIds.includes(i.id)) : null;
  const pool = picked || shortlistForSelection(all, `${brief?.topic || ''} ${brief?.notes || ''}`, 40);
  const catalog = [];
  for (const it of pool.slice(0, 40)) {
    const src = await resolveSource({ id: 'x', assets: [] }, { type: 'media', id: it.id });
    if (!src) continue;
    catalog.push({ id: it.id, kind: src.kind, seconds: src.kind === 'video' ? Math.round((src.duration || 0) * 10) / 10 : null, what: String(it.caption || it.alt || it.name).slice(0, 110), place: it.place || undefined, keywords: (it.keywords || []).slice(0, 5), quality: it.quality ?? undefined });
  }
  for (const a of edit.assets || []) if (a.kind !== 'audio') catalog.push({ id: a.id, assetType: 'asset', kind: a.kind, seconds: a.duration || null, what: `uploaded: ${a.name}` });
  if (!catalog.length) throw new Error('the library has no analyzed photos or videos to cut from. Import and analyze some first.');
  const tpl = template ? `\nSTRUCTURE TO FOLLOW (a pattern, not footage): ${JSON.stringify(template.structure).slice(0, 2500)}\nFollow its beat order, cut pacing, text style and hook pattern, but fill every beat with the creator's OWN footage from the catalog and her OWN true words.` : '';
  const prompt = `Plan a vertical short-form video edit of about ${seconds} seconds.

BRIEF: ${brief?.topic || '(none given: choose the strongest story the footage supports)'}
${brief?.notes ? `NOTES: ${brief.notes}\n` : ''}STYLE: ${brief?.style || 'clean, quick, story-led'}${tpl}

CATALOG (the ONLY clips you may use; ids must match exactly):
${JSON.stringify(catalog)}

RULES
- Use each source at most once. Videos: pick in/out inside the clip's seconds, 1 to 4 seconds each for short-form pacing (or as the structure says). Photos: out is the display time, 1.5 to 3 seconds, and a slow push (zoom from 1 to 1.08 or so) on most.
- The first clip is the strongest image. The first text is the hook: 8 words or fewer, specific and true to the footage, in the "hook" style at the top, starting at 0.
- Text lines name real places and facts only from the catalog descriptions and brief. Never invent a fact. One line per beat, 7 words or fewer, none over a face. End with a short call to save or send in the "cta" style.
- Transitions: mostly cut; use a quick fade or slide only where the scene changes. Mute clip audio unless the original sound matters.
- Never use em dashes or en dashes. Never say anything negative about, or compare against, anyone or anything in the travel industry. Honor the prohibition list in the context.
- The total of the timeline (clip lengths minus transition overlaps) must be about ${seconds} seconds.

Respond with ONLY this JSON shape (asset clips use {"type":"asset","id":...} as src):
${EDL_SHAPE}
Never put a double quote character inside a text value; use an apostrophe.`;
  const system = masterContext(profile, {});
  const run = async (extra = '') => claudeJson({ system, usageBucket: 'generate', maxTokens: 4000, messages: [{ role: 'user', content: prompt + extra }] });
  let raw = await run();
  let edl = await sanitizeEdl(raw, edit);
  const issueOf = (e) => copyIssues({ title: e.texts.map((t) => t.text).join('\n') }, profile);
  let issues = issueOf(edl);
  if (issues.length) {
    raw = await run(`\n\nFIX THESE PROBLEMS FROM THE LAST ATTEMPT: ${issues.join(' ')}`);
    edl = await sanitizeEdl(raw, edit);
    issues = issueOf(edl);
  }
  if (!edl.clips.length) throw new Error('the plan did not use any clips from your library. Try again, or pick the media by hand.');
  return { edl, notes: dashless(raw.notes || '').slice(0, 300), issues };
}

export async function applyPlan(editId, brief, template) {
  const edit = getEdit(editId);
  if (!edit) throw new Error('unknown edit');
  const profile = stateStore.get().profile;
  const { edl, notes, issues } = await planEdit({ edit, brief, template, profile });
  return patchEdit(editId, (e) => {
    e.edl = { ...edl, audio: { ...edl.audio, music: e.edl?.audio?.music || null } };
    e.brief = brief;
    e.templateId = template?.id || null;
    e.planNotes = notes;
    e.planIssues = issues;
    if (brief.topic && (!e.title || e.title === 'New edit')) e.title = dashless(brief.topic).slice(0, 100);
    e.updatedAt = new Date().toISOString();
    e.status = 'draft';
    return e;
  });
}

// ---- social copy for a finished edit ----------------------------------------------------------

export async function writeSocialCopy(editId) {
  const edit = getEdit(editId);
  if (!edit) throw new Error('unknown edit');
  if (!providerStatus().anthropic) throw new Error('captions need the Claude key');
  const profile = stateStore.get().profile;
  const texts = (edit.edl?.texts || []).map((t) => t.text).join(' | ');
  const run = (extra = '') => claudeJson({
    system: masterContext(profile, {}), usageBucket: 'generate', maxTokens: 1800,
    messages: [{ role: 'user', content: `Write native captions for this finished vertical video so it can be posted natively on Instagram, Facebook and TikTok.

VIDEO: ${edit.title}. ${edit.planNotes || ''}
ON-SCREEN TEXT IN ORDER: ${texts || '(none)'}
BRIEF: ${edit.brief?.topic || ''} ${edit.brief?.notes || ''}

Rules: only facts from the above and the context; the first 125 characters of each caption carry the idea; name the place and the creator naturally for search; one call to action each (save, send, or follow); Instagram hashtags: 5 at most, specific; never use em dashes or en dashes; never criticize or compare against anyone or anything in the travel industry. audio_note describes the mood and tempo of the trending sound to search for in the app and never names a song or artist.${extra}
Respond with ONLY JSON: {"instagram_reel": {"caption": "", "hashtags": "", "alt_text": "under 125 characters", "location_tag": "a real place to tag or empty", "audio_note": ""}, "facebook_reel": {"caption": "", "hashtags": ""}, "tiktok": {"caption": "", "hashtags": ""}}. Never put a double quote inside a value.` }],
  });
  let out = await run();
  const flat = (o) => Object.values(o || {}).flatMap((v) => Object.values(v || {})).join('\n');
  let issues = copyIssues({ title: flat(out) }, profile);
  if (issues.length) { out = await run(`\nFIX THESE PROBLEMS FROM THE LAST ATTEMPT: ${issues.join(' ')}`); issues = copyIssues({ title: flat(out) }, profile); }
  const clean = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, dashless(v).slice(0, 2200)]));
  const social = { at: new Date().toISOString(), issues, instagram_reel: clean(out.instagram_reel), facebook_reel: clean(out.facebook_reel), tiktok: clean(out.tiktok) };
  return patchEdit(editId, (e) => { e.social = social; return e; });
}

// ---- send a finished edit down the YouTube Shorts pipeline ------------------------------------------

export function sendToShort(editId, opts = {}) {
  const edit = getEdit(editId);
  if (!edit?.renderId) throw new Error('render the edit first');
  const mp4 = renderPaths(edit.renderId).mp4;
  if (!fs.existsSync(mp4)) throw new Error('the rendered file is gone. Render again.');
  const pkg = createShortDraft({ name: `${edit.title}.mp4`, size: fs.statSync(mp4).size, topic: edit.title, profile: stateStore.get().profile });
  const dest = path.join(rendersDir(), `${pkg.short.renderId}.source`);
  fs.copyFileSync(mp4, dest);
  markUploaded(pkg.id, fs.statSync(dest).size, null);
  startShortProcess(pkg.id, { audio: 'keep', normalize: false, fit: 'blur', transcribe: true, keepSource: false, caption: edit.social?.instagram_reel?.caption || '', notes: edit.planNotes || '', tripId: 'none', ...opts }, 'full');
  return pkg.id;
}
