// Content Plan (autopilot drafting). Per business, the creator keeps a plan:
// items (a platform set, a cadence, a queue of topics) plus an approved fact
// list. When the plan is enabled the studio drafts each due item into the
// approval queue by calling the normal generation pipeline, then runs
// pre-flight checks so blockers are visible before the creator approves.
//
// Hard rules: OFF by default, nothing is ever approved or posted here, the
// server never touches a browser (the Chrome handoff stays on the creator's
// computer), and every run is capped. All state lives in the workspace
// profile (profile.contentPlan) and is read through per-workspace handles,
// so the scheduler never depends on, or changes, the active workspace.

import { PLATFORMS } from './platforms.js';
import { scorePackage, packageText, STAT_PATTERN } from './visibility.js';
import { crossPostCheck } from './formats.js';
import { batchCheck } from './thumbs.js';
import { retiredAngleClash } from './feedback.js';
import { providerStatus } from './providers.js';
import { generatePackage } from './engine.js';
import { listWorkspaces, workspaceHandle, uid, runWithWorkspace } from './store.js';

export const FACT_LABELS = ['live search', 'project file', 'creator direct', 'general knowledge (possibly stale)'];
const TOPIC_STATUS = ['queued', 'drafted', 'skipped'];
const CADENCE_TYPES = ['weekly', 'daily', 'manual'];

// Token guards. One draft is a full generation (one model call per
// platform plus the answer layer), so both limits are deliberately small.
export const MAX_PER_RUN = 3;
export const DAILY_DRAFT_CAP = 6;
const DAY_MS = 24 * 3600 * 1000;
const DUE_SOON_MS = 48 * 3600 * 1000;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// Next occurrence strictly after `from`. Times are server time (UTC).
export function nextDue(cadence, from = new Date()) {
  if (!cadence || cadence.type === 'manual') return null;
  const at = new Date(from);
  at.setUTCMinutes(0, 0, 0);
  at.setUTCHours(cadence.hour ?? 9);
  if (cadence.type === 'daily') {
    if (at <= from) at.setUTCDate(at.getUTCDate() + 1);
    return at.toISOString();
  }
  const weekday = cadence.weekday ?? 1;
  at.setUTCDate(at.getUTCDate() + ((weekday - at.getUTCDay() + 7) % 7));
  if (at <= from) at.setUTCDate(at.getUTCDate() + 7);
  return at.toISOString();
}

function normCadence(c = {}) {
  const type = CADENCE_TYPES.includes(c.type) ? c.type : 'manual';
  if (type === 'manual') return { type };
  const out = { type, hour: clampInt(c.hour, 0, 23, 9) };
  if (type === 'weekly') out.weekday = clampInt(c.weekday, 0, 6, 1);
  return out;
}

// Validates and normalizes a plan coming from the UI. Fields only the
// server may set (topic status 'drafted' and its packageId, lastRunAt,
// nextDueAt, lastError) are carried over from the stored plan by id, so a
// stale browser tab can never un-draft a topic or erase a run record.
export function normalizePlan(input = {}, existing = {}) {
  const oldItems = new Map((existing.items || []).map((i) => [i.id, i]));
  const now = new Date();
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 12).map((raw) => {
    const id = raw.id || uid();
    const old = oldItems.get(id) || {};
    const oldTopics = new Map((old.topics || []).map((t) => [t.id, t]));
    const cadence = normCadence(raw.cadence);
    const topics = (Array.isArray(raw.topics) ? raw.topics : []).slice(0, 60)
      .map((t) => {
        const tid = t.id || uid();
        const prev = oldTopics.get(tid);
        const drafted = prev?.status === 'drafted';
        const status = drafted ? 'drafted' : (TOPIC_STATUS.includes(t.status) && t.status !== 'drafted' ? t.status : 'queued');
        const out = { id: tid, topic: str(t.topic, 300), status };
        if (str(t.angle, 300)) out.angle = str(t.angle, 300);
        if (str(t.notes, 600)) out.notes = str(t.notes, 600);
        if (drafted && prev.packageId) out.packageId = prev.packageId;
        return out;
      })
      .filter((t) => t.topic);
    const cadenceSame = JSON.stringify(cadence) === JSON.stringify(old.cadence);
    const item = {
      id,
      title: str(raw.title, 80) || 'Untitled item',
      platformIds: [...new Set((raw.platformIds || []).filter((p) => PLATFORMS[p]))],
      cadence,
      maxPerRun: clampInt(raw.maxPerRun, 1, MAX_PER_RUN, 1),
      topics,
      lastRunAt: old.lastRunAt || null,
      nextDueAt: cadence.type === 'manual' ? null : (cadenceSame && old.nextDueAt) || nextDue(cadence, now),
      lastError: old.lastError || null,
    };
    if (str(raw.ctaUrl, 300)) item.ctaUrl = str(raw.ctaUrl, 300);
    return item;
  });
  const facts = (Array.isArray(input.facts) ? input.facts : []).slice(0, 80)
    .map((f) => ({
      id: f.id || uid(),
      text: str(f.text, 500),
      source: str(f.source, 300),
      label: FACT_LABELS.includes(f.label) ? f.label : FACT_LABELS[2],
    }))
    .filter((f) => f.text);
  return { enabled: input.enabled === true, facts, items };
}

