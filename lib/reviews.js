// Review requests and review velocity, per workspace.
//
// Policy rules baked in (Google and FTC): every signed client gets the same
// request. No gating (never ask only happy clients first), no incentives, no
// asking for a particular star rating, and no reviews written for anyone.
// Requests go out once per client, a set number of days after the deal is
// won, inside business hours, with an unsubscribe link. OFF until switched on.
//
// Velocity is tracked from review counts the owner records from each
// platform (Google Business Profile and Facebook expose no API here).

import { studioStore, leadStore } from './store.js';
import { sendMail, mailConfigured } from './mail.js';
import { leadFrom, inSendWindow } from './leads.js';

const DAY = 86400000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const okUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.toString() : ''; } catch { return ''; } };

export const reviewState = () => {
  const r = studioStore.get().reviews || {};
  return { links: r.links || {}, auto: !!r.auto, delayDays: r.delayDays ?? 7, counts: r.counts || [], log: (r.log || []).slice(0, 50) };
};

export function saveReviewSettings({ links, auto, delayDays }) {
  studioStore.update((s) => {
    const r = s.reviews || {};
    const clean = links ? Object.fromEntries(Object.entries(links).map(([k, v]) => [String(k).slice(0, 30), okUrl(v)]).filter(([, v]) => v)) : r.links;
    return { ...s, reviews: { ...r, links: clean || {}, auto: auto === undefined ? !!r.auto : !!auto, delayDays: delayDays === undefined ? (r.delayDays ?? 7) : Math.min(60, Math.max(1, Number(delayDays) || 7)) } };
  });
  return reviewState();
}

export function recordCount({ platform, count, rating, date }) {
  const c = Math.floor(Number(count));
  if (!platform || !Number.isFinite(c) || c < 0) throw new Error('platform and a review count are required');
  const entry = { platform: String(platform).slice(0, 30).toLowerCase(), count: c, rating: rating === '' || rating == null ? null : Math.max(0, Math.min(5, Number(rating))), at: (date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10)) };
  studioStore.update((s) => ({ ...s, reviews: { ...(s.reviews || {}), counts: [...((s.reviews || {}).counts || []), entry].slice(-500) } }));
  return reviewState();
}

// New reviews per 30 days, per platform, from the recorded counts.
export function velocity(counts = reviewState().counts, now = Date.now()) {
  const by = {};
  for (const c of counts) (by[c.platform] ||= []).push(c);
  const out = {};
  for (const [p, list] of Object.entries(by)) {
    const sorted = list.sort((a, b) => a.at.localeCompare(b.at));
    const latest = sorted[sorted.length - 1];
    const back = (days) => [...sorted].reverse().find((c) => Date.parse(c.at) <= now - days * DAY) || sorted[0];
    const b30 = back(30); const b90 = back(90);
    const span30 = Math.max(1, (Date.parse(latest.at) - Date.parse(b30.at)) / DAY);
    const span90 = Math.max(1, (Date.parse(latest.at) - Date.parse(b90.at)) / DAY);
    out[p] = {
      count: latest.count, rating: latest.rating, asOf: latest.at,
      per30: b30 === latest ? null : Math.round(((latest.count - b30.count) / span30) * 30 * 10) / 10,
      per30over90: b90 === latest ? null : Math.round(((latest.count - b90.count) / span90) * 30 * 10) / 10,
    };
  }
  return out;
}

export function eligible(leads, { delayDays = 7 } = {}, now = Date.now()) {
  return leads.filter((l) => !l.test && !l.unsubscribed && l.email && l.status === 'won' && !l.reviewRequest
    && Date.parse(l.wonAt || l.updatedAt || 0) <= now - delayDays * DAY);
}

export function requestEmail({ lead, brand, person, links, unsubUrl }) {
  const items = Object.entries(links).map(([k, u]) => `<li style="margin:6px 0"><a href="${esc(u)}" style="color:#00566b">${esc(k === 'google' ? 'Google' : k === 'facebook' ? 'Facebook' : k)}</a></li>`).join('');
  const html = `<div style="font-family:Georgia,'Times New Roman',serif;max-width:540px;margin:0 auto;padding:28px 22px;color:#0d1216;line-height:1.55;font-size:16px">
    <p>Hi ${esc(lead.firstName || 'there')},</p>
    <p>Thank you for trusting me with your plans. If you have a minute, an honest review helps other people decide whether working with me is right for them. Whatever your experience was, I would value hearing it.</p>
    <ul style="padding-left:20px">${items}</ul>
    <p>Warmly,<br>${esc(person)}</p>
    <hr style="border:none;border-top:1px solid #d2cdc5;margin:30px 0 14px">
    <p style="font-family:-apple-system,Segoe UI,sans-serif;font-size:12px;color:#777;margin:0">${esc(brand)}. <a href="${esc(unsubUrl)}" style="color:#777">Unsubscribe</a></p></div>`;
  return { subject: `A quick favor, ${lead.firstName || 'friend'}?`, html };
}

export async function sendReviewRequest({ lead, brand, person, unsubUrl }) {
  const { links } = reviewState();
  if (!Object.keys(links).length) return { status: 'skipped', reason: 'no review links saved' };
  if (!mailConfigured()) return { status: 'skipped', reason: 'no email provider configured' };
  const { subject, html } = requestEmail({ lead, brand, person, links, unsubUrl });
  await sendMail({ to: lead.email, subject, html, from: leadFrom(person), headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  return { status: 'sent', at: new Date().toISOString() };
}

const markLead = (id, reviewRequest) => leadStore.update((d) => ({ ...d, items: d.items.map((x) => (x.id === id ? { ...x, reviewRequest } : x)) }));
const logReview = (entry) => studioStore.update((s) => ({ ...s, reviews: { ...(s.reviews || {}), log: [{ at: new Date().toISOString(), ...entry }, ...((s.reviews || {}).log || [])].slice(0, 100) } }));

// One sweep for the active workspace; caller wraps it in runWithWorkspace.
export async function runReviewRequests({ brand, person, base, now = Date.now(), force = false }) {
  const st = reviewState();
  if (!force && (!st.auto || !inSendWindow(now))) return { sent: 0 };
  let sent = 0;
  for (const lead of eligible(leadStore.get().items || [], st, now).slice(0, 5)) {
    try {
      const r = await sendReviewRequest({ lead, brand, person, unsubUrl: `${base}/unsubscribe/${lead.token}` });
      if (r.status === 'sent') { markLead(lead.id, r); sent += 1; logReview({ leadId: lead.id, status: 'sent' }); }
      else { logReview({ leadId: lead.id, status: r.status, reason: r.reason }); break; }
    } catch (err) { logReview({ leadId: lead.id, status: 'error', reason: String(err.message).slice(0, 160) }); }
  }
  return { sent };
}
