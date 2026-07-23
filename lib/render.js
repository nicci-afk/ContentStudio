// Auto-Produce: renders finished platform videos on the server — the
// package's AI-selected library images as slow-zoom b-roll, ElevenLabs
// narration in the creator's cloned voice, HeyGen avatar sections (the open,
// or every on-camera beat the script calls for), sized per platform, with an
// SRT caption file generated alongside.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { uid, readMediaFile, mediaPath, workspaceDir, mediaStore, packageStore } from './store.js';
import { elevenTts, elevenTtsTimed, heygenGenerate, heygenStatus, providerStatus, claudeJson } from './providers.js';
import { PLATFORMS } from './platforms.js';
import { buildJsonLd, scorePackage } from './visibility.js';
import { diskFree } from './storage.js';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegInstaller.path;

function findCaptionFont() {
  const preferred = [
    ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', 'Liberation Sans'],
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'DejaVu Sans'],
  ];
  for (const [file, family] of preferred) {
    if (fs.existsSync(file)) return { file, family };
  }
  for (const root of ['/usr/share/fonts', '/usr/local/share/fonts']) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    let fallback = null;
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(p);
        else if (/\.(ttf|otf)$/i.test(entry.name)) {
          if (/bold/i.test(entry.name) && !/italic|oblique/i.test(entry.name)) return { file: p, family: null };
          fallback = fallback || { file: p, family: null };
        }
      }
    }
    if (fallback) return fallback;
  }
  return null;
}

const jobs = new Map();

function rendersDir() {
  const dir = path.join(workspaceDir(), 'renders');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ffmpeg(args, timeoutMs = 30 * 60 * 1000, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-600)}`));
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function probeDuration(file) {
  try {
    await ffmpeg(['-i', file, '-f', 'null', '-']);
  } catch { /* duration still printed for bad output spec */ }
  const stderr = await new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let out = '';
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('close', () => resolve(out));
  });
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) throw new Error('could not read media duration');
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// Spoken-word cleaning. Bracketed cues, markdown, and visual direction
// lines disappear entirely. Speech labels ("HOOK:", "CTA (spoken):")
// lose the label but keep their sentence, since that text is meant to be
// read aloud. Parenthetical stage directions ("(spoken, slower)") never
// reach the voice.
const DIRECTION_LINE = /^[ \t]*(CUT|SCENE|BEAT|SHOT|B[ -]?ROLL|VISUAL|ON[ -]?SCREEN(?:[ \t]*TEXT)?|TEXT[ \t]+OVERLAY|OVERLAY|TEXT|COVER|CAPTION|AUDIO|SFX|MUSIC|SOUND|LOOP|TRANSITION|TALKING[ -]?HEAD|ON[ -]?CAMERA|A[ -]?ROLL)[ \t]*(\([^)]*\))?[ \t]*[:\-].*$/gim;
const SPEECH_LABEL = /^[ \t]*(HOOK|CTA|PROMISE|PAYOFF|ANSWER|AUTHORITY[ \t]*BEAT|PERSONALITY(?:[ \t]*MOMENT)?|VO|VOICE[ -]?OVER|NARRATION)[ \t]*(\([^)]*\))?[ \t]*[:\-][ \t]*/gim;

export function cleanScriptForSpeech(raw) {
  return String(raw || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/\*\*?|__|`/g, '')
    .replace(DIRECTION_LINE, ' ')
    .replace(SPEECH_LABEL, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 9000);
}

// Script sections: generated long-form scripts alternate on-camera beats
// ("[ON CAMERA]", "[TALKING HEAD: ...]") with footage beats ("[B-ROLL: ...]").
// This splits the script into that ordered sequence so on-camera sections can
// render through the creator's avatar. Scripts without on-camera markers come
// back as a single b-roll section, which keeps the classic pipeline.
const AVATAR_CUE = /\[[^\]]*\b(?:talking[ -]?head|on[ -]?camera|to[ -]?camera|a[ -]?roll|piece[ -]?to[ -]?camera|avatar)\b[^\]]*\]/i;
const BROLL_CUE = /\[[^\]]*\bb[ -]?roll\b[^\]]*\]/i;
const AVATAR_LINE = /^\s*(?:TALKING[ -]?HEAD|ON[ -]?CAMERA|A[ -]?ROLL)\s*[:\-]/i;
const BROLL_LINE = /^\s*(?:B[ -]?ROLL|CUT|VISUAL)\s*[:\-]/i;

export function parseScriptSections(raw) {
  const sections = [];
  let mode = 'broll';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n');
    if (cleanScriptForSpeech(text)) sections.push({ mode, text });
    buf = [];
  };
  for (const line of String(raw || '').split('\n')) {
    if (AVATAR_LINE.test(line) || AVATAR_CUE.test(line)) {
      if (mode !== 'avatar') { flush(); mode = 'avatar'; }
      // Bracketed cues can share a line with speech; bare cue lines are pure direction.
      if (!AVATAR_LINE.test(line)) {
        const rest = line.replace(AVATAR_CUE, ' ');
        if (rest.trim()) buf.push(rest);
      }
      continue;
    }
    if (BROLL_LINE.test(line) || BROLL_CUE.test(line)) {
      if (mode !== 'broll') { flush(); mode = 'broll'; }
      if (!BROLL_LINE.test(line)) {
        const rest = line.replace(BROLL_CUE, ' ');
        if (rest.trim()) buf.push(rest);
      }
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

// HeyGen text inputs cap out per scene, so long on-camera sections split into
// sentence-boundary chunks that render as scenes of one video.
function chunkSentences(text, max) {
  const sentences = String(text || '').match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [String(text || '')];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { chunks.push(cur.trim()); cur = s; }
    else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [String(text || '').slice(0, max)];
}

// Caption cues: short phrase chunks, word-timed from the ElevenLabs
// alignment when available, proportional otherwise.
function buildCues(text, alignment, duration) {
  const words = text.split(' ');
  const chunks = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > 38 && current) { chunks.push(current); current = w; }
    else current = current ? `${current} ${w}` : w;
  }
  if (current) chunks.push(current);

  const starts = alignment?.character_start_times_seconds;
  if (alignment?.characters?.length && starts?.length) {
    const ends = alignment.character_end_times_seconds || starts;
    const alignedText = alignment.characters.join('');
    let cursor = 0;
    return chunks.map((chunk) => {
      const idx = alignedText.indexOf(chunk, cursor);
      const startIdx = idx >= 0 ? idx : Math.min(cursor, alignedText.length - 1);
      const endIdx = Math.min(alignedText.length - 1, startIdx + chunk.length - 1);
      cursor = endIdx + 1;
      return { text: chunk, start: starts[startIdx] ?? 0, end: Math.max((starts[startIdx] ?? 0) + 0.4, ends[endIdx] ?? duration) };
    });
  }
  const totalChars = chunks.reduce((s, c) => s + c.length, 0) || 1;
  let t = 0;
  return chunks.map((c) => {
    const span = (c.length / totalChars) * duration;
    const cue = { text: c, start: t, end: Math.min(duration, t + span) };
    t += span;
    return cue;
  });
}

