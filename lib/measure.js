// The measurement loop: after a Short (or long-form video) is registered as
// live, pull what actually happened at 48 hours, 7 days and 28 days, read the
// retention curve for the exact second viewers leave, and turn the measured
// history into a short "what works for this channel" block that the next
// piece of copy is written against.
//
// Everything is per workspace: each brand connects its own channel, and each
// brand learns only from its own results. Numbers come from the YouTube Data
// and Analytics APIs (lib/google.js). Nothing is ever posted from here.

import { packageStore, studioStore, stateStore, listWorkspaces, runWithWorkspace } from './store.js';
import * as g from './google.js';
import { claudeJson, providerStatus } from './providers.js';

const HOURS = [48, 168, 672]; // 48h, 7d, 28d checkpoints
const HOUR_MS = 3600 * 1000;
const dashless = (s) => String(s == null ? '' : s).replace(/\s*[—–]\s*/g, ', ');

export const videoIdOf = (url) => String(url || '').match(/(?:shorts\/|v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1] || null;

const liveUrlOf = (pkg) => pkg.publishedUrls?.youtube_shorts || pkg.publishedUrls?.youtube_long || null;

export function canMeasure() {
  const cfg = g.googleConfig();
  return g.isConnected() || cfg.apiKey;
}

// ---- retention -----------------------------------------------------------

// Plain-language reading of the retention curve. Points are
// {t: 0..1 of the video, ratio: share still watching (can exceed 1 when
// people rewatch or loop)}.
export function retentionFindings(points, durationSec) {
  const pts = (points || []).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.ratio)).sort((a, b) => a.t - b.t);
  if (pts.length < 5 || !durationSec) return null;
  const at = (sec) => {
    const target = Math.min(1, sec / durationSec);
    return pts.reduce((best, p) => (Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best), pts[0]).ratio;
  };
  const hookHold = at(2);
  const midHold = at(durationSec / 2);
  const endHold = pts[pts.length - 1].ratio;
  // Biggest drop over any 8 percent window.
  let drop = { atSeconds: 0, amount: 0 };
  const step = Math.max(1, Math.round(pts.length * 0.08));
  for (let i = 0; i + step < pts.length; i++) {
    const d = pts[i].ratio - pts[i + step].ratio;
    if (d > drop.amount) drop = { atSeconds: Math.round(pts[i].t * durationSec * 10) / 10, amount: Math.round(d * 100) / 100 };
  }
  const verdicts = [];
  if (hookHold < 0.7) verdicts.push(`Only ${Math.round(hookHold * 100)}% are still watching at 2 seconds. The opening line or first frame is not earning the watch: rewrite the hook and make the first image the strongest one.`);
  else verdicts.push(`${Math.round(hookHold * 100)}% hold through the first 2 seconds, so the opening works.`);
  if (drop.amount >= 0.15) verdicts.push(`The biggest drop is around ${drop.atSeconds}s (${Math.round(drop.amount * 100)} points). Look at what happens there: a slow beat, a long text card, or a cut that resets attention.`);
  if (endHold >= 0.5) verdicts.push('Half or more are still there at the end, which is what makes a Short loop and get re-served.');
  else if (endHold < 0.25) verdicts.push(`Only ${Math.round(endHold * 100)}% reach the end. A shorter cut or a tighter middle will lift this.`);
  return { hookHold: round2(hookHold), midHold: round2(midHold), endHold: round2(endHold), drop, verdicts };
}
const round2 = (n) => Math.round(n * 100) / 100;

// 100 points is plenty to draw, and far too much to store per snapshot.
const condense = (pts, n = 25) => {
  if (!pts?.length) return undefined;
  const step = Math.max(1, Math.floor(pts.length / n));
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => ({ t: round2(p.t), ratio: round2(p.ratio) }));
};

// ---- snapshots -------------------------------------------------------------

