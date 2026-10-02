// Lead capture: a per-workspace lead store fed by a secret-keyed ingest
// endpoint (the Google Form bridge posts here), a transparent A/B/C triage
// score, an inbox alert, and an optional server-side Meta Conversions API
// Lead event that only ever fires for people who gave consent.
//
// Privacy rules baked in:
// - The ingest allowlist below is the ONLY data accepted. Health, allergy,
//   dietary and accessibility answers (and free-text essay answers) are not
//   fields here, so they cannot be stored even if a client sends them.
// - Meta receives a hashed email, the lead tier, and the site/brand. Never a
//   name, phone, or any application answer.

import crypto from 'node:crypto';
import { sendMail, mailConfigured } from './mail.js';

const STATUSES = ['new', 'contacted', 'qualified', 'applied', 'won', 'lost'];
export const leadStatuses = () => STATUSES.slice();

const clip = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const url = (v) => {
  const t = clip(v, 300);
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : /^[\w.-]+\.[a-z]{2,}/i.test(t) ? `https://${t}` : '';
};
const email = (v) => {
  const t = clip(v, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : '';
};

// Accept only these fields. Anything else in the payload is dropped.
export function normalizeLead(p = {}) {
  const niche = (Array.isArray(p.niche) ? p.niche : String(p.niche || '').split(/,\s*/))
    .map((x) => clip(x, 60)).filter(Boolean).slice(0, 20);
  const tags = p.sourceTags || {};
  return {
    firstName: clip(p.firstName, 80),
    lastName: clip(p.lastName, 80),
    email: email(p.email),
    phone: clip(p.phone, 40),
    cityState: clip(p.cityState, 100),
    agency: clip(p.agency, 120),
    yearsAdvisor: clip(p.yearsAdvisor, 120),
    niche,
    contentSource: clip(p.contentSource, 160),
    instagramUrl: url(p.instagramUrl),
    facebookUrl: url(p.facebookUrl),
    websiteUrl: url(p.websiteUrl),
    howHeard: clip(p.howHeard, 120),
    consent: p.consent === true,
    source: {
      utm_source: clip(tags.utm_source, 80),
      utm_medium: clip(tags.utm_medium, 80),
      utm_campaign: clip(tags.utm_campaign, 120),
      utm_content: clip(tags.utm_content, 120),
      fbclid: clip(tags.fbclid, 300),
      page: url(tags.page),
    },
    fbc: clip(p.fbc, 200),
    fbp: clip(p.fbp, 200),
    test: p.test === true,
  };
}

// Transparent triage score. It orders your follow-up; it never rejects anyone.
export function scoreLead(l) {
  let points = 0;
  const reasons = [];
  const add = (n, why) => { points += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); };
  const yrs = l.yearsAdvisor.toLowerCase();
  if (yrs.includes('not a travel advisor')) add(-2, 'not a travel advisor');
  else if (yrs.startsWith('10') || yrs.startsWith('5')) add(2, 'established advisor (5+ years)');
  else if (yrs.startsWith('2')) add(1, 'advisor for 2 to 5 years');
  else if (yrs.startsWith('under')) add(0, 'advisor under 2 years');
  const links = [l.instagramUrl, l.facebookUrl, l.websiteUrl].filter(Boolean).length;
  if (links) add(Math.min(links, 2), `${links} public profile link${links > 1 ? 's' : ''}`);
  const cs = l.contentSource.toLowerCase();
  if (cs.startsWith('mostly original')) add(2, 'mostly original content');
  else if (cs.startsWith('a mix')) add(1, 'mix of original and supplier content');
  if (l.niche.some((n) => !/still defining/i.test(n))) add(1, 'has a defined niche');
  if (l.agency) add(1, 'named agency or business');
  const tier = points >= 6 ? 'A' : points >= 3 ? 'B' : 'C';
  return { tier, points, reasons };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function alertHtml(l, brand) {
  const row = (k, v) => (v ? `<tr><td style="padding:4px 12px 4px 0;color:#777;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${v}</td></tr>` : '');
  const name = `${l.firstName} ${l.lastName}`.trim() || l.email;
  const src = [l.source.utm_source, l.source.utm_campaign, l.howHeard && `heard via ${l.howHeard}`].filter(Boolean).join(' / ');
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;padding:8px">
    <h2 style="margin:0 0 4px">${esc(l.test ? '[TEST] ' : '')}${l.stage === 'resource' ? 'New resource lead' : `New ${esc(l.score.tier)} application`} for ${esc(brand)}</h2>
    <p style="color:#777;margin:0 0 14px">${esc(name)} (score ${l.score.points}: ${esc(l.score.reasons.join(', ') || 'no signals')})</p>
    <table style="font-size:14px;border-collapse:collapse">
      ${row('Email', `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>`)}
      ${row('Phone', esc(l.phone))}
      ${row('Location', esc(l.cityState))}
      ${row('Business', esc(l.agency))}
      ${row('Experience', esc(l.yearsAdvisor))}
      ${row('Sells', esc(l.niche.join(', ')))}
      ${row('Content', esc(l.contentSource))}
      ${row('Instagram', l.instagramUrl && `<a href="${esc(l.instagramUrl)}">${esc(l.instagramUrl)}</a>`)}
      ${row('Facebook', l.facebookUrl && `<a href="${esc(l.facebookUrl)}">${esc(l.facebookUrl)}</a>`)}
      ${row('Website', l.websiteUrl && `<a href="${esc(l.websiteUrl)}">${esc(l.websiteUrl)}</a>`)}
      ${row('Stage', esc(l.stage === 'resource' ? 'Downloaded a free resource' : 'Submitted an application'))}
      ${row('Resources', esc((l.resources || []).join(', ')))}
      ${row('Source', esc(src))}
    </table>
    <p style="color:#999;font-size:12px;margin-top:16px">The full application, including logistics answers, stays in your Google Sheet. Reply to this lead promptly: the first reply matters most.</p>
  </div>`;
}

export async function notifyLead(lead, { to, brand }) {
  if (!to) return { status: 'skipped', reason: 'no notification email set' };
  if (!mailConfigured()) return { status: 'skipped', reason: 'no email provider configured' };
  const name = `${lead.firstName} ${lead.lastName}`.trim() || lead.email;
  await sendMail({
    to,
    subject: `${lead.test ? '[TEST] ' : ''}${lead.stage === 'resource' ? 'New resource lead' : `New ${lead.score.tier} application`}: ${name} (${brand})`,
    html: alertHtml(lead, brand),
    replyTo: lead.email,
  });
  return { status: 'sent' };
}

const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

// Server-side Lead event. Consent required; hashed email only.
export async function sendLeadToMeta(lead, { pixelId, site, brand, eventName = 'Lead', eventId }) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { status: 'skipped', reason: 'META_CAPI_TOKEN not set' };
  if (!pixelId) return { status: 'skipped', reason: 'no pixel id on the profile' };
  if (lead.test) return { status: 'skipped', reason: 'test lead' };
  if (!lead.consent) return { status: 'skipped', reason: 'no consent on file' };
  if (!lead.email) return { status: 'skipped', reason: 'no email' };
  const ver = process.env.META_GRAPH_VERSION || 'v24.0';
  const user = { em: [sha(lead.email)] };
  if (lead.fbc) user.fbc = lead.fbc;
  if (lead.fbp) user.fbp = lead.fbp;
  const body = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId || lead.id,
      action_source: 'website',
      event_source_url: lead.source.page || site || undefined,
      user_data: user,
      custom_data: { site: String(site || '').replace(/^https?:\/\//, '').replace(/\/$/, ''), brand, lead_tier: lead.score.tier },
    }],
    ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {}),
  };
  const res = await fetch(`${process.env.META_GRAPH_URL || 'https://graph.facebook.com'}/${ver}/${encodeURIComponent(pixelId)}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { status: 'error', reason: (await res.text()).slice(0, 200) };
  return { status: 'sent' };
}

export function newLeadKey() {
  return crypto.randomBytes(24).toString('hex');
}

// Insert or update (by email). `extra` carries server-set fields (stage,
// resource, opt-in proof, tokens) that never come from the client payload.
// Returns { lead, duplicate, firstApplication, newResource }.
export function upsertLead(store, raw, extra = {}) {
  const n = normalizeLead(raw);
  if (!n.email) return { error: 'a valid email is required' };
  const now = new Date().toISOString();
  const data = store.get();
  const existing = data.items.find((x) => x.email === n.email && !!x.test === n.test);
  if (existing) {
    // A resubmission can fill in or update fields but never erase them.
    const empty = (v) => v === '' || v == null || (Array.isArray(v) && !v.length);
    const merged = { ...existing };
    for (const [k, v] of Object.entries(n)) {
      if (k === 'source') merged.source = { ...existing.source, ...Object.fromEntries(Object.entries(v).filter(([, x]) => !empty(x))) };
      else if (k === 'consent' || k === 'test') merged[k] = k === 'consent' ? existing.consent || v : existing.test;
      else if (!empty(v)) merged[k] = v;
    }
    const firstApplication = extra.stage === 'application' && existing.stage !== 'application';
    const newResource = !!extra.resource && !(existing.resources || []).includes(extra.resource);
    if (extra.stage === 'application') { merged.stage = 'application'; merged.appliedAt = existing.appliedAt || now; }
    if (extra.resource) merged.resources = [...new Set([...(existing.resources || []), extra.resource])];
    if (extra.optIn && !existing.optIn) merged.optIn = extra.optIn;
    merged.token = existing.token || crypto.randomBytes(24).toString('hex');
    merged.score = scoreLead(merged);
    merged.updatedAt = now;
    store.set({ ...data, items: data.items.map((x) => (x.id === existing.id ? merged : x)) });
    return { lead: merged, duplicate: true, firstApplication, newResource };
  }
  const score = scoreLead(n);
  const stage = extra.stage || 'application';
  const lead = {
    id: crypto.randomBytes(8).toString('hex'), token: crypto.randomBytes(24).toString('hex'),
    ...n, score, stage, resources: extra.resource ? [extra.resource] : [], optIn: extra.optIn || null,
    ...(stage === 'application' ? { appliedAt: now } : {}),
    status: 'new', notes: '', createdAt: now, updatedAt: now, notify: null, capi: null, unsubscribed: false,
  };
  store.set({ ...data, items: [lead, ...data.items] });
  return { lead, duplicate: false, firstApplication: stage === 'application', newResource: !!extra.resource };
}

export function leadSummary(items) {
  const real = items.filter((l) => !l.test);
  const count = (fn) => real.reduce((a, l) => { const k = fn(l) || 'unknown'; a[k] = (a[k] || 0) + 1; return a; }, {});
  return {
    total: real.length,
    byTier: count((l) => l.score?.tier),
    byStatus: count((l) => l.status),
    bySource: count((l) => l.source?.utm_source || l.howHeard),
    byStage: count((l) => l.stage),
    unsubscribed: real.filter((l) => l.unsubscribed).length,
  };
}

// The script the creator pastes into the Sheet that receives the Form
// responses. Explicit allowlist: it reads only these question titles.
export function buildAppsScript({ endpoint, key }) {
  return `// Content Studio bridge for the application Form.
// Sends ONLY the fields listed in FIELDS. Allergy, dietary, mobility and
// accessibility answers, and the long written answers, never leave this Sheet.

const ENDPOINT = '${endpoint}';
const INGEST_KEY = '${key}';

// Each value is the START of the question title in your Form (case insensitive).
const FIELDS = {
  firstName: 'First Name',
  lastName: 'Last Name',
  email: 'Email Address',
  phone: 'Mobile Phone Number',
  cityState: 'City & State',
  agency: 'Agency or Business Name',
  yearsAdvisor: 'How long have you been working as a travel advisor',
  niche: 'What do you primarily sell',
  contentSource: 'Where does most of your current social content come from',
  instagramUrl: 'Your Instagram profile URL',
  facebookUrl: 'Your Facebook business page URL',
  websiteUrl: 'Your website URL',
  howHeard: 'How did you hear about The Conscious Creator',
};

// Optional questions you add to the Form. If absent, nothing breaks.
const CONSENT_LABEL = 'I agree to be contacted';   // checkbox; ticking it counts as consent
const SOURCE_LABEL = 'Source';                      // short answer, can be pre-filled by the site

function pick_(nv, label) {
  const key = Object.keys(nv).find((k) => k.toLowerCase().startsWith(label.toLowerCase()));
  return key ? String((nv[key] || [''])[0] || '').trim() : '';
}

function buildPayload_(nv) {
  const p = {};
  Object.keys(FIELDS).forEach((f) => { p[f] = pick_(nv, FIELDS[f]); });
  p.niche = p.niche ? p.niche.split(/,\\s*/) : [];
  p.consent = pick_(nv, CONSENT_LABEL).length > 0;
  const src = pick_(nv, SOURCE_LABEL);
  p.sourceTags = { utm_source: src };
  return p;
}

function send_(payload) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-ingest-key': INGEST_KEY },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) return code;
      Logger.log('Content Studio replied ' + code + ': ' + res.getContentText());
      if (code >= 400 && code < 500) return code;
    } catch (err) {
      Logger.log('Send failed: ' + err);
    }
    Utilities.sleep(1500 * attempt);
  }
  return 0;
}

// Install: Triggers (clock icon) > Add Trigger > onFormSubmit > From spreadsheet > On form submit.
function onFormSubmit(e) {
  send_(buildPayload_(e.namedValues || {}));
}

// Run this once by hand to confirm the bridge works. It sends a clearly marked
// test lead (no Meta event) and you should get the alert email.
function testBridge() {
  const code = send_({ firstName: 'Test', lastName: 'Lead', email: 'test@example.com', yearsAdvisor: '5 to 10 years', niche: ['Group Travel'], contentSource: 'Mostly original', consent: false, test: true });
  Logger.log('Test finished with HTTP ' + code);
}
`;
}


// ---- free resource delivery ----------------------------------------------

// "Nicci Grotefendt <addr>" using the verified sending address on the server.
export function leadFrom(personName) {
  const base = process.env.LEAD_FROM || process.env.MAGIC_FROM || '';
  if (!base) return undefined;
  const addr = (base.match(/<([^>]+)>/) || [null, base])[1].trim();
  return /@/.test(addr) ? `${personName || 'ContentStudio'} <${addr}>` : undefined;
}

export function deliveryEmail({ lead, resource, brand, person, address, downloadUrl, unsubUrl, applyUrl, lookInsideUrl }) {
  const first = esc(lead.firstName || 'there');
  const ps = resource.slug === 'look-inside'
    ? `<p style="margin:22px 0 0">P.S. Applications are read personally. When you are ready, you can apply here: <a href="${esc(applyUrl)}" style="color:#00566b">${esc(applyUrl)}</a></p>`
    : `<p style="margin:22px 0 0">P.S. If you would like to see the five days this work grows into, here is a short look inside: <a href="${esc(lookInsideUrl)}" style="color:#00566b">${esc(lookInsideUrl)}</a></p>`;
  const html = `<div style="font-family:Georgia,'Times New Roman',serif;max-width:540px;margin:0 auto;padding:28px 22px;color:#0d1216;line-height:1.55;font-size:16px">
    <p style="margin:0 0 14px">Hi ${first},</p>
    <p style="margin:0 0 14px">${esc(resource.emailIntro)}</p>
    <p style="margin:26px 0"><a href="${esc(downloadUrl)}" style="background:#00566b;color:#f8f5f0;padding:13px 24px;border-radius:4px;text-decoration:none;font-family:-apple-system,Segoe UI,sans-serif;font-weight:600;font-size:15px">${esc(resource.buttonLabel || `Download your ${resource.title}`)}</a></p>
    <p style="margin:0 0 14px">${esc(resource.emailNote)}</p>
    <p style="margin:0">Warmly,<br>${esc(person)}</p>
    ${ps}
    <hr style="border:none;border-top:1px solid #d2cdc5;margin:30px 0 14px">
    <p style="font-family:-apple-system,Segoe UI,sans-serif;font-size:12px;color:#777;margin:0">You are receiving this because you asked for the ${esc(resource.title)} at consciouscreator.app. ${esc(brand)}, ${esc(address)}. <a href="${esc(unsubUrl)}" style="color:#777">Unsubscribe</a></p>
  </div>`;
  return { subject: resource.subject, html };
}

export async function sendResourceEmail(args) {
  const { subject, html } = deliveryEmail(args);
  if (!mailConfigured()) return { status: 'skipped', reason: 'no email provider configured' };
  await sendMail({
    to: args.lead.email, subject, html,
    from: leadFrom(args.person),
    replyTo: args.replyTo || undefined,
    headers: { 'List-Unsubscribe': `<${args.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
  return { status: 'sent' };
}
