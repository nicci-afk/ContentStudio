// Module 7: performance feedback loop. Makes each month smarter than the
// last instead of just bigger.
//
// Metrics hierarchy, in order: booked calls, DMs, saves, shares, follows.
// Likes are not a metric, ever, and are dropped if sent.
//
// Sources: per-asset numbers the owner enters from each platform's insights
// (Meta has no API connection here), plus booked calls and signed agreements
// attributed automatically from leads whose tracked link names the package
// (utm_content = package id, or utm_source + utm_campaign from older links).
//
// Cadence (per workspace, each run logged):
//   weekly     rank content, promote the winning pillar's hook templates
//   biweekly   retire the bottom quartile; replacements need a new angle
//   monthly    feed first-party trend observations into Module 3
//   quarterly  lead magnet review
// Nothing here posts, emails, or changes copy. It only re-ranks, labels and reports.

import { packageStore, leadStore, studioStore, stateStore, listWorkspaces, runWithWorkspace } from './store.js';
import { perfScore, getHook, updateStats, listHooks } from './hooks.js';
import { importTrends } from './trendinputs.js';

export const METRICS = ['bookedCalls', 'dms', 'saves', 'shares', 'follows'];
const DAY = 86400000;
const BOOKED = ['call_booked', 'won'];

export const slugOf = (topic) => String(topic || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

export function cleanMetrics(raw = {}) {
  const out = {};
  for (const k of METRICS) {
    const n = Math.floor(Number(raw[k]));
    if (Number.isFinite(n) && n >= 0) out[k] = Math.min(n, 1e7);
  }
  return out;
}

// leads -> {pkgId: {platformId: {leads, booked, signed}}}
export function attributeLeads(pkgs, leads) {
  const bySlug = new Map(pkgs.map((p) => [slugOf(p.topic), p.id]));
  const ids = new Set(pkgs.map((p) => p.id));
  const out = {};
  for (const l of leads) {
    if (l.test) continue;
    const s = l.source || {};
    const pkgId = ids.has(s.utm_content) ? s.utm_content : bySlug.get(s.utm_campaign) || null;
    const plat = s.utm_source || l.bookingClick?.platformId || null;
    const pid = pkgId || l.bookingClick?.pkgId;
    if (!pid || !plat) continue;
    const row = ((out[pid] ||= {})[plat] ||= { leads: 0, booked: 0, signed: 0 });
    row.leads += 1;
    if (BOOKED.includes(l.status) || l.bookedAt) row.booked += 1;
    if (l.status === 'won') row.signed += 1;
  }
  return out;
}

// One row per published (or measured) asset.
export function contentRows(pkgs = packageStore.get().items, leads = leadStore.get().items || []) {
  const attr = attributeLeads(pkgs, leads);
  const rows = [];
  for (const p of pkgs) {
    for (const platformId of Object.keys(p.platforms || {})) {
      const manual = p.performance?.[platformId] || null;
      const a = attr[p.id]?.[platformId] || null;
      if (!manual && !a && !p.publishedUrls?.[platformId]) continue;
      const metrics = { ...cleanMetrics(manual || {}) };
      // Attribution can only raise booked calls; the owner's count is never lowered.
      if (a) metrics.bookedCalls = Math.max(metrics.bookedCalls || 0, a.booked);
      rows.push({
        pkgId: p.id, platformId, topic: p.topic, angle: p.angle || '', pillarId: p.pillarId || null,
        hookTemplateId: p.hook?.templateId || null, createdAt: p.createdAt, publishedUrl: p.publishedUrls?.[platformId] || null,
        metrics, hasData: !!manual || !!a, leads: a?.leads || 0, signed: a?.signed || 0, score: perfScore(metrics),
        retired: p.retired?.[platformId] || null,
      });
    }
  }
  return rows.sort((x, y) => y.score - x.score);
}

const log = (entry) => studioStore.update((s) => ({ ...s, feedback: { ...(s.feedback || {}), log: [{ at: new Date().toISOString(), ...entry }, ...((s.feedback || {}).log || [])].slice(0, 120) } }));
const fb = () => studioStore.get().feedback || {};
const setFb = (patch) => studioStore.update((s) => ({ ...s, feedback: { ...(s.feedback || {}), ...patch } }));

// Weekly: rank, then promote the winning pillar's hook templates with their
// performance attached. Totals per template are recomputed each run, so a
// re-run never double counts.
export function weeklyPromote(now = Date.now()) {
  const rows = contentRows().filter((r) => r.hasData && !r.retired);
  if (!rows.length) { log({ job: 'weekly', result: 'no performance data yet' }); return { promoted: [], winner: null }; }
  // Template totals.
  const totals = {};
  for (const r of rows) {
    if (!r.hookTemplateId) continue;
    const t = (totals[r.hookTemplateId] ||= Object.fromEntries(METRICS.map((k) => [k, 0])));
    for (const k of METRICS) t[k] += r.metrics[k] || 0;
  }
  for (const [id, t] of Object.entries(totals)) updateStats(id, (s) => ({ ...s, ...t }));
  // Winning pillar by summed score (content with no pillar groups as "none").
  const byPillar = {};
  for (const r of rows) byPillar[r.pillarId || 'none'] = (byPillar[r.pillarId || 'none'] || 0) + r.score;
  const [winner] = Object.entries(byPillar).sort((a, b) => b[1] - a[1]);
  const winnerRows = rows.filter((r) => (r.pillarId || 'none') === winner[0] && r.score > 0);
  const promoted = [...new Set(winnerRows.map((r) => r.hookTemplateId).filter(Boolean))].filter((id) => getHook(id));
  const iso = new Date(now).toISOString();
  for (const id of promoted) {
    updateStats(id, (s) => ({ ...s, promotedAt: s.promotedAt || iso, lastPromotedAt: iso, retiredAt: null, history: [...(s.history || []), { at: iso, event: 'promoted', pillarId: winner[0], ...totals[id] }].slice(-40) }));
  }
  const pillarName = (stateStore.get().profile?.pillars || []).find((p) => p.id === winner[0])?.name || (winner[0] === 'none' ? 'no pillar' : winner[0]);
  log({ job: 'weekly', result: `winning pillar ${pillarName}; promoted ${promoted.length} hook template(s)`, promoted, pillarId: winner[0], top: rows.slice(0, 5).map((r) => ({ pkgId: r.pkgId, platformId: r.platformId, metrics: r.metrics })) });
  return { promoted, winner: { pillarId: winner[0], name: pillarName, score: winner[1] } };
}

// Biweekly: retire the bottom quartile of measured content. Needs at least 4
// measured assets so a quartile means something.
export function biweeklyRetire(now = Date.now()) {
  const rows = contentRows().filter((r) => r.hasData && !r.retired && Date.parse(r.createdAt || 0) < now - 7 * DAY);
  if (rows.length < 4) { log({ job: 'biweekly', result: `only ${rows.length} measured asset(s); need 4 to retire a quartile` }); return { retired: [] }; }
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  const cut = sorted.slice(0, Math.floor(sorted.length / 4));
  const iso = new Date(now).toISOString();
  packageStore.update((s) => ({ items: s.items.map((p) => {
    const mine = cut.filter((r) => r.pkgId === p.id);
    if (!mine.length) return p;
    const retired = { ...(p.retired || {}) };
    for (const r of mine) retired[r.platformId] = { at: iso, reason: 'bottom quartile', metrics: r.metrics };
    return { ...p, retired };
  }) }));
  const entries = cut.map((r) => ({ pkgId: r.pkgId, platformId: r.platformId, topic: r.topic, angle: r.angle, hookTemplateId: r.hookTemplateId, pillarId: r.pillarId, at: iso, metrics: r.metrics }));
  setFb({ retired: [...entries, ...(fb().retired || [])].slice(0, 300) });
  // A template retires only when every one of its 3+ measured uses landed in the cut.
  const cutKeys = new Set(cut.map((r) => `${r.pkgId}|${r.platformId}`));
  for (const h of listHooks()) {
    if (h.source === 'promoted') continue;
    const used = rows.filter((r) => r.hookTemplateId === h.id);
    if (used.length >= 3 && used.every((r) => cutKeys.has(`${r.pkgId}|${r.platformId}`))) updateStats(h.id, (s) => ({ ...s, retiredAt: iso, history: [...(s.history || []), { at: iso, event: 'retired' }].slice(-40) }));
  }
  log({ job: 'biweekly', result: `retired ${cut.length} of ${rows.length} measured assets`, retired: entries.map((e) => `${e.pkgId}/${e.platformId}`) });
  return { retired: entries };
}

// Replacements must use a new angle, not a variation of a retired one.
const words = (s) => new Set((String(s).toLowerCase().match(/[a-z]{4,}/g) || []));
export function retiredAngleClash(topic, angle, pkg = null) {
  const mine = words(`${topic} ${angle || ''}`);
  if (!mine.size) return null;
  for (const r of fb().retired || []) {
    // Only content made after the retirement is a "replacement".
    if (pkg && (r.pkgId === pkg.id || (pkg.createdAt && pkg.createdAt < r.at))) continue;
    const theirs = words(`${r.topic} ${r.angle || ''}`);
    const inter = [...mine].filter((w) => theirs.has(w)).length;
    const jac = inter / (mine.size + theirs.size - inter || 1);
    if (jac >= 0.6) return r;
  }
  return null;
}

export function retiredAnglesBlock() {
  const r = (fb().retired || []).slice(0, 12);
  if (!r.length) return '';
  return `\n--- RETIRED ANGLES (bottom performers; a replacement must take a genuinely new angle, not a rewording) ---\n${r.map((x) => `- ${x.topic}${x.angle ? ` (angle: ${x.angle})` : ''}`).join('\n')}`;
}

// Monthly: the owner's own results become first-party trend observations.
const PATTERN_LABEL = { specific_number: 'open with one specific real number and what it meant', contrarian_belief: 'open by challenging a common belief (never a person or business)', curiosity_gap: 'open with an outcome that did not exist before', insider_confession: 'open with the creator\'s earlier role as the reason for how she works now', invisible_work: 'open with behind-the-scenes work nobody saw' };
export function monthlyFirstParty(now = Date.now()) {
  const rows = contentRows().filter((r) => r.hasData && Date.parse(r.createdAt || 0) > now - 45 * DAY && r.hookTemplateId);
  const byPlatform = {};
  for (const r of rows) (byPlatform[r.platformId] ||= []).push(r);
  const entries = [];
  for (const [platform, rs] of Object.entries(byPlatform)) {
    if (rs.length < 3) continue;
    const byPattern = {};
    for (const r of rs) {
      const pattern = getHook(r.hookTemplateId)?.pattern;
      if (pattern) byPattern[pattern] = (byPattern[pattern] || 0) + r.score;
    }
    const best = Object.entries(byPattern).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0) entries.push({ platform, hook_structure: PATTERN_LABEL[best[0]] || best[0], observed_date: new Date(now).toISOString().slice(0, 10), source: 'first-party' });
  }
  const res = entries.length ? importTrends(entries, now) : { accepted: 0 };
  log({ job: 'monthly', result: entries.length ? `${res.accepted} first-party trend observation(s) recorded` : 'not enough measured content per platform (need 3)' });
  return { entries };
}

