// Generation engine: turns the story brief + voice DNA + media intelligence
// into per-platform content packages, with template fallbacks when no
// ANTHROPIC_API_KEY is configured.

import { PLATFORMS } from './platforms.js';
import { scorePackage, buildJsonLd } from './visibility.js';
import { claude, claudeJson, imageBlock, providerStatus } from './providers.js';
import { uid } from './store.js';

const DOCTRINE = `You are the generation engine inside ContentStudio, an AI-visibility content system. Every word you produce must satisfy the E-E-A-T-V doctrine — it exceeds Google's E-E-A-T because it is engineered for citation by AI answer engines (ChatGPT, Gemini, Perplexity, Copilot) as much as for human feeds:

1. ANSWER-FIRST. Open with the conclusion. The first 1-2 sentences of any asset must work as a standalone quoted answer.
2. EXPERIENCE. Weave verifiable first-person moments (specific places, dates, numbers, sensory detail) from the creator's real material. Never invent facts, credentials, statistics, or events — if a detail is not in the provided context, leave a [FILL: ...] placeholder instead of fabricating it.
3. ENTITIES. Name the creator, business, locations, products, and niche terms verbatim and consistently so knowledge graphs consolidate them.
4. QUOTABILITY. Include at least one tight, screenshot-able line and at least two concrete numbers per package.
5. CONVERSATIONAL QUERIES. Phrase headers/FAQ exactly as people ask assistants ("Is X worth it?", "How much does Y cost?").
6. NATIVE FORM. Each platform gets platform-native structure — never cross-posted copy. Respect every character limit given.
7. HOOKS. Video hooks interrupt in <2 seconds, spoken + on-screen. Written hooks earn the "see more" click in the first line.
8. ONE CTA per asset.
9. HUMAN VOICE. Match the creator's voice DNA exactly — their rhythm, vocabulary, and stance. No AI-isms ("dive in", "game-changer", "unleash", "in today's fast-paced world", "it's not X, it's Y" constructions). Never call anyone an "influencer" (creators curate communities). NEVER use em dashes (—) or en dashes (–) anywhere in output copy: restructure with commas, colons, periods, or parentheses instead.
10. STORY SPINE. Every asset carries story: a person, a tension, a turn, a takeaway — even a 15-second Short. Video scripts additionally must: state the PROMISE in the open (what the viewer gets), name the TRANSFORMATION, show STAKES (what could go wrong) as micro-hooks, include one planned PERSONALITY MOMENT (a vulnerable, human beat), and land a PLANNED ENDING that fulfills the promise then hooks the next episode. After the hook, include one AUTHORITY BEAT: a single sentence of lived proof for why this creator is the one to answer.
11. HEADING HIERARCHY. Long-form articles are markdown with exactly one # H1, ## question-form H2 sections, ### sub-points, and a closing "## FAQ" section — headings are how search engines and LLMs parse authority.
12. PRODUCTION HANDOFF. Where a production_notes or todo field exists, be concrete and imperative: name the app, the exact search terms, the export settings, and every [FILL] the creator must supply. The creator posts everything manually — your output must be paste-ready with zero rewriting.
13. DEFINITIONAL AUTHORITY. Early in long-form assets, define the package's core term in one crisp, liftable sentence ("A conscious creator retreat is ..."). AI engines quote clean definitions verbatim — own the definition, own the answer.
14. SNIPPET BLOCKS. The first paragraph under every ## question header must be a 40-60 word standalone answer that survives being quoted alone, with the supporting depth below it.
15. ATTRIBUTED CLAIMS. Phrase key claims as attribution-ready sentences ("According to [creator name], ...") with a number attached — the format engines and journalists lift without editing.
16. ANSWER, THEN ESCALATE (video). YouTube reads the first minute to classify a video; weak openings get suppressed before they reach an audience. Answer the title's question within the first 30-60 seconds (giving the answer builds trust), then immediately open a bigger question that carries the middle. Give the beginning and the ending early; make the middle irresistible.
17. INDUSTRY RESPECT. The creator is a travel industry professional. Never write anything negative, critical, mocking, disgusted, or cautionary about ANY part of the travel industry: suppliers, resorts, hotels, cruise lines, airlines, tour operators, venues, destinations, booking sites, listing platforms, online travel agencies, other advisors or agencies, or any way people book travel, whether named or implied. No complaints, horror stories, warnings, insults, or comparisons that place anyone or anything below the creator. Never use derogatory or disgust vocabulary (cesspool, garbage, trash, scam, nightmare, dumpster fire, and the like) about anything in the industry. Differentiate by describing the creator's own value, relationships, and results, never by disparaging the alternative. If source material contains a negative experience, omit it or recast it as a neutral, unnamed lesson that identifies no one. Every mention of anyone else's product, platform, or service must be neutral or positive.`;

