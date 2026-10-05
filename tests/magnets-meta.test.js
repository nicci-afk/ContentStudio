// Interactive lead magnets and Meta metrics by API.
// Run: node tests/magnets-meta.test.js (throwaway data dir, mock Graph API).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONTENTSTUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mag-'));
const store = await import('../lib/store.js');
const mg = await import('../lib/magnets.js');

const profile = {
  business: { name: 'Travel GHR', neverMention: ['budget'] },
  knowledgeBase: [
    { id: 'k1', claim: 'Our event planning takes about 3 hours per attendee for a full program.', status: 'verified', source: 'project logs' },
    { id: 'k2', claim: 'I worked the hotel front desk before I became a general manager.', status: 'owner_statement', source: 'owner' },
  ],
};

// ---- expression language: safe, no eval --------------------------------------
{
  const f = mg.compile('(guests * hours_each) / 60 + 2', new Set(['guests', 'hours_each']));
  assert.equal(f({ guests: 30, hours_each: 120 }), 62);
  assert.throws(() => mg.compile('process.exit(1)', new Set()), /cannot read|unknown/);
  assert.throws(() => mg.compile('guests; alert(1)', new Set(['guests'])));
  assert.throws(() => mg.compile('constructor', new Set()), /unknown name/);
  assert.equal(mg.compile('5 / 0', new Set())({}), 0);
}

// ---- quiz ------------------------------------------------------------------------
const quizRaw = {
  kind: 'quiz', title: 'Which group trip fits your team?', intro: 'Four questions about your team.',
  questions: [
    { id: 'size', text: 'How big is the group?', options: [{ id: 'small', label: 'Under 25', scores: { retreat: 2 } }, { id: 'large', label: 'Over 100', scores: { conference: 3 } }] },
    { id: 'goal', text: 'What matters most?', options: [{ id: 'bond', label: 'Time together', scores: { retreat: 3 } }, { id: 'learn', label: 'Sessions and speakers', scores: { conference: 2 } }] },
    { id: 'pace', text: 'What pace?', options: [{ id: 'slow', label: 'Slow', scores: { retreat: 1 } }, { id: 'full', label: 'Full days', scores: { conference: 1 } }] },
  ],
  results: [{ key: 'retreat', title: 'A small retreat', body: 'A villa style retreat fits a team that wants time together.', cta: 'Book a brief call to talk it through.' }, { key: 'conference', title: 'A program with sessions', body: 'A structured program fits a team that wants to learn together.', cta: 'Book a brief call.' }],
};
{
  const m = mg.normalizeMagnet(quizRaw);
  assert.deepEqual(mg.validateMagnet(m, profile), []);
  assert.equal(mg.scoreQuiz(m, { size: 'small', goal: 'bond', pace: 'slow' }), 'retreat');
  assert.equal(mg.scoreQuiz(m, { size: 'large', goal: 'learn', pace: 'full' }), 'conference');
  const sub = mg.sanitizeSubmission(m, { answers: { size: 'large', goal: '<script>', extra: 'x' } });
  assert.deepEqual(sub.answers, { size: 'large' }, 'unknown answers must be dropped');
  // Voice and fact gate apply to every string.
  const bad = mg.normalizeMagnet({ ...quizRaw, intro: 'A bucket list quiz — we are award-winning.' });
  const probs = mg.validateMagnet(bad, profile);
  assert.ok(probs.some((p) => p.includes('bucket list')));
  assert.ok(!/[\u2013\u2014]/.test(bad.intro), 'dashes are normalized out of magnet text');
  assert.ok(probs.some((p) => p.startsWith('unverified claim')));
  // Unreachable result.
  const unreach = mg.normalizeMagnet({ ...quizRaw, results: [...quizRaw.results, { key: 'cruise', title: 'A cruise', body: 'x', cta: 'y' }] });
  assert.ok(mg.validateMagnet(unreach, profile).some((p) => p.includes('no answer leads to result "cruise"')));
}

// ---- calculator: constants must be checked facts ----------------------------------
const calcRaw = {
  kind: 'calculator', title: 'Planning time estimate', intro: 'How much planning time your event takes.',
  inputs: [{ id: 'guests', label: 'Attendees', min: 1, max: 2000, default: 50 }],
  constants: [{ id: 'hours_per', label: 'Planning hours per attendee', value: 3, source: 'project logs' }],
  outputs: [{ id: 'hours', label: 'Planning hours', formula: 'guests * hours_per', format: 'hours' }],
  results: [{ key: 'light', title: 'A light lift', body: 'You can plan this in house with a checklist.', cta: 'Get the checklist.', maxValue: 150 }, { key: 'heavy', title: 'A real project', body: 'This is worth a planning partner.', cta: 'Book a brief call.' }],
};
{
  const m = mg.normalizeMagnet(calcRaw);
  assert.deepEqual(mg.validateMagnet(m, profile), []);
  assert.equal(mg.runCalculator(m, { guests: 20 }).resultKey, 'light');
  const big = mg.runCalculator(m, { guests: 500000 });
  assert.equal(big.inputs.guests, 2000, 'inputs must be clamped');
  assert.equal(big.resultKey, 'heavy');
  const invented = mg.normalizeMagnet({ ...calcRaw, constants: [{ id: 'hours_per', label: 'x', value: 4.5 }] });
  assert.ok(mg.validateMagnet(invented, profile).some((p) => p.includes('not a checked fact')));
  const bare = mg.normalizeMagnet({ ...calcRaw, outputs: [{ id: 'hours', label: 'Hours', formula: 'guests * 3.7' }] });
  assert.ok(mg.validateMagnet(bare, profile).some((p) => p.includes('bare number 3.7')));
}

