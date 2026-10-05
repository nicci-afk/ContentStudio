// Acceptance tests for Modules 2, 3, 4, 6 and 7 plus the publishing protocol,
// reviews and entity checks. Run: node tests/modules.test.js
// Uses a throwaway data directory, never real data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONTENTSTUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mod-'));
const store = await import('../lib/store.js');
const hooks = await import('../lib/hooks.js');
const trends = await import('../lib/trendinputs.js');
const formats = await import('../lib/formats.js');
const thumbs = await import('../lib/thumbs.js');
const feedback = await import('../lib/feedback.js');
const pacing = await import('../lib/pacing.js');
const reviews = await import('../lib/reviews.js');
const entity = await import('../lib/entitymon.js');
const { checkAsset } = await import('../lib/gate.js');

const profile = {
  business: { name: 'Travel GHR', neverMention: ['budget'], location: 'Edwardsville, Illinois', phone: '618-954-7979',
    person: { name: 'Nicci Grotefendt', credentials: 'More than 15 years in hotels, from the front desk to general manager.' } },
  knowledgeBase: [
    { id: 'k1', claim: 'We moved 65 attendees for the EMS Edition on May 19 with zero missed transfers.', status: 'verified', source: 'event manifest', date: '2026-05-20' },
    { id: 'k2', claim: 'I worked the hotel front desk before I became a general manager.', status: 'owner_statement', source: 'owner', date: '2026-10-01' },
    { id: 'k3', claim: 'The retreat was featured in Forbes.', status: 'unverified', source: 'none', date: null },
  ],
};

// ---- Module 2: hook library ------------------------------------------------
{
  const seed = hooks.getHook('seed-specific-number');
  const ok = hooks.fillHook(seed, { NUMBER: '65 attendees', MEANING: 'zero missed transfers' }, profile);
  assert.ok(ok.ok, `verified fill rejected: ${ok.problems}`);
  const bad = hooks.fillHook(seed, { NUMBER: '400 attendees', MEANING: 'zero missed transfers' }, profile);
  assert.ok(!bad.ok, 'unverified number passed');
  const forbes = hooks.fillHook(hooks.getHook('seed-invisible-work'), { SPECIFICS: 'The retreat was featured in Forbes' }, profile);
  assert.ok(!forbes.ok, 'an explicitly unverified claim passed');
  const voice = hooks.fillHook(hooks.getHook('seed-contrarian-belief'), { COMMON_BELIEF: 'a bucket list trip is a game-changer', WHAT_I_SEE: 'I worked the hotel front desk' }, profile);
  assert.ok(!voice.ok && voice.problems.some((p) => p.startsWith('voice')), 'voice violation passed');
  const confession = hooks.fillHook(hooks.getHook('seed-insider-confession'), { DO_X: 'run event check-ins', DO_Y: 'work the hotel front desk' }, profile);
  assert.ok(confession.ok, `owner-statement fill rejected: ${confession.problems}`);
  // chooseHooks: every passing hook traces to a template id; unverified picks fail closed.
  const res = await hooks.chooseHooks({ profile, topic: 'event transfers', ask: async () => ({ picks: [
    { templateId: 'seed-specific-number', slots: { NUMBER: '65 attendees', MEANING: 'zero missed transfers' } },
    { templateId: 'seed-specific-number', slots: { NUMBER: '900 guests', MEANING: 'a record' } },
    { templateId: 'made-up', slots: { X: 'y' } },
  ] }) });
  assert.equal(res.options.length, 1);
  assert.ok(res.options.every((o) => hooks.getHook(o.templateId)), 'orphan hook');
  assert.equal(res.rejected.length, 2);
  const none = await hooks.chooseHooks({ profile, topic: 'x', ask: async () => ({ picks: [{ templateId: 'seed-specific-number', slots: { NUMBER: '1000', MEANING: 'everything' } }] }) });
  assert.equal(none.hook, null, 'no hook must mean null, never a freeform one');
  // Ranking: a promoted template outranks seeds.
  const own = hooks.saveHook({ template: '[NUMBER] check-ins, one front desk habit.', pattern: 'specific_number' });
  assert.equal(hooks.rankHooks()[0].source !== 'promoted', true);
  hooks.updateStats(own.id, (s) => ({ ...s, promotedAt: new Date().toISOString() }));
  assert.equal(hooks.rankHooks()[0].id, own.id, 'promoted template does not rank first');
}

