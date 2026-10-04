// YouTube access for the measurement loop: Google OAuth (per workspace, so
// every brand connects its own channel), the YouTube Data API for public
// numbers and channel details, and the YouTube Analytics API for what only
// the channel owner can see (average view duration, retention curve, traffic
// sources).
//
// Env: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (an OAuth "Web application"
// client whose redirect URI is <PUBLIC_BASE_URL>/api/youtube/callback) enable
// the full loop. YOUTUBE_API_KEY alone enables public view/like/comment
// counts and trend watch. Base URLs are overridable so tests can stand in.

import crypto from 'node:crypto';
import { ytAuthStore } from './store.js';

const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const DATA_URL = process.env.YOUTUBE_API_URL || 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_URL = process.env.YT_ANALYTICS_URL || 'https://youtubeanalytics.googleapis.com/v2/reports';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

export class GoogleError extends Error {
  constructor(status, detail) {
    super(`google error ${status}: ${detail}`);
    this.status = status;
  }
}

// A business can bring its OWN Google app (client id and secret saved with its
// YouTube auth, never returned to the browser). That keeps a separate company
// on its own Google Cloud project instead of the server-wide one. Without one
// the server-wide env credentials apply, exactly as before.
const ownApp = () => {
  const a = ytAuthStore.get().app;
  return a?.clientId && a?.clientSecret ? a : null;
};
const creds = () => {
  const a = ownApp();
  return a ? { id: a.clientId, secret: a.clientSecret } : { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
};

export const googleConfig = () => ({
  oauth: !!(creds().id && creds().secret),
  apiKey: !!process.env.YOUTUBE_API_KEY,
  own: !!ownApp(),
  ownClientId: ownApp()?.clientId || null,
});

const CLIENT_ID_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/;
export function saveOwnApp({ clientId, clientSecret }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!CLIENT_ID_RE.test(id)) throw new Error('that does not look like a Google client ID (it ends in .apps.googleusercontent.com)');
  if (secret.length < 10 || /\s/.test(secret)) throw new Error('the client secret looks incomplete');
  // A refresh token belongs to the client that issued it, so switching apps
  // means connecting again.
  ytAuthStore.set({ app: { clientId: id, clientSecret: secret } });
}
export const clearOwnApp = () => ytAuthStore.set({});

export const redirectUri = (base) => `${String(process.env.PUBLIC_BASE_URL || base).replace(/\/$/, '')}/api/youtube/callback`;

// state -> workspace, for the round trip through Google's consent page.
const pending = new Map();

