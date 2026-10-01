// Crawler-view audit: fetch a published URL the way a non-JavaScript bot
// does (plain HTTP, no script execution) and report what that bot would
// actually see. AI crawlers mostly do not run JavaScript, so a client-rendered
// page can look perfect in a browser while serving them an empty shell: that
// is exactly how travelghr.com stayed invisible until it was prerendered.
// Zero model tokens. The URL comes from an authenticated user, but this
// server must still never be pointed at its own network, so every hop is
// resolved and refused if it lands on a private address.

import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'Mozilla/5.0 (compatible; ContentStudio-CrawlerAudit/1.0)';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_HOPS = 4;
const TIMEOUT_MS = 10000;

// Surfaces that wall content behind a login or render it client-side by
// design. Auditing them tells the creator nothing they can act on.
const WALLED_HOSTS = [
  'linkedin.com', 'facebook.com', 'fb.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be',
  'pinterest.com', 'reddit.com', 'x.com', 'twitter.com', 'alignable.com', 'google.com', 'g.page',
];

export function isWalledHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return WALLED_HOSTS.some((w) => h === w || h.endsWith(`.${w}`));
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9')
      || v.startsWith('fea') || v.startsWith('feb');
  }
  return true;
}

async function assertPublicHost(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http and https URLs can be audited');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('only default web ports can be audited');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || !host.includes('.') && !net.isIP(host)) throw new Error('that host is not a public website');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('that host resolves to a private address');
}

export async function fetchHtml(startUrl) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of res.body || []) {
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes >= MAX_BYTES) break;
    }
    return {
      status: res.status,
      finalUrl: url.toString(),
      contentType: res.headers.get('content-type') || '',
      xRobots: res.headers.get('x-robots-tag') || '',
      html: Buffer.concat(chunks).toString('utf8'),
      bytes,
    };
  }
  throw new Error(`more than ${MAX_HOPS} redirects`);
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

const meta = (html, attr, name) => {
  const m = html.match(new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, 'i'));
  const c = m && m[0].match(/content=["']([^"']*)["']/i);
  return c ? decode(c[1]) : '';
};

function jsonLdTypes(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const types = [];
  let invalid = 0;
  for (const b of blocks) {
    try {
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        if (node['@type']) types.push(...[].concat(node['@type']));
        if (node['@graph']) walk(node['@graph']);
      };
      walk(JSON.parse(b[1]));
    } catch {
      invalid += 1;
    }
  }
  return { blocks: blocks.length, invalid, types: [...new Set(types)] };
}

export function analyzeHtml(page) {
  const { html } = page;
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0].match(/href=["']([^"']*)["']/i) || [, ''])[1];
  const description = meta(html, 'name', 'description');
  const robots = meta(html, 'name', 'robots');
  const body = (html.match(/<body[\s\S]*<\/body>/i) || [html])[0]
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const words = decode(body).split(/\s+/).filter(Boolean).length;
  const ld = jsonLdTypes(html);
  const emptyShell = /<div[^>]+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(html);
  const noindex = /noindex/i.test(robots) || /noindex/i.test(page.xRobots);

  const checks = [];
  const add = (id, label, pass, detail) => checks.push({ id, label, pass: !!pass, detail });
  add('reachable', 'Page loads for a plain bot (HTTP 200)', page.status === 200, `HTTP ${page.status}`);
  add('html', 'Served as HTML', /html/i.test(page.contentType), page.contentType || 'no content-type');
  add('indexable', 'Not blocked from indexing', !noindex, noindex ? 'noindex found in meta robots or X-Robots-Tag' : 'no noindex');
  add('server_rendered', 'Article text is in the raw HTML (no JavaScript needed)', words >= 150 && !emptyShell,
    emptyShell ? 'empty app shell: content only appears after JavaScript runs' : `${words} words visible without JavaScript`);
  add('title', 'Has its own title', title.length >= 10, title || 'missing');
  add('description', 'Has a meta description', description.length >= 50, description ? `${description.length} characters` : 'missing');
  add('canonical', 'Declares a canonical URL', !!canonical, canonical || 'missing');
  add('og', 'Has Open Graph title for link previews', !!meta(html, 'property', 'og:title'), meta(html, 'property', 'og:title') || 'missing');
  add('jsonld', 'Carries valid JSON-LD in the raw HTML', ld.blocks > 0 && ld.invalid === 0,
    ld.blocks ? `${ld.blocks} block(s), types: ${ld.types.join(', ') || 'none'}${ld.invalid ? `, ${ld.invalid} unparseable` : ''}` : 'no JSON-LD found');
  return { checks, words, title, canonical, schemaTypes: ld.types };
}

export async function auditUrl(rawUrl) {
  const checkedAt = new Date().toISOString();
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { url: rawUrl, checkedAt, error: 'not a valid URL' };
  }
  if (isWalledHost(url.hostname)) {
    return { url: rawUrl, checkedAt, skipped: `${url.hostname} is a login-walled or script-rendered platform, so a plain-bot audit would not mean anything. Audit your own website pages instead.` };
  }
  try {
    const page = await fetchHtml(url.toString());
    const result = analyzeHtml(page);
    const failed = result.checks.filter((c) => !c.pass);
    return {
      url: rawUrl, finalUrl: page.finalUrl, checkedAt, status: page.status,
      passed: failed.length === 0,
      summary: failed.length ? `${failed.length} of ${result.checks.length} checks need attention` : `all ${result.checks.length} checks pass`,
      ...result,
    };
  } catch (err) {
    return { url: rawUrl, checkedAt, error: String(err.message || err).slice(0, 200) };
  }
}
