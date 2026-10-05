// Anti-flag publishing protocol. The browser extension works in the
// creator's own Chrome, session and IP, which is the least flaggable form of
// help short of her own hand. No method is undetectable, and LinkedIn is the
// strictest surface, so:
// - human approval stays mandatory for every post (approvals + her "post it")
// - posting times are randomized inside each platform's normal window and
//   never land on a round minute
// - posts are spaced apart, with per-platform daily caps
// - each post must differ from what recently went out on that platform
// - extension-completed posting IS automated posting under her standing
//   rule, so it needs an explicit exception per funnel (workspace + platform),
//   and only one funnel may hold exceptions until its own volume justifies a
//   second.

import { overlap } from './formats.js';

// Local-time posting windows (24h) and daily caps per platform.
export const PLATFORM_RULES = {
  linkedin: { windows: [[8, 10], [12, 13]], dailyCap: 1, weekdaysOnly: true, minGapMin: 120 },
  instagram_reel: { windows: [[11, 13], [18, 21]], dailyCap: 2, minGapMin: 90 },
  instagram_post: { windows: [[11, 13], [18, 21]], dailyCap: 2, minGapMin: 90 },
  instagram_carousel: { windows: [[11, 13], [18, 21]], dailyCap: 2, minGapMin: 90 },
  facebook: { windows: [[9, 11], [13, 16]], dailyCap: 2, minGapMin: 90 },
  facebook_reel: { windows: [[12, 14], [18, 21]], dailyCap: 2, minGapMin: 90 },
  youtube_shorts: { windows: [[12, 15], [17, 20]], dailyCap: 2, minGapMin: 60 },
  youtube_long: { windows: [[14, 17]], dailyCap: 1, minGapMin: 60 },
  tiktok: { windows: [[12, 14], [19, 22]], dailyCap: 2, minGapMin: 90 },
  pinterest: { windows: [[20, 23]], dailyCap: 5, minGapMin: 30 },
  gbp: { windows: [[9, 12]], dailyCap: 1, minGapMin: 60 },
  default: { windows: [[10, 16]], dailyCap: 2, minGapMin: 60 },
};
const rules = (id) => PLATFORM_RULES[id] || PLATFORM_RULES.default;

// Deterministic-per-seed randomness so a plan is stable across reloads.
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

const offsetMin = (date, tz) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - date.getTime()) / 60000);
};
// Epoch ms for a local wall-clock time in tz on the given local date.
const localToUtc = (y, m, d, h, min, tz) => {
  const guess = Date.UTC(y, m, d, h, min);
  return guess - offsetMin(new Date(guess), tz) * 60000;
};
const localParts = (ms, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));

// A minute that never looks scheduled: not :00, :15, :30, :45, not a
// multiple of 5.
export const humanMinute = (r) => { let m; do { m = Math.floor(r() * 60); } while (m % 5 === 0); return m; };

// Suggested posting time per asset. `history` is [{platformId, at}] of posts
// already made or planned (the daily caps and gaps count them).
export function schedule(platformIds, { seed = 'x', now = Date.now(), tz = 'America/Chicago', history = [] } = {}) {
  const r = rng(seed);
  const taken = history.map((h) => ({ platformId: h.platformId, at: Date.parse(h.at) })).filter((h) => Number.isFinite(h.at));
  const out = [];
  for (const id of platformIds) {
    const ru = rules(id);
    let placed = null;
    for (let dayOff = 0; dayOff < 21 && !placed; dayOff++) {
      const base = localParts(now + dayOff * 86400000, tz);
      if (ru.weekdaysOnly && ['Sat', 'Sun'].includes(base.weekday)) continue;
      const y = +base.year; const mo = +base.month - 1; const d = +base.day;
      const dayStart = localToUtc(y, mo, d, 0, 0, tz);
      const sameDay = taken.filter((t) => t.platformId === id && t.at >= dayStart && t.at < dayStart + 86400000).length;
      if (sameDay >= ru.dailyCap) continue;
      const windows = [...ru.windows].sort(() => r() - 0.5);
      for (const [h0, h1] of windows) {
        for (let attempt = 0; attempt < 6 && !placed; attempt++) {
          const hour = h0 + Math.floor(r() * Math.max(1, h1 - h0));
          const at = localToUtc(y, mo, d, hour, humanMinute(r), tz) + Math.floor(r() * 50 + 5) * 1000;
          if (at < now + 20 * 60000) continue;
          const clash = taken.some((t) => Math.abs(t.at - at) < (t.platformId === id ? ru.minGapMin : 40) * 60000);
          if (!clash) placed = at;
        }
        if (placed) break;
      }
    }
    if (placed) taken.push({ platformId: id, at: placed });
    out.push({ platformId: id, suggestedAt: placed ? new Date(placed).toISOString() : null, rule: ru });
  }
  return out;
}

const mainText = (f = {}) => f.caption || f.post || f.description || f.body || f.article || '';

// Content variance: the asset must not echo recent posts on the same platform.
export function varianceIssue(platformId, fields, recent = [], threshold = 0.35) {
  for (const r of recent.filter((x) => x.platformId === platformId).slice(0, 10)) {
    const o = overlap(mainText(fields), mainText(r.fields));
    if (o >= threshold) return { with: r.pkgId, overlap: Math.round(o * 100) / 100, message: `${Math.round(o * 100)}% of this text repeats a recent ${platformId} post. Vary it before posting.` };
  }
  return null;
}

// Exceptions: profile.publishing.automation = {platformId: {allowed, grantedAt, note}}.
export const allowedPlatforms = (profile) => Object.entries(profile?.publishing?.automation || {}).filter(([, v]) => v?.allowed).map(([k]) => k);

// otherWorkspaces: [{id, name, profile}] to enforce one funnel at a time.
export function canGrant(wsId, otherWorkspaces, { volumeJustified = false } = {}) {
  const holders = otherWorkspaces.filter((w) => w.id !== wsId && allowedPlatforms(w.profile).length);
  if (holders.length && !volumeJustified) return { ok: false, reason: `Assisted posting is already allowed for ${holders.map((h) => h.name).join(', ')}. Only one funnel may hold exceptions until its own volume justifies a second; confirm that to continue.` };
  return { ok: true };
}

export function instructionFor(allowed = []) {
  if (!allowed.length) return null;
  return `5. Posting exception: I have allowed you to click Post for ${allowed.join(', ')} only, and only like this. For one of those cards, when the post is fully prepared, tell me it is ready and wait for me to reply "post it" for that card in this chat. Then wait until the card's suggested time if it is still ahead, wait a few seconds more, and click Post once. For every other platform, NEVER click Post, Publish, Share, or Schedule: stop and tell me it is ready for my review. Pace yourself like a person: pause a few seconds between fields, do one post per platform per session, and stop at once and tell me if you see a CAPTCHA, a verification step, a warning, or anything unusual.`;
}