export async function takeSnapshot(pkgId, { checkpoint = null } = {}) {
  const pkg = packageStore.get().items.find((p) => p.id === pkgId);
  if (!pkg) throw new Error('unknown package');
  const url = liveUrlOf(pkg);
  const videoId = videoIdOf(url);
  if (!videoId) throw new Error('register the live YouTube URL first');
  if (!canMeasure()) throw new Error('connect YouTube for this business (or set YOUTUBE_API_KEY on the server) to read results');

  const errors = [];
  let details = null;
  try { details = (await g.videoDetails([videoId]))[0] || null; } catch (err) { errors.push(`public numbers: ${String(err.message).slice(0, 140)}`); }
  if (!details && !g.isConnected()) throw new Error(errors[0] || 'YouTube returned nothing for that video');
  const publishedAt = details?.publishedAt || pkg.results?.publishedAt || null;
  const durationSec = details?.durationSec || pkg.short?.master?.duration || 0;

  let analytics = null;
  if (g.isConnected()) {
    analytics = await g.videoAnalytics(videoId, publishedAt).catch((err) => { errors.push(`analytics: ${String(err.message).slice(0, 140)}`); return null; });
    if (analytics?.errors?.length) errors.push(...analytics.errors);
  }
  const ageHours = publishedAt ? Math.round((Date.now() - Date.parse(publishedAt)) / HOUR_MS) : null;
  const snap = {
    at: new Date().toISOString(), checkpoint, ageHours, publishedAt, durationSec,
    source: analytics?.views != null ? 'analytics' : 'public',
    // Analytics lags a day or two; the public count is the floor.
    views: Math.max(analytics?.views || 0, details?.views || 0),
    likes: Math.max(analytics?.likes || 0, details?.likes || 0),
    comments: Math.max(analytics?.comments || 0, details?.comments || 0),
    shares: analytics?.shares, subs: analytics?.subs, minutes: analytics?.minutes,
    avd: analytics?.avd, avp: analytics?.avp, engagedViews: analytics?.engagedViews,
    traffic: analytics?.traffic?.slice(0, 6),
    retention: condense(analytics?.retention),
    findings: retentionFindings(analytics?.retention, durationSec) || undefined,
    errors: errors.length ? errors : undefined,
  };
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== pkgId) return p;
      const prev = p.results || {};
      p.results = {
        ...prev, publishedAt: publishedAt || prev.publishedAt || null, videoId,
        lastCheckedAt: snap.at,
        snapshots: [...(prev.snapshots || []), snap].slice(-12),
      };
      return p;
    }),
  }));
  return snap;
}

export function saveManual(pkgId, { viewedPct, note }) {
  const pct = Number(viewedPct);
  if (!(pct >= 0 && pct <= 100)) throw new Error('viewed percentage must be between 0 and 100');
  let out = null;
  packageStore.update((s) => ({
    items: s.items.map((p) => {
      if (p.id !== pkgId) return p;
      p.results = { ...(p.results || {}), manual: { viewedPct: pct, note: dashless(note || '').slice(0, 300), at: new Date().toISOString() } };
      out = p;
      return p;
    }),
  }));
  if (!out) throw new Error('unknown package');
  return out.results.manual;
}

const dueCheckpoint = (pkg, now = Date.now()) => {
  const pub = pkg.results?.publishedAt ? Date.parse(pkg.results.publishedAt) : null;
  if (!pub) return pkg.results?.snapshots?.length ? null : 0; // learn the publish time first
  const taken = new Set((pkg.results?.snapshots || []).map((s) => s.checkpoint).filter((c) => c != null));
  return HOURS.find((h) => now >= pub + h * HOUR_MS && !taken.has(h)) ?? null;
};

// ---- learning from the measured history -----------------------------------

const chicagoParts = (iso) => {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(new Date(iso));
    return { hour: Number(f.find((x) => x.type === 'hour').value) % 24, weekday: f.find((x) => x.type === 'weekday').value };
  } catch { return null; }
};

const latestSnap = (p) => {
  const snaps = p.results?.snapshots || [];
  return snaps.slice().sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0))[0] || null;
};

export function learningRows() {
  const rows = [];
  for (const p of packageStore.get().items) {
    const snap = latestSnap(p);
    if (!snap || snap.views == null) continue;
    const f = p.platforms?.youtube_shorts?.fields || p.platforms?.youtube_long?.fields || {};
    const title = String(f.title || p.topic || '');
    const when = snap.publishedAt ? chicagoParts(snap.publishedAt) : null;
    // One number for "did the opening work": the viewer-reported viewed
    // percentage when she typed it from Studio, else the measured 2 second hold.
    const openingScore = p.results?.manual?.viewedPct ?? (snap.findings ? Math.round(snap.findings.hookHold * 100) : null);
    rows.push({
      id: p.id, kind: p.platforms?.youtube_shorts ? 'short' : 'long', title,
      durationSec: Math.round(snap.durationSec || 0), titleLen: title.length,
      hook: String(p.short?.copy?.hook || f.hook || '').slice(0, 120),
      hookScore: p.short?.copy?.hookScore ?? null,
      audio: p.short?.master?.audio?.startsWith('silent') ? 'silent' : p.short ? 'audio' : null,
      fit: p.short?.master?.fit || null,
      hour: when?.hour ?? null, weekday: when?.weekday ?? null,
      ageHours: snap.ageHours, views: snap.views, avp: snap.avp ?? null, avd: snap.avd ?? null,
      openingScore, endHold: snap.findings?.endHold ?? null,
      engagement: snap.views ? round2((snap.likes + snap.comments + (snap.shares || 0)) / snap.views) : null,
      subs: snap.subs ?? null,
    });
  }
  return rows;
}