function cuesToSrt(cues) {
  const fmt = (t) => {
    const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60); const ms = Math.round((t % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
}

// True chapters: every finished part of a section render carries its exact
// start offset, so the chapter list reflects the real timeline instead of
// the estimates a script draft guesses at. YouTube reads "00:00 Title"
// lines (first at 00:00, each chapter at least ten seconds, three or more
// chapters to activate the markers).
const CHAPTER_MIN_SECONDS = 10;

function fmtChapterTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${ms}` : ms;
}

function fallbackChapterTitle(speech) {
  const first = (String(speech || '').match(/[^.!?]+[.!?]?/) || [''])[0];
  let t = first.replace(/\s*[—–:;]\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (t.length > 48) {
    const cut = t.slice(0, 48);
    t = cut.slice(0, Math.max(20, cut.lastIndexOf(' ')));
  }
  return t.replace(/\s+(a|an|the|and|or|but|of|to|in|for|with|on|that)$/i, '').replace(/[,.;:!?\s]+$/, '');
}

// Sections shorter than a chapter minimum fold into their neighbor so every
// emitted chapter is long enough for YouTube to honor it.
function buildChapters(sectionsMeta, finalParts) {
  const chapters = [];
  sectionsMeta.forEach((sec, i) => {
    const speech = finalParts[i]?.speech || '';
    const last = chapters[chapters.length - 1];
    if (!last || sec.start - last.start >= CHAPTER_MIN_SECONDS) {
      chapters.push({ start: sec.start, end: sec.end, speech });
    } else {
      last.end = sec.end;
      last.speech = `${last.speech} ${speech}`.trim();
    }
  });
  while (chapters.length > 1 && chapters.at(-1).end - chapters.at(-1).start < CHAPTER_MIN_SECONDS) {
    const stub = chapters.pop();
    chapters.at(-1).end = stub.end;
    chapters.at(-1).speech = `${chapters.at(-1).speech} ${stub.speech}`.trim();
  }
  if (chapters.length) chapters[0].start = 0;
  return chapters;
}

// Chapter titles come from the section content itself: Claude writes
// keyword-rich titles when a key is configured, the first words of each
// section stand in otherwise. Doctrine holds either way: no em or en
// dashes, blocklist respected, nothing negative about any supplier,
// destination, or venue.
async function titleChapters(chapters, pkg, profile) {
  const fallbacks = chapters.map((c) => fallbackChapterTitle(c.speech) || 'Chapter');
  if (!providerStatus().anthropic) return { titles: fallbacks, source: 'fallback', error: null };
  const banned = (profile?.business?.neverMention || []).filter(Boolean);
  try {
    let titles = await claudeJson({
      system: 'You title YouTube chapters for a travel industry professional. Reply with only a JSON array of strings, one per section, in order.',
      messages: [{
        role: 'user',
        content: `Video topic: ${pkg.topic}\n\nWrite exactly ${chapters.length} chapter titles, one per section below, in order. Rules: 3 to 6 words each, keyword rich, question form where natural, no numbering, no quotes, never use em dashes or en dashes, never anything negative about any supplier, resort, hotel, cruise line, airline, tour operator, venue, or destination.${banned.length ? ` Never mention: ${banned.join(', ')}.` : ''}\n\nSections:\n${chapters.map((c, i) => `${i + 1}. ${c.speech.slice(0, 260)}`).join('\n')}`,
      }],
      maxTokens: 600,
    });
    // Models sometimes wrap the list in an object; take the first array in it.
    if (titles && !Array.isArray(titles) && typeof titles === 'object') {
      titles = Object.values(titles).find(Array.isArray) || null;
    }
    if (Array.isArray(titles) && titles.length) {
      return {
        titles: chapters.map((c, i) => {
          const t = String(titles[i] ?? '').replace(/[—–]/g, ',').replace(/["\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
          const leaked = banned.some((term) => t.toLowerCase().includes(term.toLowerCase()));
          return (!t || leaked) ? fallbacks[i] : t;
        }),
        source: 'claude',
        error: null,
      };
    }
    return { titles: fallbacks, source: 'fallback', error: 'reply held no list of titles' };
  } catch (err) {
    return { titles: fallbacks, source: 'fallback', error: String(err.message || err).slice(0, 300) };
  }
}

// The description mirrors the chapter list, so the first block of timestamp
// lines is replaced in place; a draft that never had one gets the list
// appended where YouTube still parses it.
function patchDescriptionChapters(description, chapterLines) {
  const isStamp = (l) => /^\s*\d{1,2}:\d{2}/.test(l);
  const lines = String(description || '').split('\n');
  const first = lines.findIndex(isStamp);
  if (first >= 0) {
    let last = first;
    while (last + 1 < lines.length && isStamp(lines[last + 1])) last += 1;
    lines.splice(first, last - first + 1, ...chapterLines);
    return lines.join('\n');
  }
  return `${String(description || '').trim()}\n\nChapters:\n${chapterLines.join('\n')}`.trim();
}

function buildAss({ cues, W, H, fontFamily, identity }) {
  const portrait = H > W;
  const size = Math.round(H * (portrait ? 0.042 : 0.052));
  const marginV = Math.round(H * (portrait ? 0.17 : 0.09));
  const outline = Math.max(2, Math.round(size / 11));
  const family = fontFamily || 'Sans';
  const t = (x) => {
    const h = Math.floor(x / 3600); const m = Math.floor((x % 3600) / 60); const s = x % 60;
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };
  const clean = (s) => s.replace(/[\\{}]/g, '').trim();
  const events = cues.map((c) => `Dialogue: 0,${t(c.start)},${t(c.end)},Cap,,0,0,0,,${clean(c.text)}`);
  if (identity) events.unshift(`Dialogue: 0,${t(0.4)},${t(3.8)},Ident,,0,0,0,,${clean(identity)}`);
  return `[Script Info]
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Cap,${family},${size},&H00FFFFFF,&H00000000,&H88000000,-1,${outline},1,2,60,60,${marginV}
Style: Ident,${family},${Math.round(size * 0.55)},&H00FFFFFF,&H00000000,&H88000000,-1,2,1,7,44,44,64

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}

function writeMeta(job, extra = {}) {
  try {
    fs.writeFileSync(path.join(rendersDir(), `${job.id}.json`), JSON.stringify({
      id: job.id, packageId: job.packageId, topic: job.topic, platformId: job.platformId,
      orientation: job.orientation, status: job.status, step: job.step,
      error: job.error || null, createdAt: job.createdAt, ...extra,
    }, null, 2));
  } catch { /* meta is best-effort */ }
}

// A long-form render writes several GB of intermediate segments into its
// temp folder on the same disk that stores media and finished renders, so
// refuse up front with a clear message instead of dying mid-render.
const MIN_FREE_BYTES = 1536 * 1024 * 1024;

// Delivery presets shape narration pacing: ElevenLabs stability/similarity
// plus speaking speed for the voiceover, HeyGen speech speed for the
// avatar sections. 'balanced' matches the original fixed settings so
// existing narration caches stay valid for it. 'calm' slows the read a
// touch; the creator's clone at native pace reads fast and sharp, and the
// welcoming tone lives in the slower, steadier delivery.
const DELIVERY = {
  calm: { stability: 0.78, similarity: 0.85, speed: 0.93, avatarSpeed: 0.95 },
  balanced: { stability: 0.5, similarity: 0.8, speed: 1, avatarSpeed: 1 },
  energetic: { stability: 0.32, similarity: 0.8, speed: 1.05, avatarSpeed: 1.05 },
};

// Nominal seconds per b-roll slide; short-form platforms override this
// with a faster cut via their videoSpec.
const SLOT = 5;

// Footage plan: every source appears spread out (nothing plays twice in a
// row), video sources earn slots in proportion to how much footage they
// really hold, and each reappearance of a clip advances to a fresh time
// window instead of replaying its first seconds. Stills track how often
// they have appeared so a reuse can reverse its zoom direction instead of
// repeating the identical move.
function buildFootagePlan(sources, slot = SLOT) {
  const pool = [];
  sources.forEach((s, si) => {
    const weight = s.type === 'video' ? Math.min(6, Math.max(1, Math.round((s.videoDur || 0) / slot))) : 1;
    for (let k = 0; k < weight; k++) pool.push({ s, pos: (k + 0.5) / weight + si * 1e-4 });
  });
  pool.sort((a, b) => a.pos - b.pos);
  const plan = { pool, pos: 0, last: null, cursors: new Map(), uses: new Map(), windows: new Set() };
  plan.take = (per) => {
    let entry = plan.pool[plan.pos % plan.pool.length];
    if (plan.pool.length > 1 && entry.s === plan.last) {
      plan.pos += 1;
      entry = plan.pool[plan.pos % plan.pool.length];
    }
    plan.pos += 1;
    plan.last = entry.s;
    const s = entry.s;
    const uses = (plan.uses.get(s) || 0) + 1;
    plan.uses.set(s, uses);
    let offset = 0;
    if (s.type === 'video') {
      const dur = s.videoDur || 0;
      if (dur > per) {
        const cur = plan.cursors.get(s) || { t: 0, lap: 0 };
        if (cur.t > dur - per) {
          cur.lap += 1;
          cur.t = Math.min(dur - per, (cur.lap % 2) * (per / 2));
        }
        offset = cur.t;
        cur.t += per;
        plan.cursors.set(s, cur);
      }
      plan.windows.add(`${s.mediaId}@${Math.round(offset)}`);
    }
    return { s, offset, uses };
  };
  return plan;
}

export function activeRenderIds() {
  return new Set([...jobs.values()].filter((j) => j.status === 'running').map((j) => j.id));
}

export function startRender({ pkg, profile, platformId, script, hookText, voiceId, orientation, avatar, delivery }) {
  for (const j of jobs.values()) {
    if (j.status === 'running' && j.packageId === pkg.id && j.platformId === platformId) return j.id;
  }
  const free = diskFree();
  if (free && free.freeBytes < MIN_FREE_BYTES) {
    throw new Error(`not enough disk space to render: ${Math.round(free.freeBytes / 1e6)}MB free of ${Math.round(free.totalBytes / 1e6)}MB, and a video render needs about ${Math.round(MIN_FREE_BYTES / 1e6)}MB of headroom. Clean up old renders or expand the data disk, then retry`);
  }
  const id = uid();
  const job = {
    id, packageId: pkg.id, topic: pkg.topic, platformId, orientation,
    delivery: DELIVERY[delivery] ? delivery : 'balanced',
    status: 'running', step: 'starting', error: null,
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  writeMeta(job);
  runRender(job, { pkg, profile, platformId, script, hookText, voiceId, orientation, avatar, delivery: job.delivery })
    .catch((err) => {
      job.status = 'error';
      job.error = String(err.message).slice(0, 500);
      writeMeta(job);
    });
  return id;
}

async function runRender(job, { pkg, profile, platformId, script, hookText, voiceId, orientation, avatar, delivery }) {
  const voiceStyle = DELIVERY[delivery] || DELIVERY.balanced;
  const portrait = orientation !== 'landscape';
  const [W, H] = portrait ? [1080, 1920] : [1920, 1080];
  const dir = rendersDir();
  const tmp = path.join(dir, `tmp-${job.id}`);
  fs.mkdirSync(tmp, { recursive: true });
  const status = providerStatus();

  try {
    const speechWhole = cleanScriptForSpeech(script);
    if (!speechWhole) throw new Error('no narratable script text in this asset');
    const silent = !(voiceId && status.elevenlabs);

    // Narration factory (cloned voice, word-timed when possible) — or timed
    // silence for previews without a key. Narration is cached per
    // voice+script so failed encodes and retries never re-spend credits.
    const cacheDir = path.join(dir, 'narration-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    let narrIdx = 0;
    const makeNarration = async (speech) => {
      const out = path.join(tmp, `narration-${narrIdx++}.${silent ? 'm4a' : 'mp3'}`);
      let alignment = null;
      if (silent) {
        const silenceDur = Math.min(600, Math.max(4, Math.round(speech.split(' ').length / 2.6)));
        await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(silenceDur), '-c:a', 'aac', '-y', out]);
      } else {
        const styleKey = voiceStyle === DELIVERY.balanced ? '' : `${voiceStyle.stability}|${voiceStyle.similarity}|${voiceStyle.speed || 1}|`;
        const cacheKey = crypto.createHash('sha256').update(`${voiceId}|${styleKey}${speech}`).digest('hex').slice(0, 24);
        const cachedAudio = path.join(cacheDir, `${cacheKey}.mp3`);
        const cachedAlign = path.join(cacheDir, `${cacheKey}.align.json`);
        if (fs.existsSync(cachedAudio)) {
          fs.copyFileSync(cachedAudio, out);
          try { alignment = JSON.parse(fs.readFileSync(cachedAlign, 'utf8')); } catch { alignment = null; }
        } else {
          const timed = await elevenTtsTimed({ voiceId, text: speech, stability: voiceStyle.stability, similarity: voiceStyle.similarity, speed: voiceStyle.speed }).catch(() => null);
          if (timed) {
            fs.writeFileSync(out, timed.audio);
            alignment = timed.alignment;
            try { fs.writeFileSync(cachedAlign, JSON.stringify(alignment)); } catch { /* cache only */ }
          } else {
            fs.writeFileSync(out, await elevenTts({ voiceId, text: speech, stability: voiceStyle.stability, similarity: voiceStyle.similarity, speed: voiceStyle.speed }));
          }
          try { fs.copyFileSync(out, cachedAudio); } catch { /* cache only */ }
        }
      }
      const duration = await probeDuration(out);
      return { file: out, alignment, duration };
    };

    // Collect the package's selected media at its strongest stored form:
    // the real video file when the original was uploaded at import, a still
    // frame otherwise. A package without attached media falls back to the
    // strongest assets in the whole library — a render should never dead-end
    // while media exists.
    job.step = 'gathering your media';
    const records = mediaStore.get().items || [];
    const sources = [];
    const collect = (ids) => {
      for (const mediaId of ids) {
        const rec = records.find((m) => m.id === mediaId);
        const originalFile = rec?.kind === 'video' ? mediaPath(mediaId, 'original') : null;
        if (originalFile && fs.existsSync(originalFile)) {
          sources.push({ type: 'video', file: originalFile, mediaId });
          continue;
        }
        const buf = readMediaFile(mediaId, 'render') || readMediaFile(mediaId, 'analysis') || readMediaFile(mediaId, 'thumb');
        if (buf) {
          const file = path.join(tmp, `img-${sources.length}.jpg`);
          fs.writeFileSync(file, buf);
          sources.push({ type: 'image', file, mediaId });
        }
      }
    };
    collect(pkg.mediaIds || []);
    let mediaFallback = false;
    if (!sources.length) {
      const ranked = records
        .filter((m) => m.kind === 'image' || m.kind === 'video')
        .sort((a, b) => ((b.quality || 0) + (b.analyzed ? 2 : 0)) - ((a.quality || 0) + (a.analyzed ? 2 : 0)))
        .slice(0, 8);
      collect(ranked.map((m) => m.id));
      mediaFallback = sources.length > 0;
    }
    if (!sources.length) throw new Error('your media library is empty. Import photos in the Library first');

    // Blur-fill layout: the whole image stays visible, centered over a
    // blurred copy of itself that fills the frame. When aspect ratios match
    // the foreground covers everything; when a vertical phone shot lands in
    // a landscape video the sides fill softly instead of crop-zooming into
    // the middle of the picture.
    const BLUR_FILL =
      `split=2[bg][fg];` +
      `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=24,eq=brightness=-0.08[bgv];` +
      `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgv];` +
      `[bgv][fgv]overlay=(W-w)/2:(H-h)/2`;

    // Stills composite once into a full frame, then the cheap zoompan pass
    // animates that frame — the blur never runs per output frame.
    job.step = 'laying out your imagery';
    for (const s of sources) {
      if (s.type !== 'image') continue;
      const composed = `${s.file.replace(/\.jpg$/, '')}-fill.png`;
      await ffmpeg([
        '-i', s.file,
        '-filter_complex', `[0:v]${BLUR_FILL}[v]`,
        '-map', '[v]', '-frames:v', '1', '-y', composed,
      ]);
      s.file = composed;
    }
    job.step = 'measuring your footage';
    for (const s of sources) {
      if (s.type !== 'video') continue;
      try { s.videoDur = await probeDuration(s.file); } catch { s.videoDur = 0; }
    }
    // Platform video guardrails: short-form platforms cut faster and cap
    // total runtime at the length their recommendation systems favor.
    const spec = PLATFORMS[platformId]?.videoSpec || {};
    const slot = spec.slot || SLOT;
    const wordsPerSecond = 2.6 * (voiceStyle.speed || 1);
    let trimmedToFit = 0;
    const capSpeech = (speech, maxSec) => {
      if (!maxSec) return speech;
      const words = speech.split(' ');
      const maxWords = Math.floor(maxSec * wordsPerSecond);
      if (words.length <= maxWords) return speech;
      let cut = words.slice(0, maxWords).join(' ');
      const lastEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      if (lastEnd > cut.length * 0.5) cut = cut.slice(0, lastEnd + 1);
      trimmedToFit = maxSec;
      return cut.trim();
    };

    const plan = buildFootagePlan(sources, slot);
    const usedClips = new Set();

    // Slide segments: each slide encodes as its own small segment, then the
    // segments concat losslessly — bounded memory however long the video.
    // Video sources play for real (muted, a fresh window of the clip each
    // time); stills get the slow zoom. Identical encode settings keep the
    // lossless concat valid across every part of the final video.
    const SEG_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-video_track_timescale', '12800', '-an'];
    // A still's second appearance zooms out instead of in, so a reused
    // photo reads as a fresh shot instead of an exact repeat.
    const ZOOM_IN = "min(zoom+0.0008,1.15)";
    const ZOOM_OUT = "if(lte(zoom,1.0),1.15,max(1.001,zoom-0.0008))";
    const encodeStill = (file, per, seg, zoomOut) => ffmpeg([
      '-loop', '1', '-t', per.toFixed(3), '-i', file,
      '-filter_complex',
      `[0:v]fps=25,zoompan=z='${zoomOut ? ZOOM_OUT : ZOOM_IN}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=25,setsar=1[v]`,
      '-map', '[v]', ...SEG_ENCODE, '-y', seg,
    ]);
    const encodeSlide = async (slide, per, seg) => {
      if (slide.s.type === 'video') {
        try {
          await ffmpeg([
            '-stream_loop', '-1',
            ...(slide.offset > 0.05 ? ['-ss', slide.offset.toFixed(2)] : []),
            '-i', slide.s.file,
            '-t', per.toFixed(3),
            '-filter_complex', `[0:v]${BLUR_FILL},fps=25,setsar=1[v]`,
            '-map', '[v]', ...SEG_ENCODE, '-y', seg,
          ]);
          usedClips.add(slide.s.mediaId);
          return;
        } catch {
          // An undecodable upload falls back to its stored poster frame so
          // the render still completes.
          const buf = readMediaFile(slide.s.mediaId, 'render') || readMediaFile(slide.s.mediaId, 'analysis') || readMediaFile(slide.s.mediaId, 'thumb');
          if (!buf) throw new Error(`could not decode video "${path.basename(slide.s.file)}" and no preview frame is stored for it`);
          const poster = `${seg}.jpg`;
          fs.writeFileSync(poster, buf);
          const composed = `${seg}-fill.png`;
          await ffmpeg(['-i', poster, '-filter_complex', `[0:v]${BLUR_FILL}[v]`, '-map', '[v]', '-frames:v', '1', '-y', composed]);
          await encodeStill(composed, per, seg, slide.uses % 2 === 0);
          return;
        }
      }
      await encodeStill(slide.s.file, per, seg, slide.uses % 2 === 0);
    };

    const font = findCaptionFont();
    const biz = profile?.business || {};
    const identityLine = [biz.person?.name, biz.name].filter(Boolean).join(' · ');
    let identityPending = true;
    let anyCaptions = false;
    let anyTimed = false;

    // Burn caption cues into a finished part; returns the captioned file,
    // or the original untouched when no font exists or the burn fails
    // (the SRT still ships either way).
    const burnCaptions = async (file, cues, tag) => {
      if (!font) return file;
      const assFile = `captions-${tag}.ass`;
      fs.writeFileSync(path.join(tmp, assFile),
        buildAss({ cues, W, H, fontFamily: font.family, identity: identityPending ? identityLine : null }));
      const capped = path.join(tmp, `part-${tag}-cap.mp4`);
      try {
        await ffmpeg([
          '-i', path.basename(file),
          '-vf', `subtitles=${assFile}:fontsdir=${path.dirname(font.file)}`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-video_track_timescale', '12800',
          '-c:a', 'copy', '-movflags', '+faststart', '-y', path.basename(capped),
        ], 30 * 60 * 1000, tmp);
        identityPending = false;
        anyCaptions = true;
        return capped;
      } catch {
        return file;
      }
    };

    // A b-roll part: narration under spread-out footage, captions burned.
    const buildBrollPart = async (speech, tag) => {
      const { file: narration, alignment, duration } = await makeNarration(speech);
      const slideCount = Math.max(1, Math.min(60, Math.round(duration / slot))) || 1;
      const per = duration / slideCount;
      const segs = [];
      for (let i = 0; i < slideCount; i++) {
        job.step = `assembling b-roll (${tag}: ${i + 1}/${slideCount})`;
        const seg = path.join(tmp, `seg-${tag}-${i}.mp4`);
        await encodeSlide(plan.take(per), per, seg);
        segs.push(seg);
      }
      job.step = `laying narration under b-roll (${tag})`;
      const listFile = path.join(tmp, `segs-${tag}.txt`);
      fs.writeFileSync(listFile, segs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
      const muxed = path.join(tmp, `part-${tag}.mp4`);
      await ffmpeg([
        '-f', 'concat', '-safe', '0', '-i', listFile, '-i', narration,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
        '-shortest', '-movflags', '+faststart', '-y', muxed,
      ]);
      const cues = buildCues(speech, alignment, duration);
      let file = muxed;
      if (!silent) {
        job.step = `burning captions (${tag})`;
        file = await burnCaptions(muxed, cues, tag);
      }
      if (alignment) anyTimed = true;
      return { kind: 'broll', file, duration, cues };
    };

    // An avatar part: HeyGen-rendered on-camera section, normalized to the
    // exact encode every other part uses so the final concat stays lossless.
    const normalizeAvatarPart = async (rawFile, tag) => {
      const out = path.join(tmp, `part-${tag}.mp4`);
      await ffmpeg([
        '-i', rawFile,
        '-filter_complex',
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=25,setsar=1[v];` +
        '[0:a]aresample=44100,aformat=channel_layouts=stereo[a]',
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-video_track_timescale', '12800',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
        '-movflags', '+faststart', '-y', out,
      ]);
      return out;
    };
    const downloadTo = async (url, file) => {
      const download = await fetch(url);
      if (!download.ok || !download.body) throw new Error('HeyGen video download failed');
      const { Readable } = await import('node:stream');
      const { pipeline } = await import('node:stream/promises');
      await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(file));
    };
    const concatCopy = async (files, out) => {
      const list = `${out}.txt`;
      fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-y', out]);
      return out;
    };

    // A cut-out avatar part: HeyGen's transparent webm (VP9 alpha)
    // composites the creator over the same spread-out footage bed the
    // b-roll uses, so on-camera beats keep the audience inside the trip
    // instead of cutting to a blank room. Estimated caption cues burn in
    // so captions never drop out during on-camera beats.
    const buildCutoutPart = async (p, files) => {
      const pieces = [];
      for (let ci = 0; ci < files.length; ci++) {
        const src = files[ci];
        const dur = await probeDuration(src);
        const slideCount = Math.max(1, Math.min(60, Math.round(dur / slot)));
        const per = dur / slideCount;
        const segs = [];
        for (let i = 0; i < slideCount; i++) {
          job.step = `laying footage behind you (${p.tag}: ${i + 1}/${slideCount})`;
          const seg = path.join(tmp, `cutseg-${p.tag}-${ci}-${i}.mp4`);
          await encodeSlide(plan.take(per), per, seg);
          segs.push(seg);
        }
        const bedList = path.join(tmp, `cutbed-${p.tag}-${ci}.txt`);
        fs.writeFileSync(bedList, segs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
        const piece = path.join(tmp, `cutpiece-${p.tag}-${ci}.mp4`);
        await ffmpeg([
          '-f', 'concat', '-safe', '0', '-i', bedList,
          '-c:v', 'libvpx-vp9', '-i', src,
          '-filter_complex',
          `[1:v]scale=-2:${H}[person];` +
          `[0:v][person]overlay=x=${portrait ? '(W-w)/2' : 'W*0.66-w/2'}:y=H-h:shortest=1,fps=25,setsar=1[v];` +
          '[1:a]aresample=44100,aformat=channel_layouts=stereo[a]',
          '-map', '[v]', '-map', '[a]',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-video_track_timescale', '12800',
          '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
          '-shortest', '-movflags', '+faststart', '-y', piece,
        ]);
        pieces.push(piece);
      }
      let file = pieces.length === 1 ? pieces[0] : await concatCopy(pieces, path.join(tmp, `part-${p.tag}-cut.mp4`));
      const duration = await probeDuration(file);
      const cues = buildCues(p.speech, null, duration);
      job.step = `burning captions (${p.tag})`;
      file = await burnCaptions(file, cues, `${p.tag}-cut`);
      return { file, duration, cues };
    };

    // Section plan. Avatar scope 'sections' renders every on-camera beat of
    // the script through the avatar; the default 'open' keeps the classic
    // hook-only avatar open, and scripts without markers fall back to it.
    const avatarReady = !!(avatar?.avatarId && avatar?.voiceId && status.heygen);
    const sections = parseScriptSections(script);
    let onCamera = 0;
    for (const s of sections) {
      if (s.mode !== 'avatar') continue;
      onCamera += 1;
      if (onCamera > 6) s.mode = 'broll'; // cost guard: fold extras into narration
    }
    const sectionsMode = avatarReady && avatar?.scope === 'sections' && sections.some((s) => s.mode === 'avatar');
    // Scope 'all': the avatar carries the entire video in one voice, the
    // short-form default, since a Reel that switches voices mid-stream
    // reads as two different people.
    const allMode = avatarReady && avatar?.scope === 'all' && !sectionsMode;

    const parts = []; // ordered: {kind, tag, text?, speech?}
    if (allMode) {
      parts.push({ kind: 'avatar', tag: 'all', speech: capSpeech(speechWhole, spec.maxSeconds || 0) });
    } else if (sectionsMode) {
      let budget = 12000;
      for (const s of sections) {
        s.speech = cleanScriptForSpeech(s.text).slice(0, Math.max(0, budget));
        budget -= s.speech.length;
      }
      const spoken = sections.filter((s) => s.speech);
      if (spoken[0]?.mode !== 'avatar') {
        // Script opens on b-roll, so the classic hook open still fronts it.
        const hook = cleanScriptForSpeech(hookText).slice(0, 600) || speechWhole.slice(0, 300);
        if (hook) parts.push({ kind: 'avatar', tag: 'open', speech: hook });
      }
      spoken.forEach((s, i) => parts.push({ kind: s.mode, tag: `s${i + 1}`, speech: s.speech }));
    } else {
      let bodyBudget = spec.maxSeconds || 0;
      if (avatarReady) {
        const hook = cleanScriptForSpeech(hookText).slice(0, 600) || speechWhole.slice(0, 300);
        if (hook) {
          parts.push({ kind: 'avatar', tag: 'open', speech: hook });
          if (bodyBudget) bodyBudget = Math.max(10, bodyBudget - Math.round(hook.split(' ').length / wordsPerSecond));
        }
      }
      parts.push({ kind: 'broll', tag: 'main', speech: capSpeech(speechWhole, bodyBudget) });
    }

    // 1. Submit every avatar section to HeyGen up front so they render in
    // parallel on HeyGen's side while the b-roll assembles here. The v3 API
    // takes one script per video, so a long section submits as consecutive
    // chunk videos that concat back into a single part. Cut-out style asks
    // for the transparent webm output so the creator composites over
    // footage instead of standing in a blank frame.
    const cutout = avatar?.style === 'cutout';
    const avatarParts = parts.filter((p) => p.kind === 'avatar');
    let avatarFailed = 0;
    if (avatarParts.length) job.step = 'requesting avatar sections (HeyGen)';
    for (const p of avatarParts) {
      try {
        p.chunks = chunkSentences(p.speech, 1400).slice(0, 5).map((text) => ({ text }));
        for (const c of p.chunks) {
          const { videoId } = await heygenGenerate({
            avatarId: avatar.avatarId, avatarKind: avatar.avatarKind, voiceId: avatar.voiceId,
            text: c.text,
            title: `${pkg.topic} · ${platformId} (${p.tag})`,
            orientation: portrait ? 'portrait' : 'landscape',
            speed: voiceStyle.avatarSpeed,
            transparent: cutout,
          });
          c.videoId = videoId;
        }
      } catch {
        p.chunks = null;
      }
    }

    // 2. Assemble all b-roll parts while HeyGen renders.
    for (const p of parts) {
      if (p.kind !== 'broll') continue;
      Object.assign(p, await buildBrollPart(p.speech, p.tag));
    }

    // 3. Collect avatar renders; a failed or timed-out section degrades to
    // narrated b-roll instead of sinking a long render.
    const pending = avatarParts.filter((p) => p.chunks?.every((c) => c.videoId));
    const deadline = Date.now() + 25 * 60 * 1000;
    while (pending.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 8000));
      job.step = `rendering your avatar (HeyGen): ${pending.length} section${pending.length === 1 ? '' : 's'} in progress`;
      for (const p of [...pending]) {
        try {
          let ready = true;
          for (const c of p.chunks) {
            if (c.url) continue;
            const s = await heygenStatus(c.videoId);
            if (s.status === 'completed' && s.url) c.url = s.url;
            else if (s.status === 'failed') { p.dead = true; throw new Error(s.error || 'avatar section failed'); }
            else ready = false;
          }
          if (!ready) continue;
          job.step = `downloading avatar section (${p.tag})`;
          const files = [];
          for (let ci = 0; ci < p.chunks.length; ci++) {
            const f = path.join(tmp, `avatar-${p.tag}-${ci}.${cutout ? 'webm' : 'mp4'}`);
            await downloadTo(p.chunks[ci].url, f);
            files.push(f);
          }
          if (cutout) {
            Object.assign(p, await buildCutoutPart(p, files));
          } else if (files.length === 1) {
            p.file = await normalizeAvatarPart(files[0], p.tag);
            p.duration = await probeDuration(p.file);
            p.cues = buildCues(p.speech, null, p.duration);
          } else {
            const normed = [];
            for (let ci = 0; ci < files.length; ci++) normed.push(await normalizeAvatarPart(files[ci], `${p.tag}-n${ci}`));
            p.file = await concatCopy(normed, path.join(tmp, `part-${p.tag}.mp4`));
            p.duration = await probeDuration(p.file);
            p.cues = buildCues(p.speech, null, p.duration);
          }
          pending.splice(pending.indexOf(p), 1);
        } catch {
          // Transient errors retry next tick; a hard HeyGen failure or a
          // section that keeps failing to download or composite gives up.
          p.attempts = (p.attempts || 0) + 1;
          if (p.dead || p.attempts >= 3) {
            p.chunks = null;
            p.file = undefined;
            pending.splice(pending.indexOf(p), 1);
          }
        }
      }
    }
    for (const p of avatarParts) {
      if (p.file) continue;
      avatarFailed += 1;
      if (p.tag === 'open') continue; // the open has no b-roll fallback; skip it
      Object.assign(p, await buildBrollPart(p.speech, `${p.tag}-fb`), { kind: 'broll' });
    }
    const finalParts = parts.filter((p) => p.file);
    if (!finalParts.length) throw new Error('no video sections could be produced');
    const avatarDone = parts.filter((p) => p.kind === 'avatar' && p.file).length;

    // 4. Stitch the parts in script order. Every part shares one encode
    // profile, so the concat is lossless; a re-encode concat is the safety
    // net if a container ever disagrees.
    job.step = 'stitching sections together';
    const outFile = path.join(dir, `${job.id}.mp4`);
    const metaArgs = [
      '-metadata', `title=${pkg.topic}`,
      '-metadata', `artist=${[biz.person?.name, biz.name].filter(Boolean).join(', ') || 'ContentStudio'}`,
      '-metadata', `comment=${(pkg.keywords || []).slice(0, 12).join(', ')}`,
    ];
    if (finalParts.length === 1) {
      await ffmpeg(['-i', finalParts[0].file, '-map', '0', '-c', 'copy', '-movflags', '+faststart', ...metaArgs, '-y', outFile]);
    } else {
      const partsList = path.join(tmp, 'parts.txt');
      fs.writeFileSync(partsList, finalParts.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n'));
      try {
        await ffmpeg(['-f', 'concat', '-safe', '0', '-i', partsList, '-map', '0', '-c', 'copy', '-movflags', '+faststart', ...metaArgs, '-y', outFile]);
      } catch {
        const inputs = finalParts.flatMap((p) => ['-i', p.file]);
        const fc = finalParts.map((_, i) => `[${i}:v]fps=25,setsar=1[v${i}];[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}];`).join('')
          + finalParts.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${finalParts.length}:v=1:a=1[v][a]`;
        await ffmpeg([...inputs, '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', ...metaArgs, '-y', outFile]);
      }
    }

    // 5. One SRT across the full timeline (avatar sections carry estimated
    // timings; b-roll sections carry the word-timed cues). The same pass
    // records each part's exact start offset for chapters and JSON-LD.
    job.step = 'finalizing';
    let offset = 0;
    const allCues = [];
    const sectionsMeta = [];
    for (const p of finalParts) {
      const dur = p.duration ?? await probeDuration(p.file);
      for (const c of (p.cues || [])) allCues.push({ text: c.text, start: c.start + offset, end: c.end + offset });
      sectionsMeta.push({ tag: p.tag, kind: p.kind, start: Math.round(offset), end: Math.round(offset + dur) });
      offset += dur;
    }
    fs.writeFileSync(path.join(dir, `${job.id}.srt`), cuesToSrt(allCues));
    const finalDuration = Math.round(await probeDuration(outFile));

    let chapters = [];
    let titled = null;
    if (finalParts.length > 1) {
      job.step = 'writing chapters';
      const folded = buildChapters(sectionsMeta, finalParts);
      titled = await titleChapters(folded, pkg, profile);
      chapters = folded.map((c, i) => ({ start: c.start, end: c.end, title: titled.titles[i] }));
    }
    const chapterLines = chapters.map((c) => `${fmtChapterTime(c.start)} ${c.title}`);

    // A finished render teaches its package the truth: real chapter lines
    // land in the chapters and description fields (three or more, YouTube's
    // minimum for chapter markers), and the section offsets feed the
    // VideoObject JSON-LD (duration, hasPart Clips, SeekToAction).
    let chaptersApplied = false;
    const hasChaptersField = (PLATFORMS[platformId]?.fields || []).some((f) => f.key === 'chapters');
    packageStore.update((s) => ({
      items: s.items.map((p) => {
        if (p.id !== pkg.id) return p;
        p.renders = {
          ...(p.renders || {}),
          [platformId]: {
            renderId: job.id, renderedAt: new Date().toISOString(),
            duration: finalDuration, orientation,
            sections: sectionsMeta, chapters,
          },
        };
        const fields = p.platforms?.[platformId]?.fields;
        if (fields && hasChaptersField && chapterLines.length >= 3) {
          fields.chapters = chapterLines.join('\n');
          const desc = Array.isArray(fields.description) ? fields.description.join('\n') : fields.description;
          fields.description = patchDescriptionChapters(desc, chapterLines);
          chaptersApplied = true;
        }
        p.jsonld = buildJsonLd(p, profile);
        p.visibility = scorePackage(p, profile);
        return p;
      }),
    }));

    job.silent = silent;
    job.captions = anyCaptions;
    job.duration = finalDuration;
    job.step = 'done';
    job.status = 'done';
    job.videoClips = usedClips.size;
    job.clipWindows = plan.windows.size;
    job.sections = sectionsMeta;
    job.chapters = chapterLines;
    job.chaptersApplied = chaptersApplied;
    job.avatarStyle = avatarDone > 0 ? (cutout ? 'cutout' : 'full') : undefined;
    job.avatarScope = avatarDone > 0 ? (avatar?.scope || 'open') : undefined;
    job.trimmedToFit = trimmedToFit || undefined;
    writeMeta(job, {
      silent, captions: anyCaptions, timed: anyTimed, mediaFallback,
      avatar: avatarDone > 0,
      avatarSections: sectionsMode ? avatarDone : 0,
      avatarFailed: avatarFailed || undefined,
      avatarStyle: job.avatarStyle,
      avatarScope: job.avatarScope,
      videoClips: usedClips.size,
      clipWindows: plan.windows.size,
      duration: finalDuration,
      trimmedToFit: job.trimmedToFit,
      sections: sectionsMeta,
      chapters: chapterLines,
      chaptersApplied,
      chapterTitles: titled ? titled.source : undefined,
      chapterTitleError: titled?.error || undefined,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readMeta(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!meta.status && meta.duration != null) meta.status = 'done';
    if (meta.status === 'running' && !jobs.has(meta.id)) {
      meta.status = 'interrupted';
      meta.error = 'the server restarted mid-render. Click Produce again (narration is cached, so retries are quick and free)';
      try { fs.writeFileSync(file, JSON.stringify(meta, null, 2)); } catch { /* best effort */ }
    }
    return meta;
  } catch {
    return null;
  }
}

export function renderJob(id) {
  const job = jobs.get(id);
  if (job) return job;
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  const meta = path.join(rendersDir(), `${safe}.json`);
  return fs.existsSync(meta) ? readMeta(meta) : null;
}

export function renderFile(id, ext) {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  const file = path.join(rendersDir(), `${safe}.${ext}`);
  return fs.existsSync(file) ? file : null;
}

export function listRenders(packageId) {
  const dir = rendersDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const live = [...jobs.values()].find((j) => f.startsWith(j.id));
      return live || readMeta(path.join(dir, f));
    })
    .filter((r) => r && (!packageId || r.packageId === packageId))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
