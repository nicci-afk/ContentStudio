// Meta metrics by API: saves, shares and follows for published Instagram and
// Facebook posts, pulled from the Graph API so the feedback loop (Module 7)
// does not depend on hand entry. DMs are not exposed by the API and booked
// calls come from leads, so those stay manual and attributed.
//
// Per workspace: an access token plus the Instagram professional account id
// and/or the Facebook Page id, kept in meta-auth.json (never in backups,
// never returned to the browser). Read-only: nothing is ever posted.

import { metaAuthStore, packageStore, listWorkspaces, runWithWorkspace } from './store.js';

// Same base and version variables as the Conversions API sender in
// lib/leads.js, so one META_GRAPH_URL override points both at one host.
const GRAPH = () => `${(process.env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '')}/${process.env.META_GRAPH_VERSION || 'v24.0'}`;
const DAY = 86400000;

export function metaStatus() {
  const a = metaAuthStore.get() || {};
  return { connected: !!a.accessToken && !!(a.igUserId || a.pageId), igUserId: a.igUserId || '', pageId: a.pageId || '', connectedAt: a.connectedAt || null, lastSync: a.lastSync || null, lastError: a.lastError || null };
}

export function saveMetaAuth({ accessToken, igUserId, pageId }) {
  const cur = metaAuthStore.get() || {};
  const clean = (v) => String(v || '').replace(/[^0-9]/g, '').slice(0, 30);
  metaAuthStore.set({ ...cur, accessToken: accessToken ? String(accessToken).trim().slice(0, 500) : cur.accessToken, igUserId: igUserId !== undefined ? clean(igUserId) : cur.igUserId, pageId: pageId !== undefined ? clean(pageId) : cur.pageId, connectedAt: new Date().toISOString(), lastError: null });
  return metaStatus();
}
export const disconnectMeta = () => { metaAuthStore.set({}); return metaStatus(); };

async function graph(pathAndQuery, token) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const res = await fetch(`${GRAPH()}/${pathAndQuery.replace(/^\//, '')}${sep}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`meta ${res.status}: ${String(body.error?.message || res.statusText).slice(0, 160)}`);
  return body;
}

// Instagram permalinks: /p/<code>/, /reel/<code>/, /tv/<code>/.
export const igCode = (url) => String(url || '').match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] || null;

// Media insights; metric availability varies by media type, so each metric
// is asked for on its own and a refusal for one never sinks the others.
async function igInsights(mediaId, token) {
  const out = {};
  for (const [metric, key] of [['saved', 'saves'], ['shares', 'shares'], ['follows', 'follows']]) {
    try {
      const r = await graph(`${mediaId}/insights?metric=${metric}`, token);
      const v = r.data?.[0]?.values?.[0]?.value ?? r.data?.[0]?.total_value?.value;
      if (Number.isFinite(Number(v))) out[key] = Number(v);
    } catch { /* metric not offered for this media type */ }
  }
  return out;
}

async function findIgMedia(igUserId, token, code) {
  let next = `${igUserId}/media?fields=id,permalink&limit=50`;
  for (let page = 0; page < 6 && next; page++) {
    const r = await graph(next, token);
    const hit = (r.data || []).find((m) => igCode(m.permalink) === code);
    if (hit) return hit.id;
    const after = r.paging?.cursors?.after;
    next = r.paging?.next && after ? `${igUserId}/media?fields=id,permalink&limit=50&after=${after}` : null;
  }
  return null;
}

async function fbPostShares(pageId, token, url) {
  const norm = (u) => String(u || '').replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/\/$/, '');
  let next = `${pageId}/posts?fields=id,permalink_url,shares&limit=50`;
  for (let page = 0; page < 6 && next; page++) {
    const r = await graph(next, token);
    const hit = (r.data || []).find((p) => norm(p.permalink_url) === norm(url));
    if (hit) return { shares: Number(hit.shares?.count || 0) };
    const after = r.paging?.cursors?.after;
    next = r.paging?.next && after ? `${pageId}/posts?fields=id,permalink_url,shares&limit=50&after=${after}` : null;
  }
  return null;
}

const IG_PLATFORMS = ['instagram_reel', 'instagram_post', 'instagram_carousel'];
const FB_PLATFORMS = ['facebook', 'facebook_reel'];

// Pulls numbers for every published IG/FB asset under 90 days old in the
// active workspace. Stored beside the owner's numbers as performance[p].api;
// the feedback loop takes the larger of the two per metric.
export async function syncMeta(now = Date.now()) {
  const a = metaAuthStore.get() || {};
  if (!a.accessToken || !(a.igUserId || a.pageId)) throw new Error('connect Meta for this business first');
  const results = [];
  const updates = {};
  for (const p of packageStore.get().items) {
    for (const [platformId, url] of Object.entries(p.publishedUrls || {})) {
      const at = Date.parse(p.publishedAt?.[platformId] || p.createdAt || 0);
      if (now - at > 90 * DAY) continue;
      try {
        let metrics = null;
        if (IG_PLATFORMS.includes(platformId) && a.igUserId) {
          const code = igCode(url);
          const id = code && await findIgMedia(a.igUserId, a.accessToken, code);
          if (id) metrics = await igInsights(id, a.accessToken);
        } else if (FB_PLATFORMS.includes(platformId) && a.pageId) {
          metrics = await fbPostShares(a.pageId, a.accessToken, url);
        } else continue;
        if (!metrics) { results.push({ pkgId: p.id, platformId, status: 'not found on the connected account' }); continue; }
        (updates[p.id] ||= {})[platformId] = { ...metrics, fetchedAt: new Date(now).toISOString() };
        results.push({ pkgId: p.id, platformId, status: 'ok', metrics });
      } catch (err) {
        results.push({ pkgId: p.id, platformId, status: 'error', error: String(err.message).slice(0, 160) });
      }
    }
  }
  packageStore.update((s) => ({ items: s.items.map((p) => {
    if (!updates[p.id]) return p;
    const perf = { ...(p.performance || {}) };
    for (const [pid, api] of Object.entries(updates[p.id])) perf[pid] = { ...(perf[pid] || {}), api };
    return { ...p, performance: perf };
  }) }));
  const errors = results.filter((r) => r.status === 'error');
  metaAuthStore.update((x) => ({ ...x, lastSync: new Date(now).toISOString(), lastError: errors[0]?.error || null }));
  return { synced: results.filter((r) => r.status === 'ok').length, results };
}

let sweeping = false;
export async function sweepMeta() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const w of listWorkspaces().items) {
      await runWithWorkspace(w.id, async () => {
        const st = metaStatus();
        if (!st.connected) return;
        if (st.lastSync && Date.now() - Date.parse(st.lastSync) < 20 * 3600 * 1000) return;
        try { await syncMeta(); } catch (err) { console.warn(`meta ${w.id}: ${err.message}`); }
      });
    }
  } finally { sweeping = false; }
}

export function scheduleMeta() {
  if (process.env.DISABLE_META_SYNC) return;
  setTimeout(() => sweepMeta().catch(() => {}), Number(process.env.META_FIRST_RUN_MS || 15 * 60 * 1000)).unref?.();
  setInterval(() => sweepMeta().catch(() => {}), 6 * 3600 * 1000).unref?.();
}