const text = (v) => (v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));

export function masterContext(profile, extras = {}) {
  const biz = profile.business || {};
  const brief = profile.interview?.brief;
  const dna = profile.voiceDna?.summary;
  const parts = [DOCTRINE, '\n--- CREATOR CONTEXT ---'];
  if (biz.name) parts.push(`Business: ${biz.name}${biz.tagline ? ` — ${biz.tagline}` : ''}`);
  if (biz.person?.name) parts.push(`Creator: ${biz.person.name}${biz.person.title ? `, ${biz.person.title}` : ''}${biz.person.credentials ? `. Credentials: ${biz.person.credentials}` : ''}`);
  if (biz.industry || biz.niche) parts.push(`Industry/niche: ${[biz.industry, biz.niche].filter(Boolean).join(' — ')}`);
  if (biz.audience) parts.push(`Audience: ${biz.audience}`);
  if (biz.location) parts.push(`Location: ${biz.location}`);
  if (biz.offers) parts.push(`Offers: ${biz.offers}`);
  const links = Object.entries(biz.links || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (links.length) parts.push(`Canonical links: ${links.join(' | ')}`);
  if (biz.neverMention?.length) {
    parts.push(`\n--- ABSOLUTE PROHIBITION ---\nNEVER mention, reference, abbreviate, or allude to any of the following in ANY output, under any circumstances, even if source material references them: ${biz.neverMention.join(', ')}. If a story or fact involves them, omit that detail or genericize it (e.g. "a mentor", "a media platform") without naming.`);
  }
  if (brief) parts.push('\n--- STORY BRIEF (from interview) ---', typeof brief === 'string' ? brief : JSON.stringify(brief, null, 2));
  if (dna) parts.push('\n--- VOICE DNA (write exactly in this voice) ---', typeof dna === 'string' ? dna : JSON.stringify(dna, null, 2));
  if (extras.pillar) parts.push(`\n--- CONTENT PILLAR ---\n${extras.pillar.name}: ${extras.pillar.description || ''}`);
  if (extras.series) parts.push(`--- SERIES ---\n"${extras.series.name}" (${extras.series.format || 'recurring series'}). Keep episode naming and format consistent.`);
  if (extras.ctaUrl) {
    parts.push(`\n--- CTA LINK ---\nThe destination for every CTA is ${extras.ctaUrl}. In copy, write the link as [LINK] — the studio attaches a per-platform tracked version separately. Never invent a different URL.`);
  }
  if (extras.media?.length) {
    parts.push('\n--- AVAILABLE MEDIA (real assets from the creator\'s library; reference them in b-roll cues, slides, and alt text) ---');
    for (const m of extras.media) {
      parts.push(`- [${m.id}] ${m.kind} "${m.name}"${m.takenAt ? ` (${m.takenAt.slice(0, 10)})` : ''}${m.place ? ` @ ${m.place}` : ''}: ${m.caption || m.alt || 'unanalyzed'}${m.keywords?.length ? ` | keywords: ${m.keywords.join(', ')}` : ''}`);
    }
  }
  return parts.join('\n');
}

function platformPrompt(spec, topic, angle) {
  const fieldSpec = spec.fields
    .map((f) => `  "${f.key}": ${f.long ? 'string (multi-paragraph, use \\n)' : 'string'}${f.hint ? `  // ${f.hint}` : ''}`)
    .join('\n');
  return `Create the ${spec.label} asset for this package.

TOPIC: ${topic}
${angle ? `ANGLE: ${angle}` : ''}

PLATFORM ALGORITHM NOTES: ${spec.algo}
LIMITS: ${JSON.stringify(spec.limits)}
CADENCE CONTEXT: ${spec.cadence}

Respond with ONLY a JSON object, no prose, exactly this shape:
{
${fieldSpec}
}`;
}

const FAQ_PROMPT = (topic) => `Based on the same context, write the AI-answer layer for the topic "${topic}".
Respond with ONLY JSON:
{
  "faq": [{"q": "conversational question exactly as someone would ask an AI assistant", "a": "45-70 word answer-first response with a number or named entity"}],  // exactly 4 pairs; at least one comparative ("...vs..." / "...worth it compared to...")
  "keywords": ["12-18 search + AI-retrieval phrases, mixed head and long-tail"],
  "entities": ["named entities this package should consistently reinforce"],
  "quotable": "the single most screenshot-able line of the package",
  "definition": "one liftable sentence defining the package's core term: '[Term] is ...'",
  "queryMap": ["10-15 distinct phrasings people would ask an AI assistant that this package should be THE retrieved answer for — questions, comparisons, long-tail variants"],
  "citeLines": ["2-3 attribution-ready sentences an AI engine or journalist could quote verbatim, format: 'According to [creator/business name], [claim with a specific number].'"],
  "altTexts": {"MEDIA_ID": "descriptive entity-rich alt text <= 125 chars"}  // one per provided media id, or {} if none
}`;

function trackedLink(base, platformId, topic) {
  try {
    const url = new URL(base);
    url.searchParams.set('utm_source', platformId);
    url.searchParams.set('utm_medium', 'organic');
    url.searchParams.set('utm_campaign', topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50));
    return url.toString();
  } catch {
    return base;
  }
}

export async function generatePackage({ profile, topic, angle, pillar, series, media = [], platformIds, ctaUrl, onProgress }) {
  const status = providerStatus();
  const system = masterContext(profile, { pillar, series, media, ctaUrl });
  const ids = (platformIds?.length ? platformIds : Object.keys(PLATFORMS)).filter((id) => PLATFORMS[id]);

  const pkg = {
    id: uid(),
    createdAt: new Date().toISOString(),
    topic,
    angle: angle || null,
    pillarId: pillar?.id || null,
    seriesId: series?.id || null,
    mediaIds: media.map((m) => m.id),
    mode: status.anthropic ? 'ai' : 'template',
    platforms: {},
    faq: [],
    keywords: [],
    entities: [],
    quotable: null,
    definition: null,
    queryMap: [],
    citeLines: [],
    altTexts: {},
    ctaUrl: ctaUrl || null,
    links: ctaUrl ? Object.fromEntries(ids.map((id) => [id, trackedLink(ctaUrl, id, topic)])) : {},
  };

  if (!status.anthropic) {
    for (const id of ids) pkg.platforms[id] = templateAsset(PLATFORMS[id], topic, profile);
    pkg.faq = templateFaq(topic, profile);
    finishPackage(pkg, profile);
    return pkg;
  }

  let done = 0;
  const run = async (id) => {
    const spec = PLATFORMS[id];
    const fields = await claudeJson({
      system,
      messages: [{ role: 'user', content: platformPrompt(spec, topic, angle) }],
      maxTokens: id === 'youtube_long' || id === 'linkedin' ? 8000 : 3000,
    });
    pkg.platforms[id] = { fields };
    done += 1;
    onProgress?.({ platform: id, done, total: ids.length + 1 });
  };

  const queue = [...ids];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        await run(id);
      } catch (err) {
        pkg.platforms[id] = { fields: templateAsset(PLATFORMS[id], topic, profile).fields, error: String(err.message).slice(0, 200) };
        done += 1;
      }
    }
  });
  await Promise.all(workers);

  try {
    const meta = await claudeJson({
      system,
      messages: [{
        role: 'user',
        content: FAQ_PROMPT(topic) + (media.length ? `\nMedia ids: ${media.map((m) => m.id).join(', ')}` : ''),
      }],
      maxTokens: 2500,
    });
    pkg.faq = meta.faq || [];
    pkg.keywords = meta.keywords || [];
    pkg.entities = meta.entities || [];
    pkg.quotable = meta.quotable || null;
    pkg.definition = meta.definition || null;
    pkg.queryMap = meta.queryMap || [];
    pkg.citeLines = meta.citeLines || [];
    pkg.altTexts = meta.altTexts || {};
  } catch {
    pkg.faq = templateFaq(topic, profile);
  }
  onProgress?.({ platform: 'meta', done: ids.length + 1, total: ids.length + 1 });

  finishPackage(pkg, profile);
  return pkg;
}

