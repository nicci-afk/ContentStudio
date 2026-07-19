// Auto-Produce: renders finished platform videos on the server — the
// package's AI-selected library images as slow-zoom b-roll, ElevenLabs
// narration in the creator's cloned voice, an optional HeyGen avatar open,
// sized per platform, with an SRT caption file generated alongside.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { uid, readMediaFile, workspaceDir } from './store.js';
import { elevenTts, heygenGenerate, heygenStatus, providerStatus } from './providers.js';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegInstaller.path;

const jobs = new Map();

function rendersDir() {
  const dir = path.join(workspaceDir(), 'renders');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ffmpeg(args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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

function buildSrt(text, duration) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) || [text];
  const totalChars = sentences.reduce((s, x) => s + x.length, 0) || 1;
  const fmt = (t) => {
    const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60); const ms = Math.round((t % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  let cursor = 0;
  return sentences.map((sentence, i) => {
    const span = (sentence.length / totalChars) * duration;
    const block = `${i + 1}\n${fmt(cursor)} --> ${fmt(Math.min(duration, cursor + span))}\n${sentence}\n`;
    cursor += span;
    return block;
  }).join('\n');
}

export function startRender({ pkg, platformId, script, hookText, voiceId, orientation, avatar }) {
  const id = uid();
  const job = {
    id, packageId: pkg.id, platformId, orientation,
    status: 'running', step: 'starting', error: null,
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  runRender(job, { pkg, platformId, script, hookText, voiceId, orientation, avatar })
    .catch((err) => {
      job.status = 'error';
      job.error = String(err.message).slice(0, 500);
    });
  return id;
}

async function runRender(job, { pkg, platformId, script, hookText, voiceId, orientation, avatar }) {
  const portrait = orientation !== 'landscape';
  const [W, H] = portrait ? [1080, 1920] : [1920, 1080];
  const dir = rendersDir();
  const tmp = path.join(dir, `tmp-${job.id}`);
  fs.mkdirSync(tmp, { recursive: true });
  const status = providerStatus();

  try {
    const speech = cleanScriptForSpeech(script);
    if (!speech) throw new Error('no narratable script text in this asset');

    // 1. Narration (cloned voice) — or timed silence for previews without a key.
    job.step = 'generating narration';
    let narration;
    let silent = false;
    if (voiceId && status.elevenlabs) {
      narration = path.join(tmp, 'narration.mp3');
      fs.writeFileSync(narration, await elevenTts({ voiceId, text: speech }));
    } else {
      silent = true;
      narration = path.join(tmp, 'narration.m4a');
      const silenceDur = Math.min(60, Math.max(12, Math.round(speech.split(' ').length / 2.6)));
      await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(silenceDur), '-c:a', 'aac', '-y', narration]);
    }
    const duration = await probeDuration(narration);

    // 2. Collect the package's selected imagery at the best stored resolution.
    job.step = 'gathering your media';
    const frames = [];
    for (const mediaId of pkg.mediaIds || []) {
      const buf = readMediaFile(mediaId, 'render') || readMediaFile(mediaId, 'analysis') || readMediaFile(mediaId, 'thumb');
      if (buf) {
        const file = path.join(tmp, `img-${frames.length}.jpg`);
        fs.writeFileSync(file, buf);
        frames.push(file);
      }
    }
    if (!frames.length) throw new Error('no usable media frames in this package — attach or auto-select media and regenerate');

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

    // 4. Optional avatar open (HeyGen), concatenated ahead of the b-roll.
    let finalSource = slideshow;
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
        '-i', avatarFile, '-i', slideshow,
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

    // 5. Finalize: mp4 + captions + metadata.
    job.step = 'finalizing';
    const outFile = path.join(dir, `${job.id}.mp4`);
    fs.copyFileSync(finalSource, outFile);
    fs.writeFileSync(path.join(dir, `${job.id}.srt`), buildSrt(speech, await probeDuration(outFile)));
    fs.writeFileSync(path.join(dir, `${job.id}.json`), JSON.stringify({
      id: job.id, packageId: pkg.id, topic: pkg.topic, platformId, orientation,
      silent, avatar: !!(avatar?.avatarId && status.heygen),
      duration: Math.round(await probeDuration(outFile)),
      createdAt: job.createdAt,
    }, null, 2));
    job.silent = silent;
    job.step = 'done';
    job.status = 'done';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function renderJob(id) {
  const job = jobs.get(id);
  if (job) return job;
  const meta = path.join(rendersDir(), `${id}.json`);
  if (fs.existsSync(meta)) return { ...JSON.parse(fs.readFileSync(meta, 'utf8')), status: 'done', step: 'done' };
  return null;
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
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter((r) => r && (!packageId || r.packageId === packageId))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
