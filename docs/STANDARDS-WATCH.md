# Standards watch

Monthly research pass on platform algorithms, Google/AI E-E-A-T guidance,
structured data, and AI answer-engine citation behavior. Safe, text-only
findings get applied straight to `lib/platforms.js` (algo notes, limits,
cadence, videoSpec). Anything that would touch doctrine, the blocklist
mechanism, platform ids, field keys, or JSON-LD/schema output is recorded
here as a decision item for the user instead.

## 2026-09-01

Redo of a sweep whose commit was lost before it could push (git proxy
rejected the push; the working tree no longer existed by the time a fresh
session picked it up). Findings below were re-researched from scratch and
cross-checked against the specific claims from that earlier, unpushed pass.

### Applied to `lib/platforms.js`

- **YouTube long-form**: ranking is now explicitly a satisfaction composite
  (post-watch survey signals, return-viewer rate, shares) layered on raw
  watch time, not watch time alone. Chapter spec confirmed unchanged and
  already matches the renderer (3+ ascending timestamps, first pinned to
  00:00, each 10s minimum, or YouTube silently drops them).
  Source: https://support.google.com/youtube/answer/9884579
- **Instagram Reel**: Instagram enforces a hard 5-hashtag cap platform-wide
  (rolled out December 2025); keyword-rich captions now carry more ranking
  weight than tag volume. Originality enforcement (unoriginal reposts
  marked non-recommendable) expanded from Reels/Carousels to photo posts on
  April 30, 2026, evaluated on a rolling 30-day account window rather than
  per post.
  Source: https://later.com/blog/ultimate-guide-to-using-instagram-hashtags/,
  https://petapixel.com/2026/04/30/new-instagram-policies-target-reposted-content/
- **TikTok**: completion rate confirmed as the core ranking signal, 70%+
  drives real distribution and 50% is the meaningful-reach floor; shares
  and saves are weighted heavily alongside completion.
  Source: https://www.go-viral.app/blog/tiktok-algorithm-2026/
- **LinkedIn**: feed ranking runs on LLM-based relevance matching (semantic
  embeddings, not just keyword or engagement counts) that now favors
  accounts with a coherent topical identity over generalist posting. A feed
  post carrying an external link loses roughly 60% reach; articles and
  newsletters carry no such penalty because they render outside the feed
  algorithm entirely. This validates the existing publishing strategy
  (site link lives in the article, not the post) rather than changing it.
  Source: https://searchengineland.com/linkedin-updates-feed-algorithm-llm-ranking-retrieval-471708,
  https://www.forbes.com/sites/jodiecook/2026/07/30/the-linkedin-link-penalty-cutting-your-reach-by-60/
- **Pinterest**: TransActV2 confirmed (rewards fresh lifestyle/shoppable
  imagery, penalizes repinning and keyword stuffing); a January 2026 update
  added an explicit 24 to 48 hour visibility boost for newly published
  pins, and the recommended cadence is 3 to 7 new pins per week per topic
  cluster.
  Source: https://sproutsocial.com/insights/pinterest-algorithm/
- **Reddit**: quantified the citation share. Roughly a quarter to nearly
  half of Perplexity citations trace to Reddit depending on methodology,
  and it appears in a meaningful share of ChatGPT responses; OpenAI and
  Google both hold data-licensing deals with Reddit. Self-promotion norms
  unchanged.
  Source: https://scalegrowth.digital/reddit-and-quora-strategy-for-llm-citations/
- **Google Business Profile**: GBP posts, Q&A, and photos feed the Maps
  AI-generated place summary in addition to AI Overviews and Gemini, and a
  profile inactive 30+ days sees a measurable drop in that AI place-summary
  visibility. Cadence text now flags never letting the profile go quiet.
  Source: https://www.mapranks.com/2026/05/25/our-google-business-profile-for-ai-overview/
- **Bing Places / Copilot**: confirmed Copilot local answers are grounded
  entirely in the Bing index, so an unclaimed or incomplete listing is
  effectively invisible to it. New context: the same Bing index also
  underlies ChatGPT's browsing/search and DuckDuckGo, so one verified
  listing reaches a wider slice of AI-referred local traffic than the Bing
  brand name alone suggests.
  Source: https://almcorp.com/blog/bing-ai-performance-webmaster-tools-complete-guide/
- **Facebook**: outbound-link policy left as a caution rather than a
  direction change, see decision items below; sources conflict on whether
  a hard cap is real or reversed.

### Confirmed unchanged (no edit needed)

- Google E-E-A-T guidance and AI Overviews evaluation: no special
  structured data required, people-first experience-and-sourcing content
  is still what gets cited. Google's first official generative-AI search
  guide (May 15, 2026) restates this.
  Source: https://www.searchenginejournal.com/googles-new-ai-search-guide-calls-aeo-and-geo-still-seo/575026/
