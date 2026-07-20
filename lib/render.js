// Auto-Produce: renders finished platform videos on the server — the
// package's AI-selected library images as slow-zoom b-roll, ElevenLabs
// narration in the creator's cloned voice, an optional HeyGen avatar open,
// sized per platform, with an SRT caption file generated alongside.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { uid, readMediaFile, workspaceDir, mediaStore } from './store.js';
import { elevenTts, elevenTtsTimed, heygenGenerate, heygenStatus, providerStatus } from './providers.js';

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

export function cleanScriptForSpeech(raw) {
  return String(raw || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/\*\*?|__|`/g, '')
    .replace(/^\s*(HOOK|CUT|SCENE|BEAT|B-ROLL|VISUAL|ON-SCREEN|OVERLAY)[:\-].*$/gim, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 9000);
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

export function startRender({ pkg, profile, platformId, script, hookText, voiceId, orientation, avatar }) {
  for (const j of jobs.values()) {
    if (j.status === 'running' && j.packageId === pkg.id && j.platformId === platformId) return j.id;
  }
  const id = uid();
  const job = {
    id, packageId: pkg.id, topic: pkg.topic, platformId, orientation,
    status: 'running', step: 'starting', error: null,
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  writeMeta(job);
  runRender(job, { pkg, profile, platformId, script, hookText, voiceId, orientation, avatar })
    .catch((err) => {
      job.status = 'error';
      job.error = String(err.message).slice(0, 500);
      writeMeta(job);
    });
  return id;
}

async function runRender(job, { pkg, profile, platformId, script, hookText, voiceId, orientation, avatar }) {
  const portrait = orientation !== 'landscape';
  const [W, H] = portrait ? [1080, 1920] : [1920, 1080];
  const dir = rendersDir();
  const tmp = path.join(dir, `tmp-${job.id}`);
  fs.mkdirSync(tmp, { recursive: true });
  const status = providerStatus();

  try {
    const speech = cleanScriptForSpeech(script);
    if (!speech) throw new Error('no narratable script text in this asset');

    // 1. Narration (cloned voice, word-timed when possible) — or timed
    // silence for previews without a key.
    job.step = 'generating narration';
    let narration;
    let silent = false;
    let alignment = null;
    if (voiceId && status.elevenlabs) {
      narration = path.join(tmp, 'narration.mp3');
      const timed = await elevenTtsTimed({ voiceId, text: speech }).catch(() => null);
      if (timed) {
        fs.writeFileSync(narration, timed.audio);
        alignment = timed.alignment;
      } else {
        fs.writeFileSync(narration, await elevenTts({ voiceId, text: speech }));
      }
    } else {
      silent = true;
      narration = path.join(tmp, 'narration.m4a');
      const silenceDur = Math.min(60, Math.max(12, Math.round(speech.split(' ').length / 2.6)));
      await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(silenceDur), '-c:a', 'aac', '-y', narration]);
    }
    const duration = await probeDuration(narration);

    // 2. Collect the package's selected imagery at the best stored resolution.
    // A package without attached media falls back to the strongest assets in
    // the whole library — a render should never dead-end while media exists.
    job.step = 'gathering your media';
    const frames = [];
    const collect = (ids) => {
      for (const mediaId of ids) {
        const buf = readMediaFile(mediaId, 'render') || readMediaFile(mediaId, 'analysis') || readMediaFile(mediaId, 'thumb');
        if (buf) {
          const file = path.join(tmp, `img-${frames.length}.jpg`);
          fs.writeFileSync(file, buf);
          frames.push(file);
        }
      }
    };
    collect(pkg.mediaIds || []);
    let mediaFallback = false;
    if (!frames.length) {
      const ranked = (mediaStore.get().items || [])
        .filter((m) => m.kind === 'image' || m.kind === 'video')
        .sort((a, b) => ((b.quality || 0) + (b.analyzed ? 2 : 0)) - ((a.quality || 0) + (a.analyzed ? 2 : 0)))
        .slice(0, 8);
      collect(ranked.map((m) => m.id));
      mediaFallback = frames.length > 0;
    }
    if (!frames.length) throw new Error('your media library is empty — import photos in the Library first');

    // 3. Slideshow: slides change every ~5s, cycling the imagery if needed.
    job.step = 'assembling b-roll';
    const slideCount = Math.max(1, Math.min(60, Math.round(duration / 5))) || 1;
    const slides = Array.from({ length: slideCount }, (_, i) => frames[i % frames.length]);
    const per = duration / slides.length;
    const inputs = slides.flatMap((f) => ['-loop', '1', '-t', per.toFixed(3), '-i', f]);
    const chains = slides.map((_, i) =>
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=25,` +
      `zoompan=z='min(zoom+0.0008,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=25,setsar=1[v${i}]`);
    const filter = chains.join(';') + ';' + slides.map((_, i) => `[v${i}]`).join('') + `concat=n=${slides.length}:v=1:a=0[vout]`;
    const slideshow = path.join(tmp, 'slideshow.mp4');
    await ffmpeg([
      ...inputs, '-i', narration,
      '-filter_complex', filter,
      '-map', '[vout]', '-map', `${slides.length}:a`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', '-y', slideshow,
    ]);

    // 4. Burn word-timed captions + entity identity card into the b-roll.
    // On-screen text is OCR-indexed by platforms and keeps muted viewers.
    const cues = buildCues(speech, alignment, duration);
    const font = findCaptionFont();
    let captioned = slideshow;
    let captionsBurned = false;
    if (font && !silent) {
      job.step = 'burning captions';
      const biz = profile?.business || {};
      const identity = [biz.person?.name, biz.name].filter(Boolean).join(' · ');
      fs.writeFileSync(path.join(tmp, 'captions.ass'),
        buildAss({ cues, W, H, fontFamily: font.family, identity }));
      const burned = path.join(tmp, 'slideshow-cap.mp4');
      try {
        await ffmpeg([
          '-i', 'slideshow.mp4',
          '-vf', `subtitles=captions.ass:fontsdir=${path.dirname(font.file)}`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'copy', '-movflags', '+faststart', '-y', 'slideshow-cap.mp4',
        ], 30 * 60 * 1000, tmp);
        captioned = burned;
        captionsBurned = true;
      } catch { /* captions optional: SRT still ships */ }
    }

    // 5. Optional avatar open (HeyGen), concatenated ahead of the b-roll.
    let finalSource = captioned;
    if (avatar?.avatarId && avatar?.voiceId && status.heygen) {
      job.step = 'rendering your avatar (HeyGen)';
      const hook = cleanScriptForSpeech(hookText).slice(0, 600) || speech.slice(0, 300);
      const { videoId } = await heygenGenerate({
        avatarId: avatar.avatarId, voiceId: avatar.voiceId, text: hook,
        title: `${pkg.topic} — ${platformId}`, orientation: portrait ? 'portrait' : 'landscape',
      });
      let avatarUrl = null;
      for (let i = 0; i < 75; i++) {
        await new Promise((r) => setTimeout(r, 8000));
        const s = await heygenStatus(videoId);
        if (s.status === 'completed' && s.url) { avatarUrl = s.url; break; }
        if (s.status === 'failed') throw new Error(`HeyGen render failed: ${s.error || 'unknown'}`);
      }
      if (!avatarUrl) throw new Error('HeyGen render timed out');
      const avatarFile = path.join(tmp, 'avatar.mp4');
      fs.writeFileSync(avatarFile, Buffer.from(await (await fetch(avatarUrl)).arrayBuffer()));

      job.step = 'combining avatar + b-roll';
      const combined = path.join(tmp, 'combined.mp4');
      await ffmpeg([
        '-i', avatarFile, '-i', captioned,
        '-filter_complex',
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=25,setsar=1[va];` +
        '[0:a]aresample=44100,aformat=channel_layouts=stereo[aa];' +
        '[1:v]fps=25,setsar=1[vb];[1:a]aresample=44100,aformat=channel_layouts=stereo[ab];' +
        '[va][aa][vb][ab]concat=n=2:v=1:a=1[v][a]',
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', combined,
      ]);
      finalSource = combined;
    }

    // 6. Finalize: embed entity metadata into the MP4 container itself.
    job.step = 'finalizing';
    const outFile = path.join(dir, `${job.id}.mp4`);
    const biz = profile?.business || {};
    await ffmpeg([
      '-i', finalSource, '-map', '0', '-c', 'copy', '-movflags', '+faststart',
      '-metadata', `title=${pkg.topic}`,
      '-metadata', `artist=${[biz.person?.name, biz.name].filter(Boolean).join(', ') || 'ContentStudio'}`,
      '-metadata', `comment=${(pkg.keywords || []).slice(0, 12).join(', ')}`,
      '-y', outFile,
    ]);
    fs.writeFileSync(path.join(dir, `${job.id}.srt`), cuesToSrt(cues));
    const finalDuration = Math.round(await probeDuration(outFile));
    job.silent = silent;
    job.captions = captionsBurned;
    job.step = 'done';
    job.status = 'done';
    writeMeta(job, {
      silent, captions: captionsBurned, timed: !!alignment, mediaFallback,
      avatar: !!(avatar?.avatarId && status.heygen),
      duration: finalDuration,
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
      meta.error = 'the server restarted mid-render (an update deployed) — click Produce again';
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
