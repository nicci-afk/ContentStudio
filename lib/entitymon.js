// Entity-consistency monitoring: fetch each listing or profile page the
// brand appears on, as a plain bot, and check that the name, phone and
// address match what the profile says. Mismatched NAP data splits an entity
// in search and AI answers. Read-only: nothing is ever changed on any site.
// Login-walled platforms (LinkedIn, Facebook, Google and friends) are
// skipped and listed so the owner checks them by hand.

import { fetchHtml, isWalledHost } from './crawl.js';
import { studioStore } from './store.js';

const decode = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const textOf = (html) => decode(String(html).replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const digits = (s) => String(s || '').replace(/\D/g, '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function expectedEntity(profile) {
  const b = profile?.business || {};
  const names = [b.name, b.legalName, ...(b.alternateNames || [])].filter(Boolean);
  return { names, phone: b.phone || '', address: b.address || b.streetAddress || '', person: b.person?.name || '' };
}

export function targets(profile, extra = []) {
  const b = profile?.business || {};
  const urls = [...Object.values(b.links || {}), ...(b.person?.sameAs || []), ...extra].filter((u) => /^https?:\/\//i.test(String(u)));
  return [...new Set(urls.map((u) => String(u).trim()))].slice(0, 40);
}

// Pure check of one page's text against the expected entity.
export function checkPage(text, exp) {
  const t = norm(text);
  const found = { name: exp.names.some((n) => t.includes(norm(n))), person: exp.person ? t.includes(norm(exp.person)) : null, phone: null, address: null };
  const issues = [];
  if (!found.name) issues.push('business name not found');
  if (exp.phone) {
    const want = digits(exp.phone).slice(-10);
    const phones = [...String(text).matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g)].map((m) => digits(m[0]).slice(-10));
    found.phone = phones.includes(want);
    const others = [...new Set(phones.filter((p) => p !== want))];
    if (!found.phone) issues.push(others.length ? `different phone number listed (${others.slice(0, 2).join(', ')})` : 'phone number not found');
  }
  if (exp.address) {
    const street = norm(exp.address).split(' ').slice(0, 3).join(' ');
    found.address = street ? t.includes(street) : null;
    if (found.address === false) issues.push('street address not found');
  }
  return { found, issues };
}

export async function runEntityCheck(profile, { fetchPage = fetchHtml } = {}) {
  const settings = studioStore.get().entity || {};
  const exp = expectedEntity(profile);
  const results = [];
  for (const url of targets(profile, settings.urls || [])) {
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    if (isWalledHost(host)) { results.push({ url, skipped: 'login-walled: check this one by hand' }); continue; }
    try {
      const page = await fetchPage(url);
      if (page.status !== 200) { results.push({ url, error: `HTTP ${page.status}` }); continue; }
      results.push({ url, ...checkPage(textOf(page.html), exp) });
    } catch (err) { results.push({ url, error: String(err.message).slice(0, 140) }); }
  }
  const run = { at: new Date().toISOString(), expected: exp, results, issues: results.reduce((a, r) => a + (r.issues?.length || 0), 0) };
  studioStore.update((s) => ({ ...s, entity: { ...(s.entity || {}), last: run, history: [{ at: run.at, checked: results.length, issues: run.issues }, ...((s.entity || {}).history || [])].slice(0, 24) } }));
  return run;
}

export function saveEntitySettings({ urls, auto }) {
  const list = (Array.isArray(urls) ? urls : String(urls || '').split('\n')).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 30);
  studioStore.update((s) => ({ ...s, entity: { ...(s.entity || {}), urls: urls === undefined ? (s.entity?.urls || []) : list, auto: auto === undefined ? !!s.entity?.auto : !!auto } }));
  return entityState();
}

export const entityState = () => {
  const e = studioStore.get().entity || {};
  return { urls: e.urls || [], auto: !!e.auto, last: e.last || null, history: e.history || [] };
};