const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

export function learningSummary() {
  const rows = learningRows().filter((r) => r.kind === 'short');
  const out = { measured: rows.length, rows };
  if (rows.length < 4) return out;
  const rank = (r) => (r.openingScore ?? r.avp ?? 0) * 1000 + Math.log10(1 + r.views);
  const sorted = rows.slice().sort((a, b) => rank(b) - rank(a));
  out.best = sorted.slice(0, 3);
  out.weakest = sorted.slice(-3).reverse();
  const short = rows.filter((r) => r.durationSec && r.durationSec <= 30);
  const long = rows.filter((r) => r.durationSec > 30);
  if (short.length >= 2 && long.length >= 2) {
    out.lengthBands = { upTo30s: { n: short.length, medianViews: median(short.map((r) => r.views)), medianAvp: median(short.map((r) => r.avp)) }, over30s: { n: long.length, medianViews: median(long.map((r) => r.views)), medianAvp: median(long.map((r) => r.avp)) } };
  }
  if (rows.length >= 5) {
    const byHour = {};
    for (const r of rows) if (r.hour != null) (byHour[r.hour] ||= []).push(r.views);
    const hours = Object.entries(byHour).filter(([, v]) => v.length >= 2).map(([h, v]) => ({ hour: Number(h), n: v.length, medianViews: median(v) })).sort((a, b) => b.medianViews - a.medianViews);
    if (hours.length) out.bestHour = hours[0];
  }
  return out;
}

// The block handed to copy generation. Only exists once there is enough
// measured history to say anything, and only states what was measured.
export function learningBlock() {
  const sum = learningSummary();
  const saved = studioStore.get().measure?.insights;
  if (sum.measured < 4) return '';
  const line = (r) => `"${r.title}" (${r.durationSec}s, ${r.views} views${r.avp != null ? `, ${Math.round(r.avp)}% average viewed` : ''}${r.openingScore != null ? `, opening held ${r.openingScore}%` : ''}${r.hook ? `, hook: ${r.hook}` : ''})`;
  const parts = ['\n--- RESULTS FROM THIS CHANNEL (measured, not guesses) ---',
    `Best performing Shorts: ${sum.best.map(line).join(' | ')}`,
    `Weakest: ${sum.weakest.map(line).join(' | ')}`];
  if (sum.lengthBands) parts.push(`By length: up to 30s median ${sum.lengthBands.upTo30s.medianViews} views over ${sum.lengthBands.upTo30s.n} Shorts; over 30s median ${sum.lengthBands.over30s.medianViews} over ${sum.lengthBands.over30s.n}.`);
  if (saved?.findings?.length) parts.push(`Findings: ${saved.findings.join(' ')}`);
  parts.push('Use this to choose the hook pattern, title shape and length for the new Short. Never copy a past title or hook; learn the pattern. Small samples: treat as direction, not law.');
  return parts.join('\n');
}

export async function generateInsights() {
  const sum = learningSummary();
  if (sum.measured < 3) throw new Error('measure at least 3 Shorts first (results arrive 48 hours after each one is registered)');
  if (!providerStatus().anthropic) throw new Error('insights need the Claude key');
  const profile = stateStore.get().profile;
  const out = await claudeJson({
    tier: 'light', usageBucket: 'light', maxTokens: 1200,
    system: 'You analyze short-form video results for a travel creator. Use only the numbers given. Say plainly when a sample is too small to conclude. Never use em dashes or en dashes. Never criticize or compare against any travel business, platform, or advisor.',
    messages: [{ role: 'user', content: `Brand: ${profile.business?.name || ''}. Measured Shorts (JSON):\n${JSON.stringify(sum.rows.map(({ id, ...r }) => r)).slice(0, 9000)}\n\nRespond with ONLY JSON: {"findings": ["3 to 5 plain-language findings, each citing the numbers behind it"], "doNext": ["3 concrete changes for the next Shorts"]}. Never put a double quote inside a value.` }],
  });
  const clean = (a) => (Array.isArray(a) ? a : []).map((x) => dashless(x).slice(0, 320)).filter(Boolean).slice(0, 6);
  const insights = { at: new Date().toISOString(), basedOn: sum.measured, findings: clean(out.findings), doNext: clean(out.doNext) };
  studioStore.update((s) => ({ ...s, measure: { ...(s.measure || {}), insights } }));
  return insights;
}

