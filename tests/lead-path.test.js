// The full lead path against the real server with every outside service
// mocked: form sign-up -> scoring -> owner alert -> resource email -> Meta
// Conversions API event -> nurture sequence email from the live scheduler.
// Run: node tests/lead-path.test.js (throwaway data dir, mock Resend + Meta).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The Conscious Creator workspace id, so its real resource manifest and
// sequence in resources/ are the ones under test.
const WS = '00c295737118d5e2';
const PORT = 4631;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = 'https://consciouscreator.app';

// ---- mocks -----------------------------------------------------------------
const mails = [];
const metaEvents = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    if (req.url === '/emails') mails.push({ auth: req.headers.authorization, ...JSON.parse(b) });
    else if (/\/events$/.test(req.url)) metaEvents.push({ url: req.url, auth: req.headers.authorization, ...JSON.parse(b) });
    res.setHeader('content-type', 'application/json');
    res.end('{"id":"ok"}');
  });
});
await new Promise((r) => mock.listen(0, r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lead-'));
fs.writeFileSync(path.join(data, 'workspaces.json'), JSON.stringify({ items: [{ id: WS, name: 'Lead path test', createdAt: new Date().toISOString() }], activeId: WS }));

let server;
const start = (extra = {}) => new Promise((resolve, reject) => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), CONTENTSTUDIO_DATA: data, PUBLIC_BASE_URL: BASE,
      RESEND_API_KEY: 'test-resend', RESEND_API_URL: `${MOCK}/emails`,
      META_CAPI_TOKEN: 'test-capi', META_GRAPH_URL: MOCK,
      ANTHROPIC_API_KEY: '', ELEVENLABS_API_KEY: '', HEYGEN_API_KEY: '', STUDIO_PASSWORD: '', MAGIC_EMAILS: '',
      DISABLE_LEDGER: '1', DISABLE_MEASURE: '1', DISABLE_TRENDS: '1', DISABLE_FEEDBACK: '1', DISABLE_REVIEWS: '1', DISABLE_META_SYNC: '1',
      SEQUENCE_IGNORE_WINDOW: '1', SEQUENCE_FIRST_RUN_MS: '600000', ...extra,
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
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

try {
  await start();
  // Owner setup, as the Leads page does it.
  await api('PATCH', '/api/state', { path: 'profile.business', value: { name: 'The Conscious Creator', links: { website: SITE }, metaPixelId: '2015929675781879', person: { name: 'Nicci Grotefendt' } } });
  const setup = await api('GET', '/api/leads/setup');
  assert.equal(setup.status, 200);
  const { captureId } = setup.body;
  await api('PUT', '/api/leads/settings', { notifyEmail: 'owner@example.com', sequenceEnabled: true });

  // 1. A visitor signs up on the brand's own site, with ad consent.
  const resource = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', WS, 'manifest.json'), 'utf8')).resources[0].slug;
  const signup = await api('POST', `/api/leads/capture?id=${captureId}`, {
    captureId, resource, email: 'visitor@example.com', firstName: 'Ana', yearsAdvisor: '3 to 5 years', agency: 'Indie',
    emailConsent: true, adConsent: true, utm_source: 'instagram_reel', utm_content: 'pkgabc', page: `${SITE}/resources/x`,
  }, { origin: SITE });
  assert.equal(signup.status, 200, JSON.stringify(signup.body));
  assert.ok(signup.body.downloadUrl.includes('/r/'));

  // 2. Alert to the owner, resource email to the visitor, Lead event to Meta.
  assert.ok(await waitFor(() => mails.length >= 2 && metaEvents.length >= 1), `side effects missing: ${mails.length} mails, ${metaEvents.length} meta`);
  const toOwner = mails.find((m) => [].concat(m.to).includes('owner@example.com'));
  const toVisitor = mails.find((m) => [].concat(m.to).includes('visitor@example.com'));
  assert.ok(toOwner, 'owner alert not sent');
  assert.ok(toVisitor && toVisitor.html.includes('/r/') && toVisitor.html.includes('/unsubscribe/'), 'resource email missing link or unsubscribe');
  assert.equal(toVisitor.auth, 'Bearer test-resend');
  const ev = metaEvents[0];
  assert.ok(ev.url.includes('/2015929675781879/events'));
  assert.equal(ev.auth, 'Bearer test-capi');
  assert.equal(ev.data[0].event_name, 'Lead');
  assert.match(ev.data[0].user_data.em[0], /^[0-9a-f]{64}$/, 'email must be hashed');
  assert.ok(!JSON.stringify(ev).includes('visitor@example.com'), 'raw email leaked to Meta');

  // 3. Scoring and stored statuses.
  let lead = (await api('GET', '/api/leads')).body.items.find((l) => l.email === 'visitor@example.com');
  assert.ok(lead.score?.tier, 'lead not scored');
  assert.equal(lead.notify.status, 'sent');
  assert.equal(lead.delivery.status, 'sent');
  assert.equal(lead.capi.status, 'sent');
  assert.equal(lead.channel, 'Instagram Reel');

  // No ad consent: no Meta event, everything else still runs.
  const before = metaEvents.length;
  await api('POST', `/api/leads/capture?id=${captureId}`, { captureId, resource, email: 'noads@example.com', emailConsent: true, adConsent: false }, { origin: SITE });
  await waitFor(async () => (await api('GET', '/api/leads')).body.items.find((l) => l.email === 'noads@example.com')?.capi);
  const noads = (await api('GET', '/api/leads')).body.items.find((l) => l.email === 'noads@example.com');
  assert.equal(noads.capi.status, 'skipped');
  assert.equal(metaEvents.length, before, 'Meta event sent without consent');

  // 4. Nurture: backdate the sign-up past day 2, restart with a fast first
  // scheduler run, and the live scheduler sends step one.
  await stop();
  const file = path.join(data, 'workspaces', WS, 'leads.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const l of d.items) l.optIn.at = new Date(Date.now() - 2.5 * 86400000).toISOString();
  fs.writeFileSync(file, JSON.stringify(d));
  const mailsBefore = mails.length;
  await start({ SEQUENCE_FIRST_RUN_MS: '300' });
  assert.ok(await waitFor(() => mails.length >= mailsBefore + 2, 10000), 'nurture step did not send');
  lead = (await api('GET', '/api/leads')).body.items.find((l) => l.email === 'visitor@example.com');
  assert.equal(lead.sequence?.sent?.[0]?.day, 2, 'sequence step not recorded');
  const step = mails.slice(mailsBefore).find((m) => [].concat(m.to).includes('visitor@example.com'));
  assert.ok(step.headers?.['List-Unsubscribe'], 'nurture email lacks one-click unsubscribe');

  // A booked call stops the sequence.
  await api('PATCH', `/api/leads/${lead.id}`, { status: 'call_booked' });
  lead = (await api('GET', '/api/leads')).body.items.find((l) => l.email === 'visitor@example.com');
  assert.ok(lead.bookedAt, 'bookedAt not stamped');
  console.log('lead path: signup, scoring, alert, resource email, Meta Lead event, nurture step, stop on booked call all fire');
} finally {
  await stop().catch(() => {});
  mock.close();
}
process.exit(0);
