# ContentStudio — project brain

Standalone AI-visibility content engine: Node/Express API + vanilla ES-module
frontend, no build step. Deployed on Render (service `contentstudio`,
`contentstudio-zc9j.onrender.com`). **The exact tracked deploy branch is
unconfirmed**: production picked up commit 5cbb86a only after it was pushed
to BOTH `claude/content-studio-ai-visibility-shlgxc` and
`claude/conscious-creator-launch-140huq` (2026-07-22); check the Render
dashboard Settings > Build & Deploy for the true branch, or push the same
commit to both. **Every deploy restarts the server, which kills in-flight
video renders and media uploads** — batch changes and push only when the
user is not rendering or importing. To verify a deploy landed, fetch a
static file WITH a signed-in cookie: unauthenticated GETs of /js/* return
a redirect to /login, which makes naive marker checks report stale code
forever.

## Architecture

- `server.js` — all routes: state/workspaces/media/generate (job-based)/
  packages/render/voice/avatar/auth/llms.txt
- `lib/store.js` — per-workspace JSON stores (`data/workspaces/<id>/`),
  rolling state snapshots, media file storage
- `lib/engine.js` — generation doctrine (17 laws), master context,
  per-platform generation, FAQ/citation layer, media AI selection, brief and
  voice-DNA synthesis
- `lib/platforms.js` — 14 platform specs (fields drive prompts, UI, rubric)
- `lib/visibility.js` — E-E-A-T-V rubric, schema.org JSON-LD, llms.txt
- `lib/providers.js` — Claude / ElevenLabs / HeyGen clients; list calls are
  cached 10 min with stale-on-failure + one retry
- `lib/render.js` — Auto-Produce: chunked ffmpeg slideshow (memory-bounded),
  word-timed burned captions (ElevenLabs timestamps), HeyGen avatar open,
  narration cache (per voice+script hash), render job state persisted to disk
- `lib/auth.js` — magic-link email sign-in (MAGIC_EMAILS allowlist) +
  password sessions + Basic auth for API tools
- `public/js/` — one module per view; `el()` helper in `ui.js`

## Non-negotiable content rules

1. Never use em dashes or en dashes in any generated copy, example text, or
   user-facing content (doctrine law 9).
2. Respect `profile.business.neverMention` (per-workspace hard blocklist,
   enforced in generation context and scored by the rubric). Never name
   blocklisted entities anywhere — including docs, commits, and chat drafts.
3. Voice DNA uploads are additive (same filename replaces that file only).
4. Interview hints adapt to declared industry; all questions optional.
5. Industry respect (doctrine law 17): never say anything negative about any
   supplier, resort, hotel, cruise line, airline, tour operator, venue, or
   destination. This applies everywhere: generated content, docs, commits,
   and chat drafts. Negative source material is omitted or recast as a
   neutral, unnamed lesson. The creator is a travel industry professional;
   neutral or positive framing only.

## Working conventions

- Test locally first: `PORT=4616 node server.js`, curl the API, drive the UI
  with Playwright (`executablePath: '/opt/pw-browsers/chromium'`). Then push.
- `data/` is gitignored; production data lives on the Render disk at
  `/var/data` (CONTENTSTUDIO_DATA). State snapshots exist for recovery.
- Keys live only in Render env vars (.env locally). Never in the repo.

## Current state (2026-07-19)

Everything core is live: interview + story brief, additive voice DNA, media
library (parallel import, HEIC/video EXIF+GPS, AI analysis, AI selection),
pillars/series with cadence parsing and undo, 14-platform generation with the
GEO citation layer (definition, query map, cite lines), visibility rubric with
blocklist check, in-place field editing, Website Kit (Lovable prompt export),
per-platform tracked CTA links, Auto-Produce video rendering, magic-link auth,
multi-workspace, snapshots.

**Memory: resolved.** The instance is upgraded to Standard 2GB and a
long-form Auto-Produce render completed end to end on it (2026-07-20).
Narration stays cached per voice+script hash, so retries are free.

**Deployed 2026-07-20:** blur-fill slide layout (whole image visible over
a blurred fill, both orientations); original video upload at import
(streamed, 500MB cap) with re-import attaching footage to existing
"frame only" items; real muted video clips cut into Auto-Produce b-roll
(looped to slot, poster-frame fallback); HeyGen photo avatars
(talking_photos) listed and rendered with kind-aware payloads everywhere;
persistent avatar-list errors with retry in Avatar Studio; doctrine law
17. HeyGen API credits are loaded (a HeyGen 402 insufficient_credit was
the earlier avatar block; resolved by the user).

Active user workspace: "Conscious Creator" (application-launch campaign for a
Feb 8-12 Akumal & Tulum retreat; pillars/series architecture documented in
conversation and entered by the user). The launch package id is
0d5825c2e277bfec (the pkg param on the Create view URL).

**Deployed 2026-07-20, second push:** render details line shows the real
clip count ("N real clips"); storage maintenance endpoints: GET
/api/storage (disk totals plus per-workspace media/footage/renders/temp
breakdown), POST /api/storage/cleanup (removes render temp folders no
running job owns, plus partial uploads older than 10 minutes), POST
/api/storage/renders/delete with {workspaceId, renderId}; a boot sweep
deletes orphaned render temp folders at startup (logs "storage: swept
..."); startRender refuses with a clear message when the data disk has
under 1536MB free.

**Launch video shipped (2026-07-22).** Render b579c0cf9b8c9523 (done,
281s, landscape 1080p, captions, 5 real clips, balanced delivery) is the
publish candidate: corrected script with real facts spoken and captioned
(seat pricing $2,200 quad / $2,450 triple / $2,800 double / $3,300
single, all inclusive; applications at consciouscreator.app, capped at
25 now, expanding to 50 next week). Package visibility 91 AI-Dominant.
Working setup that produced it: narration voice ElevenLabs "Nicci"
professional clone 8TIjMlEyk1P66yOtXPHa; avatar open "Sofia luxury
jetsetter with adorable companion" 52554ad24c6d4e9f92b9ada66df366d5
(kind avatar) speaking HeyGen-linked voice "Nicci - Voice 1"
dDFO3I2QaLuryXEunPHM. The "Cynthia Grotefendt" photo-derived avatar is
REJECTED by HeyGen v2 generate ("does not support unlimited mode; use
Avatar IV or Avatar V"); newer gallery avatars do not appear in the
legacy /v2/avatars list but their IDs render fine if the user copies
them from the HeyGen web app. HeyGen v2 endpoints are legacy and shut
off 2026-10-31; migrating providers.js to POST /v3/videos is now a
roadmap item.

**Delivery presets (deployed 2026-07-22, commit 5cbb86a).** Auto-Produce
panel has a delivery selector (Warm & calm / Balanced / Energetic)
mapping to ElevenLabs stability/similarity and HeyGen speech speed;
choice persists in localStorage (default calm). The user A/B tested and
prefers Balanced (the original settings); consider flipping the default.
Narration cache keys include the style except balanced, which keeps
legacy keys.

**Auth state.** Magic links are NOT configured on production (missing
MAGIC_EMAILS and RESEND_API_KEY/SMTP_* env vars); /auth/magic/request
returns 424. Sign in with POST /auth/password {password} using the
studio password (ask the user), cookie jar on cs_session, 30 days.
Always confirm with the user before any deploy; deploys kill renders
and uploads in flight.

**Still open for launch:**
1. User re-imports 48 footage files (56 of 112 library videos have
   hasOriginal false after the ENOSPC window; list in the session's
   footage-to-reimport.txt, media items attach by exact file name +
   size). Frame-only items fall back to stills in renders.
2. ~33 [FILL] placeholders remain on other platforms (instagram_carousel
   and x_thread are entirely ungenerated; FAQ answers, newsletter, Bing
   business address need the user's facts).
3. Day-one publishing: YouTube upload (MP4 + SRT from render
   b579c0cf9b8c9523) + Website Kit into Lovable + LinkedIn same day,
   then socials per the rhythm grid.

## Agreed roadmap (in order)

1. **Brand Kit** — persistent visual identity (colors, fonts, thumbnail
   style) feeding thumbnail concepts and caption styling in renders
2. **Clustering research** — Claude web-search pass that studies top
   creators/ads for a topic and emits a packaging brief before generation
3. **YouTube retention analyzer** — read audience-retention graphs, flag
   drop-offs, suggest fixes per episode
4. **HeyGen v3 migration** — providers.js still calls legacy v2 endpoints,
   which HeyGen removes 2026-10-31; move generate/status to POST /v3/videos
   and list newer gallery avatars
5. **Multi-tenant SaaS phase** — accounts, encrypted per-user provider keys,
   Postgres, billing (only after the content engine is validated)

## Docs

- `README.md` — setup, full API reference, deploy, auth
- `docs/AI-VISIBILITY-PLAYBOOK.md` — the methodology (E-E-A-T-V, platform
  weighting, capture doctrine, retention loop)
