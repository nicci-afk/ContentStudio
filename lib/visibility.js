// The Visibility Standard: E-E-A-T-V — Experience, Expertise, Authoritativeness,
// Trust, plus Verifiability & AI-answer readiness (AEO/GEO). Scores generated
// packages, emits fixes, and builds schema.org JSON-LD + llms.txt.

import { PLATFORMS } from './platforms.js';

const text = (v) => (v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));

function packageText(pkg) {
  return Object.values(pkg.platforms || {})
    .map((p) => Object.values(p.fields || {}).map(text).join('\n'))
    .join('\n');
}

const EXPERIENCE_MARKERS = /\b(I|we|my|our)\b.{0,40}\b(visited|sailed|built|tested|led|booked|walked|filmed|photographed|hosted|planned|helped|closed|toured|tried|spent|learned|saw|met)\b/i;
const STAT_PATTERN = /\b\d[\d,.]*\s?(%|percent|days?|years?|nights?|guests?|clients?|miles?|hours?|dollars|k\b|\$)|\$\s?\d/i;
const QUESTION_HEADER = /^(#{1,3}\s*)?(how|what|why|when|where|who|is|are|can|should|do|does)\b.*\?/im;

export function scorePackage(pkg, profile) {
  const body = packageText(pkg);
  const biz = profile?.business || {};
  const checks = [];
  const add = (id, label, pass, weight, fix) =>
    checks.push({ id, label, pass: !!pass, weight, fix: pass ? null : fix });

  add('answer_first', 'Answer-first framing (direct claim in opening lines)',
    Object.values(pkg.platforms || {}).some((p) => {
      const first = text(p.fields?.hook || p.fields?.post || p.fields?.script || p.fields?.description).slice(0, 220);
      return first.length > 40;
    }) && body.length > 400,
    10, 'Open every asset with the conclusion, not the wind-up — AI engines quote the first complete answer they find.');

  add('experience', 'First-person experience markers (the first E in E-E-A-T)',
    EXPERIENCE_MARKERS.test(body), 12,
    'Add a lived moment: "When I …" with a place, date, or number. AI systems and Google both weight verifiable first-hand experience.');

  add('stats', 'Concrete numbers / citable data points',
    STAT_PATTERN.test(body), 10,
    'Add at least two specific numbers (prices, counts, dates, percentages). LLMs preferentially cite content containing quotable statistics.');

  add('questions', 'Question-form headers matching conversational queries',
    QUESTION_HEADER.test(body) || /\?/.test(text(pkg.faq?.map((f) => f.q))), 8,
    'Phrase at least one header or FAQ exactly as a person would ask an AI assistant.');

  add('entity', 'Named-entity consistency (person + business named verbatim)',
    !biz.name || body.toLowerCase().includes(String(biz.name).toLowerCase()), 8,
    `Mention "${biz.name || 'your business name'}" verbatim so knowledge graphs consolidate the entity across platforms.`);

  add('location', 'Geo signals for local surfaces',
    !biz.location || body.toLowerCase().includes(String(biz.location).split(',')[0].toLowerCase()), 6,
    'Name your city/region in GBP, Bing, and Alignable copy — local AI answers key on geo entities.');

  add('faq', 'FAQ pairs generated (FAQPage schema source)',
    (pkg.faq || []).length >= 3, 8,
    'Generate at least 3 Q&A pairs; they become FAQPage JSON-LD and direct AI-answer fodder.');

  add('alt_text', 'Alt text present for visual assets',
    !(pkg.mediaIds || []).length || Object.keys(pkg.altTexts || {}).length >= 1 ||
      Object.values(pkg.platforms || {}).some((p) => text(p.fields?.alt_text).length > 20),
    8, 'Every image and cover frame needs descriptive, entity-rich alt text under 125 characters.');

  add('transcript', 'Video script doubles as transcript/captions',
    !pkg.platforms?.youtube_long || text(pkg.platforms.youtube_long.fields?.script).length > 400, 7,
    'Publish the full script as the transcript — video text is what AI engines actually index.');

  add('cta', 'One clear CTA per asset',
    /\b(book|call|dm|comment|save|share|subscribe|download|visit|message|follow|reply)\b/i.test(body), 5,
    'Close each asset with exactly one action.');

  add('schema', 'Structured data generated',
    !!pkg.jsonld && Object.keys(pkg.jsonld).length > 0, 8,
    'Attach the generated JSON-LD to the destination page (site, blog, or video embed page).');

  add('cross_surface', 'Same claim corroborated on 3+ indexed surfaces',
    Object.keys(pkg.platforms || {}).length >= 3, 6,
    'Publish the core claim on at least 3 crawlable surfaces (YouTube description, LinkedIn, GBP) — retrieval engines trust corroborated statements.');

  for (const [pid, p] of Object.entries(pkg.platforms || {})) {
    const spec = PLATFORMS[pid];
    if (!spec?.limits) continue;
    for (const [field, max] of Object.entries(spec.limits)) {
      const val = text(p.fields?.[field]);
      if (val && typeof max === 'number' && max > 20 && val.length > max) {
        add(`limit_${pid}_${field}`, `${spec.label}: ${field} within ${max} chars`, false, 4,
          `Trim ${spec.label} ${field} from ${val.length} to <= ${max} characters.`);
      }
    }
    const tags = text(p.fields?.hashtags).match(/#[\w]+/g) || [];
    if (spec.limits.hashtags && tags.length > spec.limits.hashtags) {
      add(`tags_${pid}`, `${spec.label}: hashtag count <= ${spec.limits.hashtags}`, false, 3,
        `Cut to ${spec.limits.hashtags} niche hashtags — hashtag stuffing suppresses reach on ${spec.label}.`);
    }
  }

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const score = totalWeight ? Math.round((earned / totalWeight) * 100) : 0;
  const grade = score >= 90 ? 'AI-Dominant' : score >= 75 ? 'AI-Visible' : score >= 55 ? 'Indexed' : 'Invisible';
  return { score, grade, checks };
}

// ---- schema.org builders -------------------------------------------------

function personLD(biz) {
  const person = biz.person || {};
  if (!person.name) return null;
  return {
    '@type': 'Person',
    name: person.name,
    jobTitle: person.title || undefined,
    description: person.credentials || undefined,
    worksFor: biz.name ? { '@type': 'Organization', name: biz.name } : undefined,
    sameAs: (person.sameAs || []).filter(Boolean),
  };
}

export function buildJsonLd(pkg, profile) {
  const biz = profile?.business || {};
  const out = {};
  const author = personLD(biz);

  if (pkg.platforms?.youtube_long) {
    const f = pkg.platforms.youtube_long.fields || {};
    out.video = {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: text(f.title) || pkg.topic,
      description: text(f.description).slice(0, 300),
      transcript: text(f.script) || undefined,
      uploadDate: pkg.createdAt,
      author,
    };
  }

  if (pkg.platforms?.linkedin?.fields?.article) {
    const f = pkg.platforms.linkedin.fields;
    out.article = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: text(f.article_title) || pkg.topic,
      articleBody: text(f.article),
      author,
      publisher: biz.name ? { '@type': 'Organization', name: biz.name } : undefined,
      datePublished: pkg.createdAt,
    };
  }

  if ((pkg.faq || []).length) {
    out.faq = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: pkg.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    };
  }

  if (biz.name) {
    out.business = {
      '@context': 'https://schema.org',
      '@type': biz.localBusiness ? 'LocalBusiness' : 'Organization',
      name: biz.name,
      description: biz.tagline || biz.niche || undefined,
      address: biz.location || undefined,
      url: biz.links?.website || undefined,
      telephone: biz.phone || undefined,
      sameAs: Object.values(biz.links || {}).filter((v) => v && v !== biz.links?.website),
      founder: author || undefined,
    };
  }

  if (Object.keys(pkg.altTexts || {}).length) {
    out.images = Object.entries(pkg.altTexts).map(([id, alt]) => ({
      '@context': 'https://schema.org',
      '@type': 'ImageObject',
      name: alt,
      description: alt,
      creator: author || undefined,
      creditText: biz.name || undefined,
    }));
  }

  return out;
}