// ---- store, approval, embed ------------------------------------------------------
{
  const saved = mg.saveMagnet(quizRaw, profile);
  assert.equal(saved.status, 'draft');
  assert.equal(saved.gate.status, 'passed');
  assert.equal(mg.approveMagnet(saved.slug, profile).status, 'approved');
  const edited = mg.saveMagnet({ ...quizRaw, intro: 'A bucket list quiz.' }, profile, { slug: saved.slug });
  assert.equal(edited.status, 'draft', 'an edit must send it back to draft');
  assert.throws(() => mg.approveMagnet(saved.slug, profile), /quality gate/);
  assert.equal(mg.approveMagnet(saved.slug, profile, { override: true }).override, true);
  const html = mg.embedHtml(mg.getMagnet(saved.slug), { endpoint: 'https://x/api/leads/capture', captureId: 'abc', accent: '#123456' });
  assert.ok(html.includes('abc') && html.includes('emailConsent') && !/<script src=/.test(html));
  assert.ok(!html.includes('</script><script>'), 'data must not break out of the script');
  const injected = mg.saveMagnet({ ...quizRaw, title: 'Quiz </script><script>alert(1)</script>' }, profile);
  const h2 = mg.embedHtml(injected, { endpoint: 'e', captureId: 'c' });
  assert.equal((h2.match(/<\/script>/g) || []).length, 1, 'a title must not inject a script tag');
  const email = mg.resultEmail({ m: mg.normalizeMagnet(calcRaw), lead: { firstName: 'Ann' }, submission: mg.runCalculator(mg.normalizeMagnet(calcRaw), { guests: 20 }), brand: 'Travel GHR', person: 'Nicci', unsubUrl: 'u' });
  assert.ok(email.subject.includes('A light lift') && email.html.includes('60 hours'));
}

// ---- Meta metrics by API (mock Graph) ------------------------------------------------
{
  const calls = [];
  const srv = http.createServer((req, res) => {
    calls.push(req.url);
    const u = new URL(req.url, 'http://x');
    let body = {};
    if (u.pathname === '/v1/17841/media') body = { data: [{ id: 'm1', permalink: 'https://www.instagram.com/reel/ABC123/' }, { id: 'm2', permalink: 'https://www.instagram.com/p/ZZZ/' }] };
    else if (u.pathname === '/v1/m1/insights') {
      const metric = u.searchParams.get('metric');
      if (metric === 'follows') { res.statusCode = 400; body = { error: { message: 'metric not supported' } }; }
      else body = { data: [{ name: metric, values: [{ value: metric === 'saved' ? 41 : 9 }] }] };
    } else if (u.pathname === '/v1/555/posts') body = { data: [{ id: 'p1', permalink_url: 'https://www.facebook.com/travelghr/posts/pfbid0abc', shares: { count: 4 } }] };
    else { res.statusCode = 404; body = { error: { message: 'nope' } }; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, r));
  process.env.META_GRAPH_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.META_GRAPH_VERSION = 'v1';
  const meta = await import('../lib/meta.js');
  const fb = await import('../lib/feedback.js');
  assert.equal(meta.igCode('https://www.instagram.com/reel/ABC123/?igsh=x'), 'ABC123');
  await assert.rejects(meta.syncMeta(), /connect Meta/);
  meta.saveMetaAuth({ accessToken: 'tok', igUserId: '17841', pageId: '555' });
  assert.equal(meta.metaStatus().connected, true);
  assert.ok(!('accessToken' in meta.metaStatus()), 'the token must never be returned');
  const now = Date.parse('2026-10-05T12:00:00Z');
  store.packageStore.set({ items: [{ id: 'p', topic: 't', createdAt: '2026-10-01T00:00:00Z', platforms: { instagram_reel: { fields: {} }, facebook: { fields: {} } },
    publishedUrls: { instagram_reel: 'https://www.instagram.com/reel/ABC123/', facebook: 'https://www.facebook.com/travelghr/posts/pfbid0abc' },
    publishedAt: { instagram_reel: '2026-10-02T00:00:00Z', facebook: '2026-10-02T00:00:00Z' }, performance: { instagram_reel: { saves: 50, dms: 3 } } }] });
  const r = await meta.syncMeta(now);
  assert.equal(r.synced, 2, JSON.stringify(r));
  const pkg = store.packageStore.get().items[0];
  assert.deepEqual({ s: pkg.performance.instagram_reel.api.saves, sh: pkg.performance.instagram_reel.api.shares }, { s: 41, sh: 9 });
  assert.equal(pkg.performance.facebook.api.shares, 4);
  assert.ok(calls.every((c) => c.includes('access_token=tok')));
  const rows = fb.contentRows();
  const reel = rows.find((x) => x.platformId === 'instagram_reel');
  assert.deepEqual({ saves: reel.metrics.saves, shares: reel.metrics.shares, dms: reel.metrics.dms }, { saves: 50, shares: 9, dms: 3 }, 'manual and API numbers merge by max');
  assert.equal(rows.find((x) => x.platformId === 'facebook').metrics.shares, 4);
  srv.close();
}

console.log('magnets + meta: all assertions passed');
process.exit(0);