// ---- Module 3: trend ingestion ------------------------------------------------
{
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.deepEqual(trends.constraintsFor('instagram_reel', now), { text: '', ids: [] }, 'no trends must be the evergreen baseline');
  const r = trends.importTrends([
    { platform: 'instagram', hook_structure: 'open with 3 staccato specific numbers', observed_date: '2026-10-01', source: 'first-party: October insights' },
    { platform: 'instagram', format_shift: 'no date' , source: 'x' },
    { platform: 'meta', audio_trend: 'no source', observed_date: '2026-10-01' },
    { platform: 'facebook', format_shift: 'old observation', observed_date: '2026-08-01', source: 'public research' },
  ], now);
  assert.equal(r.accepted, 2);
  assert.equal(r.rejected.length, 2);
  const c = trends.constraintsFor('instagram_reel', now);
  assert.equal(c.ids.length, 1);
  assert.ok(c.text.includes(c.ids[0]) && c.text.includes('staccato'));
  assert.equal(trends.constraintsFor('facebook', now).ids.length, 0, 'expired trend still applies');
  // Re-observing renews and keeps the id.
  const before = c.ids[0];
  trends.importTrends([{ platform: 'facebook', format_shift: 'old observation', observed_date: '2026-10-04', source: 'public research' }], now);
  assert.equal(trends.constraintsFor('facebook', now).ids.length, 1, 're-observed trend did not renew');
  assert.equal(trends.constraintsFor('instagram_reel', now).ids[0], before);
}

// ---- Module 4: formatters ---------------------------------------------------
{
  const hook = '65 attendees. That\'s zero missed transfers.';
  const good = { caption: `${hook}\n\nHow we planned the shuttles.\n\nComment GUIDE for the free checklist.\n\n#eventtravel #corporateevents`, hashtags: '' };
  assert.deepEqual(formats.formatChecks('instagram_post', good, { hook }), []);
  const ids = (f) => formats.formatChecks('instagram_post', f, { hook }).map((v) => v.id);
  assert.ok(ids({ caption: `Intro line.\n${hook}` }).includes('ig_hook_first'));
  assert.ok(ids({ caption: `${hook}\n#a #b`, hashtags: '#c #d' }).includes('ig_hashtag_cap'));
  assert.ok(ids({ caption: `${hook}\n#early tag here\nmore` }).includes('ig_hashtags_end'));
  assert.ok(ids({ caption: `${hook}\nGet it at travelghr.com/guide` }).includes('ig_no_link'));
  assert.ok(ids({ caption: `${hook}\nGrab the free checklist.` }).includes('ig_comment_trigger'));
  const li = (post) => formats.formatChecks('linkedin', { post }).map((v) => v.id);
  assert.deepEqual(li('Hook line.\n\nScene: the 6am shuttle.\n\nLesson: confirm twice.\n\nHappy to share the checklist if useful.'), []);
  assert.ok(li('Hook.\n\nOnly two parts.').includes('li_structure'));
  assert.ok(li('Hook.\n\nScene.\n\nLesson.\n\nBook now!').includes('li_quiet_cta'));
  assert.ok(li('Hook.\n\nScene https://x.com.\n\nLesson.\n\nQuiet close.').includes('li_no_link'));
  assert.ok(formats.formatChecks('facebook', { post: 'Watch till the end of this reel.\n\nStory.' }).some((v) => v.id === 'fb_first_line'));
  // Cross-posting: identical text flags only the later sibling.
  const same = 'We moved sixty five attendees through two airports and three hotels without a single missed transfer, and here is how the plan worked from the first email to the last shuttle.';
  const pkg = { platforms: { instagram_post: { fields: { caption: same } }, linkedin: { fields: { post: 'A completely different native post about the same event, told as one scene at a shuttle stop at six in the morning.' } }, facebook: { fields: { post: same } } } };
  const x = formats.crossPostCheck(pkg);
  assert.equal(x.length, 1);
  assert.equal(x[0].platformId, 'facebook');
  // A failing format blocks only that asset.
  const g1 = checkAsset('instagram_post', { caption: `${hook}\nhttps://x.com` }, profile, { hook });
  const g2 = checkAsset('linkedin', { post: 'Hook.\n\nScene from the front desk.\n\nLesson learned.\n\nQuiet close.' }, profile, { hook });
  assert.equal(g1.status, 'blocked');
  assert.equal(g2.status, 'passed', JSON.stringify(g2));
  // Hook trace: a hand-written hook outside the library is blocked.
  const g3 = checkAsset('instagram_reel', { hook: 'My own hook', caption: 'My own hook' }, profile, { hook: 'x', hookTexts: [hook] });
  assert.ok(g3.format.some((v) => v.id === 'hook_trace'));
}