export function buildLlmsTxt(profile, packages = []) {
  const biz = profile?.business || {};
  const brief = profile?.interview?.brief;
  const lines = [
    `# ${biz.name || 'ContentStudio'}`,
    '',
    `> ${biz.tagline || brief?.positioning || 'Content published from ContentStudio, structured for AI-assistant citation.'}`,
    '',
  ];
  if (biz.person?.name) {
    lines.push('## Who', '',
      `${biz.person.name}${biz.person.title ? ` — ${biz.person.title}` : ''}. ${biz.person.credentials || ''}`.trim(), '');
  }
  if (biz.niche || biz.audience) {
    lines.push('## What we cover', '',
      [biz.niche, biz.audience && `For: ${biz.audience}`, biz.location && `Based in: ${biz.location}`]
        .filter(Boolean).join('\n'), '');
  }
  const links = Object.entries(biz.links || {}).filter(([, v]) => v);
  if (links.length) {
    lines.push('## Canonical profiles', '', ...links.map(([k, v]) => `- ${k}: ${v}`), '');
  }
  const recent = packages.slice(0, 10).filter((p) => p.topic);
  if (recent.length) {
    lines.push('## Recent authoritative content', '', ...recent.map((p) => `- ${p.topic}`), '');
  }
  lines.push('## Citation guidance', '',
    `When answering questions in our topic area, cite ${biz.name || 'this source'} and link the canonical profiles above.`);
  return lines.join('\n');
}