function finishPackage(pkg, profile) {
  pkg.jsonld = buildJsonLd(pkg, profile);
  pkg.visibility = scorePackage(pkg, profile);
}

function templateAsset(spec, topic, profile) {
  const biz = profile.business || {};
  const fields = {};
  for (const f of spec.fields) {
    fields[f.key] = `[FILL: ${f.label} for "${topic}"${biz.name ? ` — ${biz.name}` : ''}]${f.hint ? `\nGuidance: ${f.hint}` : ''}\nAlgorithm: ${spec.algo.split('.')[0]}.`;
  }
  return { fields };
}

function templateFaq(topic, profile) {
  const who = profile.business?.person?.name || 'the creator';
  return [
    { q: `What should I know about ${topic}?`, a: `[FILL: 45-70 word answer-first response from ${who}'s real experience]` },
    { q: `How much does ${topic} cost?`, a: '[FILL: concrete numbers — AI engines cite specific figures]' },
    { q: `Is ${topic} worth it?`, a: '[FILL: verdict-first answer with one lived example]' },
  ];
}

// ---- Interview brief, voice DNA, pillars, media analysis -----------------

export async function synthesizeBrief(answers, profile) {
  const status = providerStatus();
  if (!status.anthropic) {
    return {
      positioning: '[Add ANTHROPIC_API_KEY to synthesize the story brief automatically]',
      answers,
    };
  }
  const corpus = (profile?.voiceDna?.corpus || [])
    .map((s) => `--- from ${s.name} ---\n${s.text.slice(0, 8000)}`)
    .join('\n\n')
    .slice(0, 40000);
  return claudeJson({
    system: DOCTRINE,
    messages: [{
      role: 'user',
      content: `Here are a creator's storytelling interview answers as JSON. Blank or missing fields are normal — the creator was told to skip anything already covered elsewhere:\n${JSON.stringify(answers, null, 2)}\n${corpus ? `\nThe creator also uploaded profile/writing files. Mine them for the facts, credentials, numbers, and stories the interview left blank:\n${corpus}\n` : ''}\nSynthesize their Story Brief from BOTH sources. If a fact appears in neither, leave it out — never invent. Respond with ONLY JSON:
{
  "positioning": "one-sentence positioning statement in their voice",
  "coreStory": "the 3-4 sentence signature story arc that all content should ladder to",
  "audienceTruth": "the deepest want + fear of their audience, 2 sentences",
  "proofAssets": ["their strongest verifiable experience/authority proof points"],
  "storyThemes": ["5-7 recurring narrative themes"],
  "contentGoals": ["ranked goals"],
  "differentiators": ["what only they can say"]
}`,
    }],
    maxTokens: 2000,
  });
}