// ---- Module 6: thumbnail briefs ------------------------------------------------
{
  const fields = { hook: '65 attendees. That\'s zero missed transfers.', caption: 'Zero missed transfers for 65 attendees.\n\nMore.' };
  const b = thumbs.buildBrief({ platformId: 'instagram_reel', fields, hookText: fields.hook, media: [{ id: 'a', kind: 'image', alt: 'conference hall' }, { id: 'b', kind: 'video', alt: 'Nicci smiling with her badge' }] });
  assert.ok(b.overlay_text.split(/\s+/).length <= 6);
  assert.deepEqual(thumbs.checkBrief(b, { fields, profile }), [], JSON.stringify(b));
  assert.equal(b.coverMediaId, 'b', 'a person on video should be the preferred first frame');
  assert.equal(b.format, '9:16');
  assert.ok(thumbs.checkBrief({ ...b, overlay_text: 'one two three four five six seven' }, { fields }).some((p) => p.includes('6 max')));
  assert.ok(thumbs.checkBrief({ ...b, overlay_text: 'Zero missed transfers for 65 attendees' }, { fields }).some((p) => p.includes('duplicates')));
  assert.ok(thumbs.checkBrief({ ...b, visual_direction: 'letterbox it with black bars' }, { fields }).some((p) => p.includes('letterbox')));
  // Batch check: a video asset with no brief fails the batch.
  const pkg = { platforms: { instagram_reel: { fields }, linkedin: { fields: { post: 'x' } } } };
  assert.equal(thumbs.batchCheck(pkg).length, 1);
  pkg.thumbnails = thumbs.briefsForPackage(pkg, profile, []).thumbnails;
  assert.equal(thumbs.batchCheck(pkg).length, 0);
}

// ---- Module 7: feedback loop ----------------------------------------------------
{
  const iso = (d) => new Date(Date.parse('2026-09-01T12:00:00Z') + d * 86400000).toISOString();
  const mk = (id, pillarId, templateId, metrics, day) => ({ id, topic: `Topic ${id} about shuttles ${id}`, angle: '', pillarId, createdAt: iso(day), hook: templateId ? { templateId, text: 'x' } : null, platforms: { instagram_post: { fields: {} } }, publishedUrls: { instagram_post: `https://instagram.com/p/${id}` }, performance: { instagram_post: { ...metrics, likes: 999 } } });
  store.packageStore.set({ items: [
    mk('p1', 'events', 'seed-specific-number', { bookedCalls: 2, dms: 5, saves: 10 }, 0),
    mk('p2', 'events', 'seed-invisible-work', { bookedCalls: 0, dms: 9, saves: 40 }, 1),
    mk('p3', 'retreat', 'seed-curiosity-gap', { dms: 1, saves: 100, shares: 50 }, 2),
    mk('p4', 'retreat', 'seed-contrarian-belief', { saves: 1 }, 3),
    mk('p5', 'retreat', 'seed-insider-confession', { follows: 2 }, 4),
  ] });
  store.leadStore.set({ items: [
    { id: 'l1', email: 'a@x.com', status: 'won', source: { utm_source: 'instagram_post', utm_content: 'p3' } },
    { id: 'l2', email: 'b@x.com', status: 'call_booked', bookedAt: iso(5), source: { utm_source: 'instagram_post', utm_campaign: feedback.slugOf('Topic p4 about shuttles p4') } },
  ], settings: {} });
  const rows = feedback.contentRows();
  assert.equal(rows.find((r) => r.pkgId === 'p3').metrics.bookedCalls, 1, 'lead attribution by package id');
  assert.equal(rows.find((r) => r.pkgId === 'p4').metrics.bookedCalls, 1, 'lead attribution by campaign slug');
  assert.ok(!('likes' in rows[0].metrics), 'likes leaked into metrics');
  // Hierarchy: booked calls dominate everything below them.
  assert.equal(rows[0].pkgId, 'p1');
  const w = feedback.weeklyPromote(Date.parse('2026-10-05T12:00:00Z'));
  assert.equal(w.winner.pillarId, 'events');
  assert.deepEqual(w.promoted.sort(), ['seed-invisible-work', 'seed-specific-number']);
  assert.equal(hooks.getHook('seed-specific-number').source, 'promoted');
  const b = feedback.biweeklyRetire(Date.parse('2026-10-05T12:00:00Z'));
  assert.equal(b.retired.length, 1);
  assert.equal(b.retired[0].pkgId, 'p5', 'the lowest scorer should retire');
  assert.ok(feedback.retiredAngleClash('Topic p5 about shuttles p5', '', { id: 'new', createdAt: '2026-10-06T00:00:00Z' }), 'a rewording of a retired angle must clash');
  assert.equal(feedback.retiredAngleClash('Villa amenities for the retreat', '', { id: 'new', createdAt: '2026-10-06T00:00:00Z' }), null);
  const rep = feedback.report();
  assert.equal(rep.retired[0].pkgId, 'p5');
  assert.ok(rep.promotedHooks.length >= 2);
  hooks.recordUse('seed-specific-number', new Date('2026-10-05T12:00:00Z'));
  const shift = feedback.hookShift(Date.parse('2026-10-05T12:00:00Z'));
  assert.equal(shift.at(-1).promotedShare, 1);
}

