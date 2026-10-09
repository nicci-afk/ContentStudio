// Name corrections on transcripts and captions, and the Shorts playlist.
// Unit checks on lib/namefix.js, then a real import against a mock
// ElevenLabs speech-to-text that misspells the name (and refuses keyterms
// once, to prove the retry), then the playlist field and posting prompt.
// Run: node tests/namefix-playlist.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixNames, fixWordNames, fixSrt, nameKeyterms } from '../lib/namefix.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 'Nicci Grotefendt';

// ---- unit ---------------------------------------------------------------------
for (const v of ['Nikki Grotefend', 'Nikki Grotefendt', 'Nicky Grotefend', 'Nicky Grotefendt', 'Nicki Grotefend', 'Nicki Grotefendt', 'Nicci Grotefend', 'Nici Grotefendt',
  'NIKKI GROTEFEND', 'nikki grotefend', 'Nikkie Grottefend', 'Nicky  Grotefendt', 'Nikki Grotevant', 'Nicky Grotefent', 'Nikki Grotevand']) {
  assert.equal(fixNames(`Hi, I'm ${v}, welcome.`), `Hi, I'm ${N}, welcome.`, v);
}
assert.equal(fixNames("Nikki Grotefend's team"), `${N}'s team`);
assert.equal(fixNames(`${N} again`), `${N} again`, 'already correct stays');
for (const other of ['Nikki said hello', 'Grotefend Street', 'Nicky Jones', 'nickel grotto', 'Nikki and the grotto', 'Nikki Grant', 'Nicky Greenfield']) {
  assert.equal(fixNames(other), other, `must not touch: ${other}`);
}
assert.deepEqual(nameKeyterms(), [N]);
const words = [{ text: "I'm", type: 'word' }, { text: ' ', type: 'spacing' }, { text: 'Nikki', type: 'word' }, { text: ' ', type: 'spacing' }, { text: 'Grotefend.', type: 'word' }, { text: 'Hi', type: 'word' }];
fixWordNames(words);
assert.equal(words[2].text, 'Nicci'); assert.equal(words[4].text, 'Grotefendt.'); assert.equal(words[5].text, 'Hi');
assert.equal(fixSrt('1\n00:00:00,000 --> 00:00:01,000\nI am Nikki\nGrotefend\n'), `1\n00:00:00,000 --> 00:00:01,000\nI am ${N}\n`);

// ---- end to end ---------------------------------------------------------------
const PORT = 4633;
const BASE = `http://127.0.0.1:${PORT}`;
const sttCalls = [];
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (d) => chunks.push(d)); req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    if (req.url.startsWith('/v1/speech-to-text')) {
      const keyterms = [...body.matchAll(/name="keyterms"\r\n\r\n([^\r]*)/g)].map((m) => m[1]);
      sttCalls.push(keyterms);
      if (keyterms.length && sttCalls.length === 1) { res.statusCode = 422; return res.end('{"detail":"keyterms not supported"}'); }
      const w = (text, start) => ({ text, start, end: start + 0.4, type: 'word' });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ language_code: 'en', text: "I'm Nikki Grotefend. Welcome to the Rosen Centre.",
        words: [w("I'm", 0.1), w('Nikki', 0.6), w('Grotefend.', 1.1), w('Welcome', 1.8), w('to', 2.2), w('the', 2.5), w('Rosen', 2.8), w('Centre.', 3.2)] }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => mock.listen(0, r));

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-name-'));
const ffmpeg = path.join(ROOT, 'node_modules/@ffmpeg-installer/linux-x64/ffmpeg');
const clip = path.join(data, 'clip.mp4');
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=720x1280:d=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip]);

let server;
const start = () => new Promise((resolve, reject) => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CONTENTSTUDIO_DATA: data, ELEVENLABS_API_KEY: 'k', ELEVENLABS_API_URL: `http://127.0.0.1:${mock.address().port}`,
      ANTHROPIC_API_KEY: '', HEYGEN_API_KEY: '', RESEND_API_KEY: '', STUDIO_PASSWORD: '', MAGIC_EMAILS: '',
      DISABLE_SEQUENCES: '1', DISABLE_LEDGER: '1', DISABLE_MEASURE: '1', DISABLE_TRENDS: '1', DISABLE_FEEDBACK: '1', DISABLE_REVIEWS: '1', DISABLE_META_SYNC: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; if (out.includes('running')) resolve(out); });
  server.stderr.on('data', (d) => { out += d; });
  server.on('exit', (code) => reject(new Error(`server exited ${code}: ${out.slice(-500)}`)));
});
const stop = () => new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill('SIGTERM'); });
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t), text: t }; } catch { return { status: res.status, body: {}, text: t }; }
};