- VideoObject, Event, and LocalBusiness/TravelAgency schema requirements
  unchanged; general 2026 guidance is to add recommended properties only
  when the data genuinely exists, which is already this codebase's
  practice (the deliberate price omission on the retreat Event, for
  example).
- YouTube Shorts length: 30 to 45s remains the sweet spot for most content;
  90s can outperform in narrative-dense niches (history, drama-style
  storytelling), which does not describe this creator's short-form output,
  so the existing 45s target / 58s cap stays as is.
- Facebook hashtags: still 1 to 2 max.
- TikTok ideal length: content-type dependent (15 to 30s trend/comedy, 30
  to 60s educational, 60 to 90s storytelling), but travel short-form here
  sits in the shorter educational/storytelling band the current 34s
  target / 58s cap already covers, so `videoSpec` was left unchanged.
- X/Twitter: no prior findings existed to update; new context only (see
  decision items).

### Decision items (not applied, need a human call)

1. **llms.txt.** Previously deprioritized: low domain adoption (~10%),
   negligible bot traffic to `/llms.txt`, and Google has said outright it
   does not use it for ranking or crawling decisions. That is still true,
   but Anthropic announced formal llms.txt support in January 2026 (Claude
   Desktop/claude.ai now consult it in retrieval workflows), the first
   major provider to commit to it. OpenAI and Perplexity remain
   noncommittal. This changes the calculus from "purely speculative, skip
   it" to "one real consumer exists now, the rest still don't." Worth a
   decision on whether the effort is justified for that single surface.
   Source: https://limy.ai/blog/llms-txt-in-2026-the-full-guide
2. **FAQPage schema.** Google deprecated the FAQ rich result in Search
   itself (removed from SERPs May 7, 2026, tooling support fully dropped
   by August 2026). The `FAQPage` schema type is still valid and Google
   says leaving the markup in place causes no harm, it is just no longer
   eligible for the old rich snippet, and Google has said the claim that
   FAQ schema improves AI-citation odds specifically is unconfirmed.
   `lib/visibility.js` currently emits FAQPage JSON-LD as part of the
   citation layer; whether to keep it as is (still crawlable by Bing,
   PerplexityBot, and other RAG crawlers even without the Google rich
   result), relabel its purpose, or deprioritize it is a product call, not
   a text fix, so it was left untouched here.
   Source: https://www.getpassionfruit.com/blog/what-changed-with-google-drops-faq-rich-results-and-what-to-do-now
3. **Facebook outbound links.** Reporting conflicts: some 2026 coverage
   describes Meta testing a hard cap (two link posts per month for
   unverified Pages) with a heavy reach penalty; other coverage says
   Facebook's external referral traffic grew roughly 4x by March 2026 as
   Meta reversed its link-suppression stance. Rather than encode either
   direction into the platform spec, the Facebook algo note was updated
   only to flag the uncertainty; the existing "0-2 hashtags, native video
   over links" guidance already keeps outbound links rare regardless of
   which report turns out right.

### Context, not action items

- Citation-source study across roughly 680 million citations (ChatGPT,
  Gemini, Perplexity, Claude, AI Overviews): Reddit is the top-cited
  source everywhere (about 40% frequency), Wikipedia about 26%, and only
  11 to 14% of top-cited domains overlap between any two engines. There is
  no single-engine optimization strategy; broad authority (Reddit
  presence, Wikipedia-adjacent citations) helps everywhere, but each
  engine still needs its own consideration.
- X (Twitter) open-sourced its Grok-powered ranking algorithm on January
  20, 2026: an author reply to a reply weighs roughly 150x a like, a
  retweet roughly 20x, a bookmark roughly 10x, which reinforces the
  existing "reply to your own thread within an hour" guidance already in
  the platform spec. Grok itself is also a citation-producing answer
  surface inside X.

## Reviewed against

`lib/platforms.js`, `lib/engine.js`, `lib/visibility.js`. Only
`lib/platforms.js` was edited; doctrine laws, the blocklist mechanism
(`neverMention`), platform ids, and field keys were left untouched, as
were `lib/engine.js` and `lib/visibility.js` themselves (their own
em/en-dash usage is internal prompt/code text with a runtime sanitizer
already stripping dashes from generated output, not a spec-text issue).

Also fixed while in `lib/platforms.js`: 15 stray em/en dashes across
labels, algo notes, and field hints, left over from before the standing
"no em or en dashes anywhere" rule (doctrine law 9) was written. These
strings feed generation prompts and some render as UI hints, so they were
cleaned up as part of this pass rather than left for a future one.
