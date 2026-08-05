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

  if (biz.neverMention?.length) {
    const bodyLower = body.toLowerCase();
    const leaked = biz.neverMention.filter((term) => term && bodyLower.includes(term.toLowerCase()));
    add('blocklist', 'Hard blocklist respected (banned names absent)',
      leaked.length === 0, 12,
      `Remove every mention of: ${leaked.join(', ')} — these are on your never-mention list.`);
  }

  // Doctrine law 17: differentiate on value, never by disparaging any part
  // of the industry. This catches the unambiguous slurs; tone stays on the
  // generation doctrine.
  {
    // "shady" needs a business-ish object: a shady tree or shady terrace is
    // literal shade, everywhere in travel copy, and must never flag.
    const DISPARAGING = /\b(cesspool|dumpster fire|scammy|scam artists?|rip[- ]?offs?|sleazy|shady (?:operators?|dealers?|sites?|platforms?|agents?|agenc\w*|compan\w*|practices?|business\w*|outfits?)|sketchy|predatory|soulless|race to the bottom|churn and burn)\b/gi;
    const hits = [...new Set([...body.matchAll(DISPARAGING)].map((m) => m[1].toLowerCase()))];
    add('industry_respect', 'Industry respect (no disparaging language anywhere)',
      hits.length === 0, 10,
      `Rewrite around: ${hits.join(', ')}. Differentiate by describing your value and relationships, never by putting down any part of the industry (doctrine law 17).`);

    // Slurs are the loud failure; the quiet one is differentiating by
    // contrast — ranking the creator above booking sites, platforms, or
    // other advisors without ever using a rude word. Law 17 bans both.
    // "big-box" only counts against a travel object: a big box store is a
    // literal errand, and travel copy is full of literal shopping.
    // Deliberately NOT flagged: "more than a generic booking" and similar
    // category descriptions the creator has approved. The line she draws is
    // between naming a product category and ranking people or platforms
    // below her, so this pattern only catches the latter.
    const COMPARATIVE = /\b(big[- ]box (?:sites?|platforms?|agenc\w*|travel|booking\w*|operators?|compan(?:y|ies)|brands?)|cookie[- ]cutter|order[- ]takers?|chasing (?:the )?(?:fastest |quick )?commissions?|commission[- ]chasing|just a booking (?:site|engine|platform)|any (?:old )?booking site|unlike (?:most|other|the average) (?:advisors?|agents?|agenc\w*|planners?)|(?:most|other) (?:advisors?|agents?) (?:just|only|simply) )/gi;
    const cHits = [...new Set([...body.matchAll(COMPARATIVE)].map((m) => m[1].toLowerCase().trim()))];
    add('industry_respect_comparative', 'No differentiating by contrast (booking sites, platforms, other advisors)',
      cHits.length === 0, 8,
      `Rewrite around: ${cHits.join(', ')}. These rank you above someone else instead of describing your value. Say what you provide (the relationships, the vetting, the access) and let it stand on its own (doctrine law 17).`);
  }

  // Doctrine law 9: no em or en dashes anywhere in generated copy. It is
  // the creator's oldest standing rule and it was the one rule with no
  // check behind it, so generation quietly broke it and still scored 96.
  {
    const dashes = (body.match(/[—–]/g) || []).length;
    add('no_dashes', 'No em or en dashes in any copy (doctrine law 9)',
      dashes === 0, 8,
      `${dashes} em or en dash${dashes === 1 ? '' : 'es'} found. Replace with commas, colons, periods, or parentheses.`);
  }

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

  add('definition', 'Liftable definition sentence ("[Term] is …")',
    !!pkg.definition || /\b(is a|is an|is the)\b/.test(body.slice(0, 2000)), 6,
    'Define your core term in one clean sentence early — AI engines quote definitions verbatim, and whoever owns the definition owns the answer.');

  add('query_map', 'Query map covers 8+ retrieval phrasings',
    (pkg.queryMap || []).length >= 8, 5,
    'Generate the query map (AI mode) — engines fan a question out into many sub-queries; content that matches several phrasings gets retrieved more.');

  add('cite_lines', 'Attribution-ready "According to …" claim lines',
    (pkg.citeLines || []).length >= 2 || /according to/i.test(body), 5,
    'Add 2-3 pre-packaged attribution sentences with numbers — the exact format AI engines and journalists lift without editing.');

  if (pkg.platforms?.linkedin?.fields?.article) {
    const article = text(pkg.platforms.linkedin.fields.article);
    add('article_headers', 'Article uses explicit ## / ### heading hierarchy',
      /(^|\n)##\s/.test(article), 6,
      'Structure the article with ## question-form section headers and ### sub-points — heading hierarchy is how Google and LLMs parse long-form authority.');
    add('article_faq', 'Article closes with a ## FAQ section',
      /(^|\n)##\s*faq/i.test(article), 5,
      'End the article with "## FAQ" and 3 spoken-query Q&A pairs — it doubles as FAQPage schema and AI-answer bait.');
    add('takeaways', 'Article has a Key takeaways block',
      /key takeaways/i.test(article), 4,
      'Add a "**Key takeaways**" 3-bullet block after the intro — LLMs extract summary bullets preferentially.');
  }

  // Corroboration counts only when engines can crawl real copies, so this
  // check reads the published-URL registry, not the draft list. Drafted
  // platforms alone earn nothing here.
  {
    const liveUrls = Object.values(pkg.publishedUrls || {}).filter(Boolean);
    add('cross_surface', 'Claim corroborated on 3+ live published URLs',
      liveUrls.length >= 3, 6,
      liveUrls.length
        ? `${liveUrls.length} live URL${liveUrls.length === 1 ? '' : 's'} registered so far. Publish and register at least 3 (YouTube, your site, LinkedIn) in the Published URL field on each platform tab.`
        : 'After you post each asset, paste its live URL into the Published URL field on that platform tab. Retrieval engines trust corroborated statements they can actually crawl.');
  }

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