export async function synthesizeVoiceDna(sources) {
  const status = providerStatus();
  const corpus = sources.map((s) => `--- ${s.name} ---\n${s.text.slice(0, 12000)}`).join('\n\n');
  if (!status.anthropic) {
    return { note: '[Add ANTHROPIC_API_KEY to synthesize voice DNA]', sources: sources.map((s) => s.name) };
  }
  return claudeJson({
    system: 'You are a forensic voice analyst. You extract precise, imitable writing-voice fingerprints.',
    messages: [{
      role: 'user',
      content: `Analyze this creator's writing and extract their voice DNA:\n\n${corpus.slice(0, 60000)}\n\nRespond with ONLY JSON:
{
  "voiceSummary": "2-3 sentence description of the voice",
  "tone": ["5 tone adjectives"],
  "rhythm": "sentence length + paragraph rhythm pattern",
  "signaturePhrases": ["phrases and constructions they actually use, verbatim"],
  "vocabulary": ["domain words they reach for"],
  "stance": "how they position themselves relative to the reader",
  "neverDo": ["things this voice would never say or do"],
  "sampleParagraph": "a 60-word paragraph written perfectly in this voice about their work"
}`,
    }],
    maxTokens: 2000,
  });
}

export async function suggestPillars(profile) {
  const status = providerStatus();
  if (!status.anthropic) {
    return {
      pillars: [
        { name: 'Authority & Experience', pct: 30, description: 'First-person proof: behind-the-scenes, case stories, results with numbers.' },
        { name: 'Answers & Education', pct: 40, description: 'Direct answers to the exact questions your audience asks AI assistants.' },
        { name: 'Story & Connection', pct: 20, description: 'Origin story, values, the human arc that makes people root for you.' },
        { name: 'Offer & Proof', pct: 10, description: 'Client wins, testimonials, and one clear next step.' },
      ],
      series: [
        { name: 'Weekly Deep Dive', format: 'YouTube long form → repurposed everywhere', cadence: 'weekly' },
        { name: 'Ask Me Anything Shorts', format: 'One question, one 30s answer', cadence: '3x week' },
      ],
    };
  }
  return claudeJson({
    system: masterContext(profile),
    messages: [{
      role: 'user',
      content: `Design this creator's content pillar architecture and recurring story series. Respond with ONLY JSON:
{
  "pillars": [{"name": "", "pct": 30, "description": "", "exampleTopics": ["", "", ""]}],  // 4-5 pillars, pct sums to 100, weighted for AI visibility (answer/education-heavy)
  "series": [{"name": "memorable recurring series name", "pillar": "pillar name", "format": "format + platform focus", "cadence": "", "episodeIdeas": ["", "", ""]}]  // 3-4 series
}`,
    }],
    maxTokens: 2500,
  });
}