try {
  await start();
  await api('PATCH', '/api/state', { path: 'profile.business', value: { name: 'Travel GHR', person: { name: N } } });
  const { body: { package: draft } } = await api('POST', '/api/shorts', { name: 'party-bus.mp4', size: fs.statSync(clip).size, topic: 'party bus' });
  const up = await fetch(`${BASE}/api/shorts/${draft.id}/source`, { method: 'POST', body: fs.readFileSync(clip), headers: { 'content-type': 'video/mp4' } });
  assert.equal(up.status, 200, await up.text());
  assert.equal((await api('POST', `/api/shorts/${draft.id}/process`, { mode: 'full', opts: { transcribe: true } })).status, 200);
  let pkg;
  for (let i = 0; i < 200; i++) {
    pkg = (await api('GET', `/api/packages/${draft.id}`)).body.package;
    if (pkg?.short?.status !== 'processing') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(pkg.short.master, `import did not finish: ${JSON.stringify(pkg.short.error || pkg.short.status)}`);

  // The hint went out, was refused once, and the transcript still arrived.
  assert.deepEqual(sttCalls, [[N], []], 'keyterm sent, then retried without it after a refusal');
  const f = pkg.platforms.youtube_shorts.fields;
  assert.match(f.transcript, /I'm Nicci Grotefendt\./);
  assert.ok(!/Nikki|Grotefend\b/.test(JSON.stringify(pkg.short.transcriptData)), 'stored cues corrected');
  assert.match(f.transcript, /Rosen Centre/, 'other words untouched');
  const srt = await api('GET', `/api/render/${pkg.short.renderId}/srt`);
  assert.match(srt.text, /Nicci Grotefendt/); assert.ok(!/Nikki/.test(srt.text));
  assert.match(JSON.stringify(pkg.jsonld), /Nicci Grotefendt/, 'schema transcript corrected');

  // A transcript edit is corrected too.
  const ed = await api('PATCH', `/api/packages/${pkg.id}`, { platformId: 'youtube_shorts', field: 'transcript', value: 'Hello from Nicky Grotefend at Rosen Centre.' });
  assert.equal(ed.body.package.platforms.youtube_shorts.fields.transcript, `Hello from ${N} at Rosen Centre.`);

  // Playlist: default suggestion creates, brand default and package value pick existing.
  await api('POST', `/api/packages/${pkg.id}/approve`, { platformId: 'youtube_shorts', approved: true, override: true });
  await api('POST', `/api/shorts/${pkg.id}/consent`, { faces: true, rights: true });
  let prompt = (await api('GET', `/api/shorts/${pkg.id}/prompt`)).body.prompt;
  assert.match(prompt, /choose the playlist named "Travel GHR Shorts"\. If none exists, create it/);
  await api('PATCH', '/api/state', { path: 'profile.publishing', value: { youtube: { playlist: 'Corporate Events at Rosen Centre Orlando' } } });
  prompt = (await api('GET', `/api/shorts/${pkg.id}/prompt`)).body.prompt;
  assert.match(prompt, /choose the existing playlist named "Corporate Events at Rosen Centre Orlando"\. It already exists on my channel: never create a new playlist/);
  assert.ok(!/create it with exactly that name/.test(prompt));
  await api('PATCH', `/api/packages/${pkg.id}`, { platformId: 'youtube_shorts', field: 'playlist', value: 'Party Bus Moments' });
  prompt = (await api('GET', `/api/shorts/${pkg.id}/prompt`)).body.prompt;
  assert.match(prompt, /choose the existing playlist named "Party Bus Moments"/);

  // Boot backfill: a transcript stored with the misspelling is corrected on restart.
  await stop();
  const pfile = fs.readdirSync(path.join(data, 'workspaces')).map((w) => path.join(data, 'workspaces', w, 'packages.json')).find((x) => fs.existsSync(x));
  const store = JSON.parse(fs.readFileSync(pfile, 'utf8'));
  const p0 = store.items.find((x) => x.id === pkg.id);
  p0.platforms.youtube_shorts.fields.transcript = "I'm Nikki Grotefend. Welcome.";
  p0.short.transcriptData.cues[0].text = "I'm Nikki Grotefend.";
  fs.writeFileSync(pfile, JSON.stringify(store));
  const bootLog = await start();
  assert.match(bootLog, /namefix: corrected names in 1 stored transcript/);
  const after = (await api('GET', `/api/packages/${pkg.id}`)).body.package;
  assert.equal(after.platforms.youtube_shorts.fields.transcript, `I'm ${N}. Welcome.`);
  assert.equal(after.short.transcriptData.cues[0].text, `I'm ${N}.`);
  console.log('name corrections: variants fixed, other words untouched, keyterm hint with fallback, transcript/cues/SRT/schema/edit corrected, boot backfill; playlist: package field, brand default, existing-only prompt');
} finally {
  await stop().catch(() => {});
  mock.close();
}
process.exit(0);