// ---- channel audit ----------------------------------------------------------

export async function channelAudit(profile) {
  const ch = await g.myChannel();
  const biz = profile.business || {};
  const host = (() => { try { return new URL(biz.links?.website).host.replace(/^www\./, ''); } catch { return ''; } })();
  const hay = `${ch.title}\n${ch.description}`.toLowerCase();
  const checks = [];
  const add = (label, pass, fix) => checks.push({ label, pass: !!pass, fix: pass ? null : fix });
  add('Channel name carries the brand or your name',
    [biz.name, biz.person?.name].filter(Boolean).some((n) => ch.title.toLowerCase().includes(String(n).toLowerCase().split(' ')[0])),
    'Make the channel name match the brand or person name used on every other surface, so engines resolve one entity.');
  add('About text names you and the brand', [biz.name, biz.person?.name].filter(Boolean).every((n) => hay.includes(String(n).toLowerCase())),
    `Name ${[biz.person?.name, biz.name].filter(Boolean).join(' and ')} in the first lines of the About text.`);
  add('About text links your own site', !host || hay.includes(host), `Put ${host} in the About text so the channel is wired to your site.`);
  add('About text states what you cover and where', !biz.location || hay.includes(String(biz.location).split(',')[0].toLowerCase()), `Mention ${String(biz.location || '').split(',')[0]} and your niche in plain words.`);
  add('Channel keywords are set', ch.keywords.trim().length > 5, 'Add channel keywords in Studio, Settings, Channel, Basic info.');
  add('A handle is set', !!ch.customUrl, 'Claim a handle so the channel has one stable public address.');
  return { channel: ch, checks, at: new Date().toISOString() };
}

// ---- overview + scheduler ---------------------------------------------------

export function overview() {
  const videos = [];
  for (const p of packageStore.get().items) {
    const url = liveUrlOf(p);
    if (!url) continue;
    const snap = latestSnap(p);
    videos.push({
      id: p.id, topic: p.topic, kind: p.kind || 'package', url, publishedAt: p.results?.publishedAt || null,
      lastCheckedAt: p.results?.lastCheckedAt || null, snapshots: (p.results?.snapshots || []).length,
      latest: snap ? { views: snap.views, avp: snap.avp, avd: snap.avd, ageHours: snap.ageHours, findings: snap.findings?.verdicts?.[0] || null } : null,
      manual: p.results?.manual || null,
    });
  }
  const cfg = g.googleConfig();
  return {
    config: cfg, connected: g.isConnected(), channel: g.connectedChannel(),
    videos, learning: learningSummary(), insights: studioStore.get().measure?.insights || null,
  };
}

let sweeping = false;
export async function sweepMeasure() {
  if (sweeping) return;
  sweeping = true;
  let budget = 8;
  try {
    for (const w of listWorkspaces().items) {
      await runWithWorkspace(w.id, async () => {
        if (!canMeasure()) return;
        for (const p of packageStore.get().items) {
          if (budget <= 0) return;
          if (!liveUrlOf(p)) continue;
          const cp = dueCheckpoint(p);
          if (cp == null) continue;
          budget -= 1;
          try { await takeSnapshot(p.id, { checkpoint: cp || null }); } catch (err) { console.warn(`measure ${p.id}: ${err.message}`); }
        }
      });
    }
  } finally {
    sweeping = false;
  }
}

export function scheduleMeasure() {
  if (process.env.DISABLE_MEASURE) return;
  setTimeout(() => sweepMeasure().catch(() => {}), Number(process.env.MEASURE_FIRST_RUN_MS || 6 * 60 * 1000)).unref?.();
  setInterval(() => sweepMeasure().catch(() => {}), 3 * HOUR_MS).unref?.();
  console.log('  measure: results sweep every 3 hours (48h, 7d, 28d checkpoints) once YouTube is connected');
}
