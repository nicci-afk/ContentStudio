// Smoke test of the gated publish path on the real server with a mock Claude:
// generate -> gate -> one retry -> blocked (fail closed) -> approval refused
// -> override logged -> pacing gives human, non-round times; an older
// package carries no verdict until Re-check; the booking route is public
// while the Quality endpoints stay behind sign-in.
// Run: node tests/publish-path.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4632;
const BASE = `http://127.0.0.1:${PORT}`;

// ---- mock Claude ------------------------------------------------------------
const calls = [];
const reply = (obj) => JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'mock', content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const msg = JSON.parse(b).messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text || '').join(' '))).join('\n');
    const retry = /REJECTED BY THE QUALITY GATE/.test(msg);
    const hook = (msg.match(/use it VERBATIM, never write a different hook\): "([^"]+)"/) || [])[1] || '';
    let out = {};
    if (/HOOK LIBRARY/.test(msg)) out = { picks: [{ templateId: 'seed-specific-number', slots: { NUMBER: '65 attendees', MEANING: 'zero missed transfers' } }] };
    else if (/Create the LinkedIn asset/.test(msg)) {
      // First draft carries an invented number; the retry fixes it.
      calls.push(`linkedin${retry ? ':retry' : ''}`);
      out = { post: `${hook}\n\nAt six in the morning I stood at the shuttle stop with a clipboard.\n\nThe lesson: confirm every transfer twice.\n\n${retry ? 'Happy to share my checklist if it helps.' : 'We have moved 900 guests since 2019.'}`, article_title: 'How do you plan event transfers?', article: '# Event transfers\n\n## How?\n\nAnswer.', hashtags: '#events', comment_starter: 'More in the article.' };
    } else if (/Create the Facebook asset/.test(msg)) {
      // Always invents a credential: blocked after the one retry.
      calls.push(`facebook${retry ? ':retry' : ''}`);
      out = { post: `${hook}\n\nI am an award-winning planner who moved every guest on time.`, group_variant: 'Peer note.', hashtags: '', location_tag: 'Orlando' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(reply(out));
  });
});
await new Promise((r) => mock.listen(0, r));

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pub-'));
let server;
const start = (extra = {}) => new Promise((resolve, reject) => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), CONTENTSTUDIO_DATA: data,
      ANTHROPIC_API_KEY: 'k', ANTHROPIC_API_URL: `http://127.0.0.1:${mock.address().port}/v1/messages`,
      ELEVENLABS_API_KEY: '', HEYGEN_API_KEY: '', RESEND_API_KEY: '', META_CAPI_TOKEN: '', MAGIC_EMAILS: '', STUDIO_PASSWORD: '',
      DISABLE_SEQUENCES: '1', DISABLE_LEDGER: '1', DISABLE_MEASURE: '1', DISABLE_TRENDS: '1', DISABLE_FEEDBACK: '1', DISABLE_REVIEWS: '1', DISABLE_META_SYNC: '1',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; if (out.includes('running')) resolve(); });
  server.stderr.on('data', (d) => { out += d; });
  server.on('exit', (code) => reject(new Error(`server exited ${code}: ${out.slice(-500)}`)));
});
const stop = () => new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill('SIGTERM'); });
const api = async (method, url, body, headers = {}) => {
  const res = await fetch(BASE + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), location: res.headers.get('location') };
};