// Quarterly: lead magnet review across resources.
export function leadMagnetReview() {
  const rows = leadMagnetRows();
  log({ job: 'quarterly', result: rows.length ? `reviewed ${rows.length} lead magnet(s)` : 'no lead magnet sign-ups yet', rows });
  return rows;
}

export function leadMagnetRows() {
  const leads = (leadStore.get().items || []).filter((l) => !l.test);
  const by = {};
  for (const l of leads) {
    for (const slug of l.resources || []) {
      const r = (by[slug] ||= { resource: slug, leads: 0, applied: 0, booked: 0, signed: 0, unsubscribed: 0 });
      r.leads += 1;
      if (l.stage === 'application' || l.status === 'applied') r.applied += 1;
      if (BOOKED.includes(l.status) || l.bookedAt) r.booked += 1;
      if (l.status === 'won') r.signed += 1;
      if (l.unsubscribed) r.unsubscribed += 1;
    }
  }
  return Object.values(by).sort((a, b) => b.booked - a.booked || b.leads - a.leads);
}

// Share of hook uses per month that came from promoted templates, so the
// 90-day shift toward winners is visible rather than assumed.
export function hookShift(now = Date.now()) {
  const hooks = listHooks({ includeRetired: true });
  const stats = studioStore.get().hookStats || {};
  const months = [];
  for (let i = 2; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  return months.map((m) => {
    let total = 0; let promoted = 0;
    for (const h of hooks) {
      const n = stats[h.id]?.usesByMonth?.[m] || 0;
      total += n;
      const pAt = stats[h.id]?.promotedAt;
      if (pAt && pAt.slice(0, 7) <= m) promoted += n;
    }
    return { month: m, uses: total, promotedUses: promoted, promotedShare: total ? Math.round((promoted / total) * 100) / 100 : null };
  });
}

// What won, what was retired, what replaced it. No silent drift.
export function report() {
  const rows = contentRows();
  const pkgs = packageStore.get().items;
  const retired = (fb().retired || []).map((r) => {
    const replacement = pkgs.filter((p) => p.id !== r.pkgId && (p.pillarId || null) === (r.pillarId || null) && p.createdAt > r.at).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return { ...r, replacedBy: replacement ? { pkgId: replacement.id, topic: replacement.topic, angle: replacement.angle || '', at: replacement.createdAt } : null };
  });
  const hooks = listHooks({ includeRetired: true });
  return {
    entity: stateStore.get().profile?.business?.name || '',
    winners: rows.filter((r) => r.hasData && !r.retired).slice(0, 8),
    measured: rows.filter((r) => r.hasData).length,
    unmeasured: rows.filter((r) => !r.hasData).map((r) => ({ pkgId: r.pkgId, platformId: r.platformId, topic: r.topic, publishedUrl: r.publishedUrl })),
    retired,
    promotedHooks: hooks.filter((h) => h.source === 'promoted'),
    retiredHooks: hooks.filter((h) => h.retiredAt),
    hookShift: hookShift(),
    leadMagnets: leadMagnetRows(),
    log: (fb().log || []).slice(0, 30),
    lastRuns: fb().lastRuns || {},
  };
}

const DUE = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91 };
export function runDue(now = Date.now(), force = null) {
  const last = fb().lastRuns || {};
  const ran = {};
  for (const [job, days] of Object.entries(DUE)) {
    if (force && force !== job) continue;
    if (!force && last[job] && now - Date.parse(last[job]) < days * DAY) continue;
    if (job === 'weekly') ran.weekly = weeklyPromote(now);
    if (job === 'biweekly') ran.biweekly = biweeklyRetire(now);
    if (job === 'monthly') ran.monthly = monthlyFirstParty(now);
    if (job === 'quarterly') ran.quarterly = leadMagnetReview();
    last[job] = new Date(now).toISOString();
  }
  setFb({ lastRuns: last });
  return ran;
}

let sweeping = false;
export async function sweepFeedback() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const w of listWorkspaces().items) {
      await runWithWorkspace(w.id, async () => {
        if (studioStore.get().settings?.feedbackAuto === false) return;
        try { runDue(); } catch (err) { console.warn(`feedback ${w.id}: ${err.message}`); }
      });
    }
  } finally { sweeping = false; }
}

export function scheduleFeedback() {
  if (process.env.DISABLE_FEEDBACK) return;
  setTimeout(() => sweepFeedback().catch(() => {}), Number(process.env.FEEDBACK_FIRST_RUN_MS || 10 * 60 * 1000)).unref?.();
  setInterval(() => sweepFeedback().catch(() => {}), 6 * 3600 * 1000).unref?.();
}