export const getPlan = (profile) => normalizePlan(profile?.contentPlan || {}, profile?.contentPlan || {});

// ---- pre-flight ----------------------------------------------------------

// Unresolved placeholders. [LINK] is deliberately absent: it is resolved at
// publish time from the tracked CTA link. [ON CAMERA] style script cues are
// absent too.
const PLACEHOLDER = /\[(?:FILL\b[^\]]*|ARTICLE URL|(?:INSERT|YOUR|ADD|TBD|TODO|PLACEHOLDER|URL|DATE|PRICE|PHONE|ADDRESS)\b[^\]]*)\]/g;

const flat = (v) => (v == null ? '' : Array.isArray(v) ? v.map(flat).join('\n') : typeof v === 'object' ? Object.values(v).map(flat).join('\n') : String(v));
const plain = (s) => String(s || '').replace(/\s+[—–]\s+/g, ': ').replace(/[—–]/g, '-');

// Rubric checks that are hard blockers when they fail. They are read from
// scorePackage so the regexes live in one place (lib/visibility.js).
const BLOCKING_CHECKS = {
  blocklist: 'blocklist',
  industry_respect: 'industry_respect',
  industry_respect_comparative: 'industry_respect_comparative',
  no_dashes: 'no_dashes',
};

// Returns { blockers, warnings }. Each entry is {code, platformId?, message}.
// Blockers keep a draft from being called ready; warnings are advisory.
export function preflight(pkg, profile) {
  const blockers = [];
  const warnings = [];
  const seen = new Set();
  const push = (list, entry) => {
    const key = `${entry.code}|${entry.platformId || ''}|${entry.message}`;
    if (!seen.has(key)) { seen.add(key); list.push(entry); }
  };

  // The answer layer travels with the package (Website Kit, JSON-LD), so it
  // is checked as one more pseudo platform alongside the real ones.
  const scopes = Object.entries(pkg.platforms || {}).map(([id, p]) => [id, p]);
  scopes.push(['answer layer', { fields: {
    definition: pkg.definition, quotable: pkg.quotable,
    faq: (pkg.faq || []).map((f) => `${f.q || f.question || ''}\n${f.a || f.answer || ''}`),
    citeLines: pkg.citeLines, queryMap: pkg.queryMap,
  } }]);

  for (const [platformId, p] of scopes) {
    if (p.error) {
      push(blockers, { code: 'generation_error', platformId, message: `Fell back to template copy (${plain(p.error)}). Regenerate or edit before approving.` });
    }
    const scoped = scorePackage({ ...pkg, platforms: { [platformId]: p } }, profile);
    for (const c of scoped.checks || []) {
      if (BLOCKING_CHECKS[c.id] && !c.pass) {
        push(blockers, { code: c.id, platformId, message: plain(c.fix || c.label) });
      }
    }
    if (p.gate?.status === 'blocked') {
      for (const v of p.gate.voice || []) push(blockers, { code: 'voice_gate', platformId, message: `Voice card: ${v.message} ("${v.span}")` });
      for (const f of p.gate.format || []) push(blockers, { code: 'format_gate', platformId, message: `Format: ${f.message}` });
      for (const b of p.gate.blocked || []) push(blockers, { code: 'fact_gate', platformId, message: `Unverified claim: "${b.claim}". Add it to the knowledge base or remove it.` });
    }
    const hits = [...new Set(flat(p.fields).match(PLACEHOLDER) || [])];
    for (const h of hits) {
      push(blockers, { code: 'placeholder', platformId, message: `Unresolved placeholder ${h}. Fill it in before approving.` });
    }
  }

  // Cross-posting, thumbnail briefs, retired angles (Modules 4, 6, 7).
  for (const c of crossPostCheck(pkg)) push(blockers, { code: 'cross_post', platformId: c.platformId, message: c.message });
  if (pkg.qualityGate || pkg.thumbnails) for (const t of batchCheck(pkg)) push(blockers, { code: 'thumbnail_brief', platformId: t.platformId, message: t.message });
  const clash = retiredAngleClash(pkg.topic, pkg.angle, pkg);
  if (clash) push(blockers, { code: 'retired_angle', message: `This repeats a retired bottom performer ("${clash.topic}"). A replacement needs a genuinely new angle.` });

  // Numeric claims with no source anywhere in the approved facts or the
  // creator's profile are only a warning: the creator may know the number.
  const known = `${flat((profile?.contentPlan?.facts || []).map((f) => f.text))}\n${flat(profile?.business)}\n${flat(profile?.interview)}`;
  const claims = [...new Set([...packageText(pkg).matchAll(new RegExp(STAT_PATTERN.source, 'gi'))].map((m) => m[0].trim()))];
  const unsourced = claims.filter((c) => {
    const num = c.match(/\d[\d,.]*/)?.[0];
    return num && !known.includes(num);
  }).slice(0, 6);
  if (unsourced.length) {
    push(warnings, { code: 'unsourced_number', message: `Numbers with no matching approved fact or profile entry: ${unsourced.join(', ')}. Confirm them or add a fact.` });
  }
  return { blockers, warnings };
}