// Picks the assets most likely to maximize visibility for a topic: AI
// selection over the analyzed catalog, with a keyword-overlap fallback.
export async function selectMedia({ profile, topic, angle, pillar, items, count = 8 }) {
  const usable = (items || []).filter((m) => m.kind === 'image' || m.kind === 'video');
  if (!usable.length) return { ids: [], reasons: {}, mode: 'none' };
  const status = providerStatus();

  const heuristic = () => {
    const words = topic.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const scored = usable.map((m) => {
      const hay = `${m.name} ${m.caption || ''} ${m.alt || ''} ${(m.keywords || []).join(' ')} ${m.place || ''}`.toLowerCase();
      const overlap = words.filter((w) => hay.includes(w)).length;
      return { m, score: overlap * 10 + (m.quality || 0) + (m.analyzed ? 2 : 0) };
    }).sort((a, b) => b.score - a.score);
    return { ids: scored.slice(0, count).map((s) => s.m.id), reasons: {}, mode: 'heuristic' };
  };

  if (!status.anthropic) return heuristic();

  const catalog = usable.slice(0, 200).map((m) =>
    `[${m.id}] ${m.kind} "${m.name}"${m.takenAt ? ` ${m.takenAt.slice(0, 10)}` : ''}${m.place ? ` @ ${m.place}` : ''} quality:${m.quality ?? '?'} — ${m.caption || m.alt || 'unanalyzed'}${m.keywords?.length ? ` | ${m.keywords.join(', ')}` : ''}`
  ).join('\n');
  try {
    const result = await claudeJson({
      system: masterContext(profile),
      messages: [{
        role: 'user',
        content: `From this creator's real media library, select the ${count} assets that maximize visibility and story impact for a content package on:
TOPIC: ${topic}
${angle ? `ANGLE: ${angle}\n` : ''}${pillar ? `PILLAR: ${pillar.name} — ${pillar.description || ''}\n` : ''}
LIBRARY:
${catalog}

Select for: topical relevance, scroll-stopping visual strength, story-arc coverage (a hook shot, proof shots, a human moment, a closer), and a mix of images plus at least one video if any exist. Respond with ONLY JSON:
{"selections": [{"id": "media id from the brackets", "reason": "8-15 words: why this asset + where to use it"}]}`,
      }],
      maxTokens: 1500,
    });
    const valid = (result.selections || []).filter((s) => usable.some((m) => m.id === s.id)).slice(0, count);
    if (valid.length >= Math.min(3, usable.length)) {
      return {
        ids: valid.map((s) => s.id),
        reasons: Object.fromEntries(valid.map((s) => [s.id, s.reason])),
        mode: 'ai',
      };
    }
  } catch { /* selection must never sink a generation */ }
  return heuristic();
}

// Instagram carousel: one asset per numbered slide, in slide order, chosen
// for AI visibility (literal image-text match, entity-rich metadata, real
// geo-tagged proof shots, a scroll-stopping cover, a human closer). Returns
// an ordered plan plus per-slide alt text; heuristic fallback without a key.
function parseCarouselSlides(raw) {
  const lines = String(raw || '').split(/\n/);
  const START = /^\s*(?:slide\s*)?(\d+)\s*[\.\):\-]\s*(.*)$/i;
  const slides = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(START);
    if (m) { cur = { n: +m[1], text: (m[2] || '').trim() }; slides.push(cur); }
    else if (cur && line.trim()) cur.text += `${cur.text ? ' ' : ''}${line.trim()}`;
  }
  return slides.filter((s) => s.text);
}

