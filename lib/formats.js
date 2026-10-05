// Module 4: platform formatters. One core idea in, native outputs out. The
// prompts already ask for native structure (lib/platforms.js); these are the
// machine checks that hold each output to its contract. A failing output is
// blocked on its own; its siblings are unaffected.
//
// Instagram: hook as line 1, at most 3 hashtags and only at the end, a
//   comment-trigger CTA when a lead magnet is mentioned, never a caption link,
//   a 4:5 or 9:16 asset spec attached.
// LinkedIn: hook, one operational scene, the lesson, a quiet CTA. No
//   engagement bait (the voice card bans it), no link in the feed post.
// Facebook: a mirror of the Instagram idea, with the first line rewritten if
//   it leans on Reels-only context.
// Across the three: shared facts, but never cross-posted text.

export const IG = ['instagram_post', 'instagram_carousel', 'instagram_reel'];
export const FB = ['facebook', 'facebook_reel'];

export const ASSET_SPECS = {
  instagram_post: { aspect: '4:5', min_resolution: '1080x1350' },
  instagram_carousel: { aspect: '4:5', min_resolution: '1080x1350' },
  instagram_reel: { aspect: '9:16', min_resolution: '1080x1920' },
  facebook: { aspect: '4:5', min_resolution: '1080x1350' },
  facebook_reel: { aspect: '9:16', min_resolution: '1080x1920' },
  linkedin: { aspect: '1.91:1 or 4:5', min_resolution: '1200x627' },
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const paragraphs = (s) => String(s || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(?:com|net|org|app|co|io)(?:\/\S*)?\b/i;
const LEAD_MAGNET = /\b(free (?:guide|checklist|planner|template|resource|download)|(?:the|my|our) (?:guide|checklist|planner|template)|download|pdf)\b/i;
const COMMENT_TRIGGER = /\b[Cc]omment\s+["'“]?[A-Z][A-Z0-9]{2,}["'”]?/;
const REELS_CONTEXT = /\b(reels?|swipe|link in bio|watch (?:till|to|until) the end|sound on|tap (?:to|the)|in this video|keep watching)\b/i;

const v = (id, message, field) => ({ rule: 'format', id, message, field, span: '' });

export function formatChecks(platformId, fields = {}, ctx = {}) {
  const out = [];
  const hook = ctx.hook ? norm(ctx.hook) : '';
  if (IG.includes(platformId)) {
    const cap = fields.caption || '';
    const first = norm(lines(cap)[0]);
    if (hook && first && !first.startsWith(hook.slice(0, Math.min(hook.length, 60)))) out.push(v('ig_hook_first', 'caption line 1 must be the hook', 'caption'));
    const tagsInField = (String(fields.hashtags || '').match(/#[\w]+/g) || []);
    const capLines = lines(cap);
    const tagsInBody = capLines.slice(0, -1).join(' ').match(/#[\w]+/g) || [];
    const tagsAtEnd = (capLines[capLines.length - 1] || '').match(/#[\w]+/g) || [];
    if (tagsInBody.length) out.push(v('ig_hashtags_end', 'hashtags only at the very end of the caption', 'caption'));
    if (new Set([...tagsInField, ...tagsAtEnd, ...tagsInBody].map((t) => t.toLowerCase())).size > 3) out.push(v('ig_hashtag_cap', 'at most 3 hashtags on Instagram', 'hashtags'));
    if (URL_RE.test(cap)) out.push(v('ig_no_link', 'no links in an Instagram caption (they are not clickable); use a comment trigger instead', 'caption'));
    if (LEAD_MAGNET.test(cap) && !COMMENT_TRIGGER.test(cap)) out.push(v('ig_comment_trigger', 'the caption mentions a lead magnet, so it needs a comment-trigger CTA such as Comment GUIDE', 'caption'));
  }
  if (platformId === 'linkedin') {
    const post = fields.post || '';
    if (post) {
      const ps = paragraphs(post);
      if (ps.length < 4) out.push(v('li_structure', 'the feed post needs four parts: hook, one operational scene, the lesson, a quiet CTA', 'post'));
      if (lines(post)[0] && lines(post)[0].length > 210) out.push(v('li_hook_length', 'the first line must land within 210 characters (the see more cut)', 'post'));
      if (URL_RE.test(post)) out.push(v('li_no_link', 'no external link in the LinkedIn feed post (it costs reach); the link belongs in the article', 'post'));
      const last = ps[ps.length - 1] || '';
      if (/!{1,}\s*$|\bdon't miss\b|\bact now\b|\blimited time\b|\bhurry\b/i.test(last)) out.push(v('li_quiet_cta', 'keep the closing CTA quiet: no exclamation, urgency or hard sell', 'post'));
    }
  }
  if (FB.includes(platformId)) {
    const text = fields.post || fields.caption || '';
    const first = lines(text)[0] || '';
    if (REELS_CONTEXT.test(first)) out.push(v('fb_first_line', 'the first line leans on Reels context; rewrite it to stand on its own on Facebook', fields.post ? 'post' : 'caption'));
  }
  return out;
}

// Word 4-gram overlap between two texts (0..1). Cross-posting shows up as a
// high share of shared 4-grams; native rewrites of the same facts stay low.
function shingles(s) {
  const w = norm(s).split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 3 < w.length; i++) set.add(w.slice(i, i + 4).join(' '));
  return set;
}
export function overlap(a, b) {
  const A = shingles(a); const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n += 1;
  return n / Math.min(A.size, B.size);
}

const mainText = (id, f = {}) => (id === 'linkedin' ? f.post || f.article : f.caption || f.post || f.description || '');

// Package-level: flag any pair of the native outputs that share too much text.
// The later asset in the pair is the one flagged, so only it is blocked.
export function crossPostCheck(pkg, threshold = 0.45) {
  const ids = Object.keys(pkg.platforms || {}).filter((id) => [...IG, ...FB, 'linkedin'].includes(id));
  const found = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]; const b = ids[j];
      const o = overlap(mainText(a, pkg.platforms[a]?.fields), mainText(b, pkg.platforms[b]?.fields));
      if (o >= threshold) found.push({ platformId: b, with: a, overlap: Math.round(o * 100) / 100, message: `${Math.round(o * 100)}% of its text repeats ${a}. Each platform needs native copy, not a cross-post.` });
    }
  }
  return found;
}