// ---- queue ---------------------------------------------------------------

const draftRows = (pkg, profile, items) => {
  const item = items.find((i) => i.id === pkg.planItemId);
  const { blockers, warnings } = preflight(pkg, profile);
  const platformIds = Object.keys(pkg.platforms || {});
  const approved = platformIds.filter((id) => pkg.approvals?.[id]?.approved);
  const published = platformIds.filter((id) => pkg.publishedUrls?.[id]);
  return {
    packageId: pkg.id,
    topic: pkg.topic,
    itemId: pkg.planItemId,
    itemTitle: item?.title || null,
    createdAt: pkg.createdAt,
    score: pkg.visibility?.score ?? null,
    platformIds,
    pendingPlatformIds: platformIds.filter((id) => !approved.includes(id)),
    approvedPlatformIds: approved.filter((id) => !published.includes(id)),
    blockers,
    warnings,
    ready: blockers.length === 0,
    publishLink: `#/publish?pkg=${pkg.id}`,
  };
};

export function planQueue(wsId) {
  const h = workspaceHandle(wsId);
  if (!h) return null;
  const profile = h.state.get().profile || {};
  const plan = getPlan(profile);
  const rows = h.packages.get().items.filter((p) => p.planItemId).map((p) => draftRows(p, profile, plan.items));
  const now = Date.now();
  return {
    enabled: plan.enabled,
    drafts: rows.filter((r) => r.pendingPlatformIds.length),
    approved: rows.filter((r) => r.approvedPlatformIds.length),
    dueSoon: plan.items
      .filter((i) => i.cadence.type !== 'manual' && i.nextDueAt && Date.parse(i.nextDueAt) - now < DUE_SOON_MS)
      .map((i) => ({
        itemId: i.id, title: i.title, nextDueAt: i.nextDueAt,
        overdue: Date.parse(i.nextDueAt) <= now,
        queued: i.topics.filter((t) => t.status === 'queued').length,
      })),
  };
}

// ---- drafting ------------------------------------------------------------

const inflight = new Set();
const isDue = (item, now) => item.cadence.type !== 'manual' && item.nextDueAt && Date.parse(item.nextDueAt) <= now;

// Mutates the stored plan in place by id (the user may have edited it while
// a generation was running), then lets the jsonFile flush on its own timer.
function patchItem(h, itemId, fn) {
  h.state.update((s) => {
    const item = s.profile?.contentPlan?.items?.find((i) => i.id === itemId);
    if (item) fn(item);
    return s;
  });
}

const draftsToday = (h) => h.packages.get().items
  .filter((p) => p.planItemId && Date.now() - Date.parse(p.createdAt) < DAY_MS).length;