// ---- publishing protocol ----------------------------------------------------
{
  const plan = pacing.schedule(['linkedin', 'instagram_reel', 'facebook', 'linkedin'], { seed: 'p', now: Date.parse('2026-10-09T13:00:00Z') });
  for (const p of plan) {
    assert.ok(p.suggestedAt, `${p.platformId} got no slot`);
    const d = new Date(p.suggestedAt);
    const min = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', minute: '2-digit' }).format(d));
    assert.notEqual(min % 5, 0, 'scheduled on a round minute');
  }
  const li = plan.filter((p) => p.platformId === 'linkedin').map((p) => new Date(p.suggestedAt));
  const day = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'short' }).format(d);
  assert.notEqual(day(li[0]), day(li[1]), 'LinkedIn cap is one a day');
  for (const d of li) assert.ok(!['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(d)), 'LinkedIn on a weekend');
  const text = 'We moved sixty five attendees through two airports without a single missed transfer and this is how.';
  assert.ok(pacing.varianceIssue('linkedin', { post: text }, [{ platformId: 'linkedin', pkgId: 'old', fields: { post: text } }]));
  assert.equal(pacing.varianceIssue('linkedin', { post: text }, [{ platformId: 'instagram_post', fields: { caption: text } }]), null);
  const others = [{ id: 'a', name: 'Conscious Creator', profile: { publishing: { automation: { instagram_reel: { allowed: true } } } } }, { id: 'b', name: 'Travel GHR', profile: {} }];
  assert.equal(pacing.canGrant('b', others).ok, false, 'second funnel granted without volume justification');
  assert.equal(pacing.canGrant('b', others, { volumeJustified: true }).ok, true);
  assert.equal(pacing.canGrant('a', others).ok, true);
  assert.ok(pacing.instructionFor(['instagram_reel']).includes('post it'));
}

// ---- reviews and entity checks ------------------------------------------------
{
  const now = Date.parse('2026-10-05T12:00:00Z');
  const v = reviews.velocity([{ platform: 'google', count: 10, at: '2026-07-01' }, { platform: 'google', count: 13, at: '2026-09-05' }, { platform: 'google', count: 16, at: '2026-10-05' }], now);
  assert.equal(v.google.count, 16);
  assert.equal(v.google.per30, 3);
  const leads = [
    { id: '1', email: 'a@x.com', status: 'won', wonAt: '2026-09-20T00:00:00Z' },
    { id: '2', email: 'b@x.com', status: 'won', wonAt: '2026-10-04T00:00:00Z' },
    { id: '3', email: 'c@x.com', status: 'won', wonAt: '2026-09-01T00:00:00Z', reviewRequest: { status: 'sent' } },
    { id: '4', email: 'd@x.com', status: 'won', wonAt: '2026-09-01T00:00:00Z', unsubscribed: true },
    { id: '5', email: 'e@x.com', status: 'qualified' },
  ];
  assert.deepEqual(reviews.eligible(leads, { delayDays: 7 }, now).map((l) => l.id), ['1']);
  const exp = entity.expectedEntity(profile);
  assert.deepEqual(entity.checkPage('Travel GHR, Edwardsville. Call 618-954-7979.', exp).issues, []);
  assert.ok(entity.checkPage('Travel GHR. Call (314) 555-0100.', exp).issues[0].startsWith('different phone'));
  assert.ok(entity.checkPage('Some other agency.', exp).issues.includes('business name not found'));
  const fake = async (url) => ({ status: 200, html: `<html><body>Travel GHR 618.954.7979 ${url}</body></html>` });
  const run = await entity.runEntityCheck({ ...profile, business: { ...profile.business, links: { website: 'https://travelghr.com', linkedin: 'https://linkedin.com/in/x' } } }, { fetchPage: fake });
  assert.equal(run.results.length, 2);
  assert.ok(run.results.find((r) => r.url.includes('linkedin')).skipped);
  assert.equal(run.issues, 0);
}

console.log('modules 2, 3, 4, 6, 7, pacing, reviews, entity: all assertions passed');
process.exit(0);