export function startConnect({ workspaceId, base }) {
  if (!googleConfig().oauth) throw new Error('no Google app is set for this business or on the server');
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { workspaceId, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k);
  const q = new URLSearchParams({
    client_id: creds().id,
    redirect_uri: redirectUri(base),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${q}`;
}

export const takeState = (state) => {
  const hit = pending.get(state);
  pending.delete(state);
  return hit && Date.now() - hit.at < 10 * 60 * 1000 ? hit.workspaceId : null;
};

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds().id, client_secret: creds().secret, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new GoogleError(res.status, (await res.text()).slice(0, 300));
  return res.json();
}

// Runs inside the owning workspace's context (runWithWorkspace).
export async function finishConnect({ code, base }) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(base) });
  if (!t.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
  ytAuthStore.set({
    app: ytAuthStore.get().app,
    refresh_token: t.refresh_token, access_token: t.access_token,
    expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000, scope: t.scope,
    connectedAt: new Date().toISOString(),
  });
  const channel = await myChannel();
  ytAuthStore.update((a) => ({ ...a, channel }));
  return channel;
}

export const isConnected = () => !!ytAuthStore.get().refresh_token;
export const connectedChannel = () => ytAuthStore.get().channel || null;
export const disconnect = () => ytAuthStore.set(ytAuthStore.get().app ? { app: ytAuthStore.get().app } : {});

async function accessToken() {
  const a = ytAuthStore.get();
  if (!a.refresh_token) return null;
  if (a.access_token && a.expires_at > Date.now() + 60 * 1000) return a.access_token;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh_token });
  ytAuthStore.update((x) => ({ ...x, access_token: t.access_token, expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000 }));
  return t.access_token;
}

async function getJson(url, { auth }) {
  const headers = {};
  let u = url;
  if (auth) {
    const tok = await accessToken();
    if (!tok) throw new Error('YouTube is not connected for this business');
    headers.authorization = `Bearer ${tok}`;
  } else if (process.env.YOUTUBE_API_KEY) {
    u += `${u.includes('?') ? '&' : '?'}key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`;
  } else {
    throw new Error('set YOUTUBE_API_KEY (or connect YouTube) to read public numbers');
  }
  const res = await fetch(u, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new GoogleError(res.status, (await res.text()).slice(0, 300));
  return res.json();
}

// Data API calls prefer the owner's token (no key quota) and fall back to the key.
const dataGet = (path, params) => {
  const q = new URLSearchParams(params);
  return getJson(`${DATA_URL}/${path}?${q}`, { auth: isConnected() });
};

export async function myChannel() {
  const d = await getJson(`${DATA_URL}/channels?${new URLSearchParams({ part: 'snippet,statistics,brandingSettings', mine: 'true' })}`, { auth: true });
  const c = d.items?.[0];
  if (!c) throw new Error('no YouTube channel found on that Google account');
  return {
    id: c.id, title: c.snippet?.title || '', customUrl: c.snippet?.customUrl || '',
    description: c.snippet?.description || '', keywords: c.brandingSettings?.channel?.keywords || '',
    country: c.snippet?.country || '', subscribers: Number(c.statistics?.subscriberCount) || null,
    videos: Number(c.statistics?.videoCount) || null,
  };
}

export const parseDuration = (iso) => {
  const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
};

export async function videoDetails(ids) {
  const d = await dataGet('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') });
  return (d.items || []).map((v) => ({
    id: v.id, title: v.snippet?.title || '', channelId: v.snippet?.channelId, channelTitle: v.snippet?.channelTitle || '',
    publishedAt: v.snippet?.publishedAt || null, description: v.snippet?.description || '',
    durationSec: parseDuration(v.contentDetails?.duration),
    views: Number(v.statistics?.viewCount) || 0, likes: Number(v.statistics?.likeCount) || 0,
    comments: Number(v.statistics?.commentCount) || 0,
  }));
}

async function report(params) {
  const q = new URLSearchParams({ ids: 'channel==MINE', ...params });
  return getJson(`${ANALYTICS_URL}?${q}`, { auth: true });
}

const rowsToObjects = (r) => (r.rows || []).map((row) => Object.fromEntries((r.columnHeaders || []).map((h, i) => [h.name, row[i]])));
const day = (d) => new Date(d).toISOString().slice(0, 10);

// Owner-only numbers for one video. Each query is independent: one failing
// (a metric a channel or video type does not support) never sinks the rest,
// and every failure is reported by name instead of swallowed.
export async function videoAnalytics(videoId, publishedAt) {
  const startDate = day(publishedAt || Date.now() - 28 * 86400000);
  const endDate = day(Date.now());
  const base = { startDate, endDate, filters: `video==${videoId}` };
  const out = { errors: [] };
  const attempt = async (name, fn) => { try { return await fn(); } catch (err) { out.errors.push(`${name}: ${String(err.message).slice(0, 140)}`); return null; } };

  const core = await attempt('core', async () => rowsToObjects(await report({ ...base,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewDurationPercentage,likes,comments,shares,subscribersGained' }))[0]);
  if (core) Object.assign(out, {
    views: Number(core.views) || 0, minutes: Number(core.estimatedMinutesWatched) || 0,
    avd: Number(core.averageViewDuration) || 0, avp: Number(core.averageViewDurationPercentage) || 0,
    likes: Number(core.likes) || 0, comments: Number(core.comments) || 0, shares: Number(core.shares) || 0,
    subs: Number(core.subscribersGained) || 0,
  });

  const engaged = await attempt('engagedViews', async () => rowsToObjects(await report({ ...base, metrics: 'engagedViews' }))[0]);
  if (engaged && engaged.engagedViews != null) out.engagedViews = Number(engaged.engagedViews) || 0;

  const traffic = await attempt('traffic', async () => rowsToObjects(await report({ ...base, metrics: 'views', dimensions: 'insightTrafficSourceType', sort: '-views' })));
  if (traffic) out.traffic = traffic.map((r) => ({ source: r.insightTrafficSourceType, views: Number(r.views) || 0 }));

  const retention = await attempt('retention', async () => rowsToObjects(await report({ ...base, metrics: 'audienceWatchRatio,relativeRetentionPerformance', dimensions: 'elapsedVideoTimeRatio' })));
  if (retention?.length) out.retention = retention.map((r) => ({ t: Number(r.elapsedVideoTimeRatio), ratio: Number(r.audienceWatchRatio), rel: Number(r.relativeRetentionPerformance) }));
  return out;
}

// ---- trend watch: public data only ---------------------------------------

export async function searchShortForm({ query, publishedAfter, maxResults = 25, regionCode = 'US' }) {
  const s = await dataGet('search', {
    part: 'snippet', type: 'video', videoDuration: 'short', order: 'viewCount', maxResults: String(maxResults),
    q: query, publishedAfter, regionCode, relevanceLanguage: 'en',
  });
  const ids = (s.items || []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const details = await videoDetails(ids);
  return details.filter((v) => v.durationSec > 0 && v.durationSec <= 180);
}