// Drafts the next queued topics for the due items (or the one named item,
// due or not). Never approves, never posts. Returns what happened.
export async function runPlan(wsId, { itemId, now = Date.now() } = {}) {
  const h = workspaceHandle(wsId);
  if (!h) return { ran: false, reason: 'unknown workspace' };
  const profile0 = h.state.get().profile || {};
  const plan0 = profile0.contentPlan;
  if (!plan0?.enabled) return { ran: false, reason: 'Content Plan is switched off for this business.' };
  if (!providerStatus().anthropic) return { ran: false, reason: 'No Claude key configured, so nothing can be drafted.' };
  if (inflight.has(wsId)) return { ran: false, reason: 'A run is already in progress for this business.' };

  const targets = (plan0.items || []).filter((i) => (itemId ? i.id === itemId : isDue(i, now)));
  if (itemId && !targets.length) return { ran: false, reason: 'Unknown plan item.' };
  const result = { ran: true, drafted: [], skipped: [], errors: [] };
  if (!targets.length) return { ...result, reason: 'Nothing is due.' };

  inflight.add(wsId);
  try {
    for (const target of targets) {
      const item = target;
      let budget = Math.min(item.maxPerRun, MAX_PER_RUN);
      try {
        if (!item.platformIds.length) throw new Error('No platforms chosen for this item.');
        const queued = item.topics.filter((t) => t.status === 'queued');
        if (!queued.length) result.skipped.push({ itemId: item.id, reason: 'No queued topics.' });
        for (const topic of queued) {
          if (budget <= 0) break;
          if (draftsToday(h) >= DAILY_DRAFT_CAP) {
            result.skipped.push({ itemId: item.id, reason: `Daily draft cap (${DAILY_DRAFT_CAP}) reached.` });
            break;
          }
          budget -= 1;
          const profile = h.state.get().profile;
          const pkg = await runWithWorkspace(wsId, () => generatePackage({
            profile,
            topic: topic.topic,
            angle: [topic.angle, topic.notes && `Notes from the creator: ${topic.notes}`].filter(Boolean).join('. ') || undefined,
            platformIds: item.platformIds,
            ctaUrl: item.ctaUrl,
          }));
          pkg.planItemId = item.id;
          pkg.topicId = topic.id;
          h.packages.update((s) => ({ items: [pkg, ...s.items] }));
          patchItem(h, item.id, (it) => {
            const t = it.topics.find((x) => x.id === topic.id);
            if (t) { t.status = 'drafted'; t.packageId = pkg.id; }
          });
          result.drafted.push({ itemId: item.id, topicId: topic.id, packageId: pkg.id });
        }
        patchItem(h, item.id, (it) => {
          it.lastRunAt = new Date(now).toISOString();
          it.nextDueAt = nextDue(it.cadence, new Date(Math.max(now, Date.now())));
          it.lastError = null;
        });
      } catch (err) {
        const message = String(err.message || err).slice(0, 300);
        // Advance the schedule on failure too: a broken item must not retry
        // (and spend tokens) every hour until someone notices.
        patchItem(h, item.id, (it) => {
          it.lastError = message;
          it.nextDueAt = nextDue(it.cadence, new Date(Math.max(now, Date.now())));
        });
        result.errors.push({ itemId: item.id, error: message });
      }
    }
  } finally {
    inflight.delete(wsId);
  }
  return result;
}

export const planRunning = (wsId) => inflight.has(wsId);

// ---- scheduler -----------------------------------------------------------

// Hourly due-check across EVERY workspace, through per-workspace handles
// (never the active-workspace singleton). One workspace failing never stops
// the others; failures land on the item as lastError.
export async function planTick(now = Date.now()) {
  const out = [];
  for (const w of listWorkspaces().items) {
    try {
      const h = workspaceHandle(w.id);
      const plan = h?.state.get().profile?.contentPlan;
      if (!plan?.enabled) continue;
      const r = await runPlan(w.id, { now });
      if (r.drafted?.length || r.errors?.length) {
        console.log(`  plan: ${w.name || w.id}: ${r.drafted.length} drafted, ${r.errors.length} failed`);
      }
      out.push({ workspaceId: w.id, ...r });
    } catch (err) {
      console.warn(`  plan: ${w.name || w.id}: ${err.message}`);
      out.push({ workspaceId: w.id, ran: false, reason: String(err.message || err) });
    }
  }
  return out;
}

export function schedulePlan() {
  setTimeout(() => planTick().catch((err) => console.warn(`  plan: tick failed: ${err.message}`)), 120 * 1000);
  setInterval(() => planTick().catch((err) => console.warn(`  plan: tick failed: ${err.message}`)), 3600 * 1000).unref?.();
  console.log('  plan: hourly due-check on (drafts only for workspaces with Content Plan enabled)');
}