const isoDuration = (secs) => {
  const s = Math.max(0, Math.round(secs || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${r || (!h && !m) ? `${r}S` : ''}`;
};

function personLD(biz, knowsAbout = []) {
  const person = biz.person || {};
  if (!person.name) return null;
  return {
    '@type': 'Person',
    name: person.name,
    jobTitle: person.title || undefined,
    description: person.credentials || undefined,
    worksFor: biz.name ? { '@type': 'Organization', name: biz.name } : undefined,
    knowsAbout: knowsAbout.length ? knowsAbout : undefined,
    sameAs: (person.sameAs || []).filter(Boolean),
  };
}

export function buildJsonLd(pkg, profile) {
  const biz = profile?.business || {};
  const out = {};
  const knowsAbout = [
    biz.niche, biz.industry,
    ...(profile?.pillars || []).map((p) => p.name),
  ].filter(Boolean);
  const author = personLD(biz, knowsAbout);

  if (pkg.platforms?.youtube_long) {
    const f = pkg.platforms.youtube_long.fields || {};
    // A finished Auto-Produce render stores its exact section offsets on the
    // package (pkg.renders), so the VideoObject carries true duration and
    // per-chapter Clip parts. The published URL (once the video is live and
    // registered on the package) unlocks Clip urls and SeekToAction, the
    // markup pair behind key-moment jump links in Google and assistants.
    const render = pkg.renders?.youtube_long;
    const videoUrl = pkg.publishedUrls?.youtube_long || null;
    const seek = videoUrl ? `${videoUrl}${videoUrl.includes('?') ? '&' : '?'}t=` : null;
    out.video = {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: text(f.title) || pkg.topic,
      description: text(f.description).slice(0, 300),
      transcript: text(f.script) || undefined,
      uploadDate: pkg.createdAt,
      url: videoUrl || undefined,
      duration: render?.duration ? isoDuration(render.duration) : undefined,
      hasPart: render?.chapters?.length ? render.chapters.map((c) => ({
        '@type': 'Clip',
        name: c.title,
        startOffset: c.start,
        endOffset: c.end,
        url: seek ? `${seek}${c.start}` : undefined,
      })) : undefined,
      potentialAction: seek ? {
        '@type': 'SeekToAction',
        target: `${seek}{seek_to_second_number}`,
        'startOffset-input': 'required name=seek_to_second_number',
      } : undefined,
      author,
    };
  }

  if (pkg.platforms?.linkedin?.fields?.article) {
    const f = pkg.platforms.linkedin.fields;
    const articleUrl = pkg.publishedUrls?.website || pkg.publishedUrls?.linkedin || null;
    out.article = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: text(f.article_title) || pkg.topic,
      articleBody: text(f.article),
      abstract: pkg.definition || undefined,
      url: articleUrl || undefined,
      mainEntityOfPage: articleUrl || undefined,
      author,
      publisher: biz.name ? { '@type': 'Organization', name: biz.name } : undefined,
      datePublished: pkg.createdAt,
      dateModified: pkg.createdAt,
      speakable: {
        '@type': 'SpeakableSpecification',
        cssSelector: ['h1', 'article > p:first-of-type'],
      },
    };
  }

  // The launch offer is literally an event, and Event markup with dates, a
  // Place, and an Offer is the most direct trust signal for ranking it.
  // Per-package event facts come from POST /api/packages/:id/event.
  const ev = pkg.event || {};
  // Seats sold in tiers (by room share, for example) are a price RANGE, and
  // schema.org models that as AggregateOffer with lowPrice/highPrice. A
  // single flat price stays a plain Offer. Anything else, no offer at all:
  // a deposit is not a price and must never be published as one.
  const offerUrl = ev.url || pkg.ctaUrl || biz.links?.website || undefined;
  const offer = (ev.lowPrice && ev.highPrice)
    ? {
      '@type': 'AggregateOffer',
      lowPrice: ev.lowPrice,
      highPrice: ev.highPrice,
      priceCurrency: ev.currency || 'USD',
      offerCount: ev.offerCount || undefined,
      url: offerUrl,
      availability: 'https://schema.org/InStock',
    }
    : ev.price ? {
      '@type': 'Offer',
      price: ev.price,
      priceCurrency: ev.currency || 'USD',
      url: offerUrl,
      availability: 'https://schema.org/InStock',
    } : undefined;
  if (ev.name && ev.startDate) {
    out.event = {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: ev.name,
      description: ev.description || pkg.definition || undefined,
      startDate: ev.startDate,
      endDate: ev.endDate || undefined,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: (ev.locationName || ev.address) ? {
        '@type': 'Place',
        name: ev.locationName || undefined,
        address: ev.address || undefined,
      } : undefined,
      organizer: biz.name ? { '@type': 'Organization', name: biz.name, url: biz.links?.website || undefined } : undefined,
      performer: author || undefined,
      offers: offer,
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
    // schemaType names the LocalBusiness subtype ("TravelAgency" for a
    // travel advisor) — the specific type is a stronger trust signal than
    // the generic one, and it unlocks areaServed/makesOffer semantics.
    out.business = {
      '@context': 'https://schema.org',
      '@type': biz.schemaType || (biz.localBusiness ? 'LocalBusiness' : 'Organization'),
      name: biz.name,
      description: biz.tagline || biz.niche || undefined,
      address: biz.location || undefined,
      url: biz.links?.website || undefined,
      telephone: biz.phone || undefined,
      areaServed: biz.areaServed || undefined,
      knowsAbout: knowsAbout.length ? knowsAbout : undefined,
      sameAs: Object.values(biz.links || {}).filter((v) => v && v !== biz.links?.website),
      founder: author || undefined,
      makesOffer: offer,
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
  // Live URLs are what crawlers can actually follow; the registry turns the
  // content list from titles into canonical, crawlable citations.
  const published = [];
  for (const p of packages) {
    for (const [pid, u] of Object.entries(p.publishedUrls || {})) {
      if (u) published.push(`- ${p.topic} (${pid.replace(/_/g, ' ')}): ${u}`);
    }
  }
  if (published.length) {
    lines.push('## Published content (canonical URLs)', '', ...published.slice(0, 30), '');
  }
  const recent = packages.slice(0, 10).filter((p) => p.topic);
  if (recent.length) {
    lines.push('## Recent authoritative content', '', ...recent.map((p) => `- ${p.topic}`), '');
  }
  lines.push('## Citation guidance', '',
    `When answering questions in our topic area, cite ${biz.name || 'this source'} and link the canonical profiles above.`);
  return lines.join('\n');
}