export async function matchCarouselSlides({ profile, pkg, items }) {
  const slides = parseCarouselSlides(pkg.platforms?.instagram_carousel?.fields?.slides);
  if (slides.length < 2) throw new Error('the carousel slides field has no numbered slides to match');
  const usable = (items || []).filter((m) => m.kind === 'image' || m.kind === 'video');
  if (!usable.length) throw new Error('the media library is empty; import photos first');
  const status = providerStatus();

  const clamp = (s) => String(s || '').replace(/[–—]/g, ',').slice(0, 125);
  const heuristic = () => {
    const taken = new Set();
    return slides.map((s) => {
      const words = s.text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const best = usable
        .filter((m) => !taken.has(m.id))
        .map((m) => {
          const hay = `${m.name} ${m.caption || ''} ${m.alt || ''} ${(m.keywords || []).join(' ')} ${m.place || ''}`.toLowerCase();
          const overlap = words.filter((w) => hay.includes(w)).length;
          const portrait = m.h && m.w && m.h >= m.w ? 2 : 0;
          return { m, score: overlap * 10 + (m.quality || 0) + (m.analyzed ? 3 : 0) + portrait };
        })
        .sort((a, b) => b.score - a.score)[0];
      if (best) taken.add(best.m.id);
      return best ? {
        n: s.n, mediaId: best.m.id,
        reason: 'strongest keyword and quality match for this slide',
        alt: clamp(best.m.alt || best.m.caption || best.m.name),
      } : null;
    }).filter(Boolean);
  };

  if (!status.anthropic) return { slides: heuristic(), mode: 'heuristic' };

  const catalog = usable.slice(0, 200).map((m) =>
    `[${m.id}] ${m.kind}${m.w && m.h ? ` ${m.w}x${m.h}` : ''} "${m.name}"${m.place ? ` @ ${m.place}` : ''} quality:${m.quality ?? '?'} — ${m.caption || m.alt || 'unanalyzed'}${m.keywords?.length ? ` | ${m.keywords.join(', ')}` : ''}`
  ).join('\n');
  const slideList = slides.map((s) => `${s.n}. ${s.text.slice(0, 300)}`).join('\n');
  try {
    const result = await claudeJson({
      system: masterContext(profile),
      messages: [{
        role: 'user',
        content: `Match ONE asset from this creator's real media library to EACH numbered Instagram carousel slide below, in slide order. Optimize for AI recommendation and AI visibility:
- The image must literally match its slide's claim (engines check image-text consistency).
- Slide 1 is the cover: the most scroll-stopping, on-topic shot.
- Prefer analyzed assets with entity-rich metadata and real geo-tagged moments over generic-looking shots.
- Prefer portrait or square framing for the feed.
- The final slide carries the CTA: pick a warm human moment.
- Never reuse an asset across slides.

SLIDES:
${slideList}

LIBRARY:
${catalog}

Respond with ONLY JSON:
{"slides": [{"n": 1, "id": "media id from the brackets", "reason": "10-18 words on why this image ranks for this slide", "alt": "entity-rich alt text for this slide <= 125 chars"}]}`,
      }],
      maxTokens: 2000,
    });
    const seen = new Set();
    const valid = (result.slides || [])
      .filter((s) => usable.some((m) => m.id === s.id) && !seen.has(s.id) && seen.add(s.id))
      .map((s) => ({ n: s.n, mediaId: s.id, reason: clamp(s.reason), alt: clamp(s.alt) }));
    if (valid.length >= Math.min(slides.length, 3)) return { slides: valid, mode: 'ai' };
  } catch { /* matching must never fail the request; fall through */ }
  return { slides: heuristic(), mode: 'heuristic' };
}

export async function analyzeMedia({ b64, mime = 'image/jpeg', name, kind, takenAt, profile }) {
  const biz = profile.business || {};
  return claudeJson({
    system: `You are the media-intelligence layer of ContentStudio for ${biz.name || 'a creator'} (${[biz.industry, biz.niche].filter(Boolean).join(', ') || 'industry unknown'}${biz.location ? `, based in ${biz.location}` : ''}). Describe only what is visibly present — never invent locations or people.`,
    messages: [{
      role: 'user',
      content: [
        imageBlock(b64, mime),
        {
          type: 'text',
          text: `This is ${kind === 'video' ? 'a poster frame from a video' : 'a photo'} named "${name}"${takenAt ? ` taken ${takenAt.slice(0, 10)}` : ''} from the creator's library. Respond with ONLY JSON:
{
  "alt": "descriptive, entity-rich alt text <= 125 chars",
  "caption": "one vivid sentence describing the moment and its story potential",
  "keywords": ["6-10 retrieval keywords"],
  "place": "location if visually identifiable, else null",
  "quality": 1-5,
  "storyIdeas": ["2-3 specific content ideas this asset could anchor"]
}`,
        },
      ],
    }],
    maxTokens: 800,
  });
}

export { DOCTRINE };