try {
  await start();
  await api('PATCH', '/api/state', { path: 'profile.business', value: { name: 'Travel GHR', links: { website: 'https://travelghr.com' }, person: { name: 'Nicci Grotefendt' }, bookingUrl: 'https://cal.example.com/brief' } });
  await api('PUT', '/api/knowledge', { entries: [{ claim: 'We moved 65 attendees for the EMS Edition with zero missed transfers.', status: 'verified', source: 'event manifest' }] });

  // Generate and wait.
  const { body: { jobId } } = await api('POST', '/api/formats', { core_idea: 'How do you plan transfers for a 65 person event?', platforms: ['linkedin', 'facebook'] });
  let job;
  for (let i = 0; i < 80; i++) { job = (await api('GET', `/api/generate/${jobId}`)).body; if (job.status !== 'running') break; await new Promise((r) => setTimeout(r, 150)); }
  assert.equal(job.status, 'done', JSON.stringify(job.error));
  const pkg = job.package;
  assert.equal(pkg.hook.templateId, 'seed-specific-number');

  // Gate: linkedin fixed on its one retry; facebook blocked after its retry.
  const li = pkg.platforms.linkedin.gate;
  const fb = pkg.platforms.facebook.gate;
  assert.deepEqual(calls.filter((c) => c.startsWith('linkedin')), ['linkedin', 'linkedin:retry']);
  assert.deepEqual(calls.filter((c) => c.startsWith('facebook')), ['facebook', 'facebook:retry'], 'exactly one retry');
  assert.equal(li.status, 'passed');
  assert.equal(li.retried, true);
  assert.equal(fb.status, 'blocked', 'a second failure must come back blocked');
  assert.ok(fb.voice.length || fb.blocked.length);
  assert.ok(li.decisions.every((d) => d.status && 'source' in d), 'every decision logged with status and source');

  // Approval: blocked asset refused, override logged, clean asset approved.
  assert.equal((await api('POST', `/api/packages/${pkg.id}/approve`, { platformId: 'facebook', approved: true })).status, 409);
  const ov = await api('POST', `/api/packages/${pkg.id}/approve`, { platformId: 'facebook', approved: true, override: true });
  assert.equal(ov.body.package.approvals.facebook.override, true);
  const ok = await api('POST', `/api/packages/${pkg.id}/approve`, { platformId: 'linkedin', approved: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.package.approvals.linkedin.override, undefined);

  // Pacing: human, non-round times, LinkedIn on a weekday.
  const plan = (await api('GET', `/api/packages/${pkg.id}/publish-plan`)).body;
  assert.equal(plan.assets.length, 2);
  for (const a of plan.assets) {
    assert.ok(a.suggestedAt, `${a.platformId} has no slot`);
    const d = new Date(a.suggestedAt);
    const minute = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', minute: '2-digit' }).format(d));
    assert.notEqual(minute % 5, 0, `${a.platformId} lands on a round minute`);
    assert.ok(d.getUTCSeconds() > 0, 'seconds should not be :00');
    if (a.platformId === 'linkedin') assert.ok(!['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(d)));
  }

  // An older package (no gate yet) shows no verdict until Re-check.
  await stop();
  const pfile = fs.readdirSync(path.join(data, 'workspaces')).map((w) => path.join(data, 'workspaces', w, 'packages.json')).find((f) => fs.existsSync(f));
  const store = JSON.parse(fs.readFileSync(pfile, 'utf8'));
  store.items.push({ id: 'oldpkg000000', topic: 'An older post', createdAt: '2026-08-01T00:00:00Z', platforms: { linkedin: { fields: { post: 'Hook.\n\nWe served 400 clients in 2025.\n\nLesson.\n\nQuiet close.' } } } });
  fs.writeFileSync(pfile, JSON.stringify(store));
  await start();
  const old = (await api('GET', '/api/packages/oldpkg000000')).body.package;
  assert.equal(old.platforms.linkedin.gate, undefined, 'older package must show not checked yet');
  const re = (await api('POST', '/api/packages/oldpkg000000/gate')).body;
  assert.equal(re.gates.linkedin.status, 'blocked', 'Re-check must produce a verdict');

  // Booking route is public; quality and results stay behind sign-in.
  await stop();
  await start({ STUDIO_PASSWORD: 'test-password' });
  const unknown = await api('GET', '/book/c/not-a-real-capture-id');
  assert.equal(unknown.status, 404, 'booking route must answer publicly');
  for (const u of ['/api/knowledge', '/api/hooks', '/api/feedback/report', '/api/attribution', '/api/magnets', '/api/meta', '/api/trend-inputs', '/api/voice-card']) {
    assert.equal((await api('GET', u)).status, 401, `${u} must require sign-in`);
  }
  console.log('publish path: gate, one retry, fail-closed block, approval refusal and override, human pacing, not-checked-yet then Re-check, public booking, protected Quality endpoints');
} finally {
  await stop().catch(() => {});
  mock.close();
}
process.exit(0);
