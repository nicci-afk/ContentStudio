# ContentStudio — project brain

Standalone AI-visibility content engine: Node/Express API + vanilla ES-module
frontend, no build step. Deployed on Render (service `contentstudio`,
`contentstudio-zc9j.onrender.com`) from branch
`claude/content-studio-ai-visibility-shlgxc`. **Every push auto-deploys and
restarts the server, which kills in-flight video renders** — batch changes and
push only when the user is not rendering.

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

**Deployed 2026-07-22 (d84dc24, verified locally end to end against a
mock provider rig; production build not yet eyeballed because sign-in was
unavailable, see auth note below):** Auto-Produce upgrades in
response to user feedback on repetition and talking-head sections:
- Footage variety planner (lib/render.js buildFootagePlan): video sources
  earn slots proportional to their real length (weight = duration/5s, cap
  6), sources are spread so nothing plays twice in a row, and every
  reappearance of a clip seeks to a fresh time window instead of replaying
  its first seconds. Meta now reports clipWindows alongside videoClips.
- Avatar on-camera sections: parseScriptSections splits the script on
  [ON CAMERA]/[TALKING HEAD]/[A-ROLL] vs [B-ROLL] cues (bracketed or
  bare "CUE:" lines). With avatar scope 'sections' (new avatar.scope field;
  'open' = classic hook-only open, the default), each on-camera section
  renders as a HeyGen video (submitted up front in parallel, long sections
  chunked into <=1400-char scenes of one video), b-roll sections each get
  their own ElevenLabs narration + word-timed burned captions, and all
  parts concat losslessly (shared encode profile, timescale 12800; re-encode
  concat as fallback). A failed/timed-out HeyGen section degrades to
  narrated b-roll instead of sinking the render (avatarFailed in meta); a
  failed hook open is skipped. meta.avatar now reflects actual success;
  meta.avatarSections counts on-camera sections. One SRT spans the full
  timeline (avatar sections estimated, b-roll word-timed). The youtube_long
  script hint now asks generation for explicit [ON CAMERA]/[B-ROLL: cue]
  markers; cleanScriptForSpeech strips the new cue lines. UI: avatar toggle
  is now "Use my avatar", with a scope select defaulting to sections when
  the script carries on-camera markers; render details line shows
  "avatar on camera xN" and distinct clip windows.
- ELEVENLABS_API_URL / HEYGEN_API_URL env overrides let local tests mock
  both providers end to end (mock rig + labeled test footage lives in the
  session scratchpad, not the repo).

**Deployed 2026-07-20, second push:** render details line shows the real
clip count ("N real clips"); storage maintenance endpoints: GET
/api/storage (disk totals plus per-workspace media/footage/renders/temp
breakdown), POST /api/storage/cleanup (removes render temp folders no
running job owns, plus partial uploads older than 10 minutes), POST
/api/storage/renders/delete with {workspaceId, renderId}; a boot sweep
deletes orphaned render temp folders at startup (logs "storage: swept
..."); startRender refuses with a clear message when the data disk has
under 1536MB free.

**Launch handoff (2026-07-20).** The user re-imported footage, then the
first long-form Auto-Produce attempt failed with ENOSPC: the data disk
filled (footage originals plus orphaned render temp folders from earlier
interrupted renders). The storage tools above shipped in response; their
boot sweep freed the orphaned temp space automatically at deploy. That
session's egress allowlist blocked contentstudio-zc9j.onrender.com; the
user added the domain to the environment allowlist, which applies to
sessions started after the change. Pickup order:
1. Sign in to production from the session: POST /auth/magic/request with
   {"email":"nicci@travelghr.com"}, read the one-time link from the
   user's connected Gmail (subject "Your ContentStudio sign-in link",
   expires in 15 minutes), GET it with a cookie jar; the cs_session
   cookie lasts 30 days. Always confirm with the user before any push to
   the deploy branch; every push restarts the server and kills renders
   and uploads in flight.
2. GET /api/storage: want 4-5GB free before the long-form render. POST
   /api/storage/cleanup, and with the user's OK delete old renders via
   /api/storage/renders/delete. If still tight, the user expands the
   disk in the Render dashboard (disks only grow; resizing restarts the
   service).
3. GET /api/media: every video item must show hasOriginal true. Any
   still false likely failed during the disk-full window; the user
   re-imports just those files (attach matches exact file name + size).
4. Produce the long-form YouTube video: UI Create view, or POST
   /api/render with packageId, platformId "youtube_long", orientation
   "landscape", the user's cloned ElevenLabs voice ("Nicci · your
   clone"), avatar open enabled (avatar "Cynthia Grotefendt", HeyGen
   voice "Smalls - Voice 1"). Poll GET /api/render/:id (10-20 min);
   verify the finished meta shows videoClips > 0, captions true, avatar
   true, and spot-check the MP4 (blur-fill layout, burned captions).
5. Then: fill the [FILL] facts via the Edit buttons across the package,
   re-check the visibility score, then day-one publishing (YouTube +
   Website Kit into Lovable + LinkedIn same day, then socials per the
   rhythm grid).

**Auth state (2026-07-22 night): magic links are ON.** The user added
MAGIC_EMAILS (nicci@travelghr.com,whoskha@gmail.com) and RESEND_API_KEY
to the Render env; /auth/config reports magic:true, password:true.
Delivery verified end to end for nicci@travelghr.com (link arrived in
seconds from onboarding@resend.dev and the flow is the button in her
inbox). whoskha@gmail.com is still blocked by Resend's testing rule
(403: only the account owner's address until a domain is verified);
to unblock, verify travelghr.com under Resend Domains, then add
MAGIC_FROM=ContentStudio <signin@travelghr.com> to the Render env.
Password sign-in and Basic auth on /api both still work.

**Chapter titling root cause (2026-07-22 night, from the new
chapterTitleError diagnostic):** anthropic 400, "temperature is
deprecated for this model" (claude-sonnet-5 rejects temperature 0.4).
FIXED and deployed in dc6e90a: titleChapters no longer overrides
temperature and providers.claude omits the neutral default entirely, so
the next section render should get Claude-written titles automatically.

**Deployed 2026-07-22 late night (dc6e90a):** Library full-size
downloads: GET /api/media/:id/file serves the strongest stored copy
(video original when uploaded, full-resolution frame otherwise) with an
alt-text keyword filename, and the Library detail panel has a Download
button. Verified on production against a real photo. Note for the user
flow: platforms strip embedded photo metadata at upload, so the alt text
field (copy it from the Library panel into, for example, Facebook's
Alternative text) is what actually carries the metadata; the button
tooltip says the same.

**Built 2026-07-22, third session (on the dev branch, tested locally end
to end against a rebuilt mock rig, NOT yet deployed):** upgrades 1 and 6
from the list below, so the launch video ships with real chapters:
- True chapters from the render (lib/render.js): the finalize pass records
  every part's exact start/end in meta.sections; parts fold into chapters
  (nothing under 10s, first pinned to 00:00, fmt 00:00 or h:mm:ss); titles
  come from Claude (titleChapters, doctrine-aware: no em or en dashes,
  blocklist filtered, industry respect) with first-words fallback when no
  key or on error. Job and meta carry sections, chapters, chaptersApplied.
- Package auto-patch after a successful render: chapters field replaced
  and the description's first timestamp block swapped in place (appended
  under "Chapters:" when the draft had none) when the render yields 3+
  chapters (YouTube's minimum for markers); pkg.renders[platformId] stores
  renderId, duration, orientation, sections, chapters; jsonld and
  visibility rebuild automatically.
- VideoObject JSON-LD (lib/visibility.js): duration (ISO 8601), hasPart
  Clip entries with real startOffset/endOffset, and, once
  pkg.publishedUrls.youtube_long exists (the upgrade-3 registry will fill
  it), url, per-Clip deep links, and a SeekToAction potentialAction.
- /api/health now returns build (RENDER_GIT_COMMIT on Render, git
  rev-parse locally) and bootedAt, so deploys are externally verifiable;
  boot log prints the build too.
- ANTHROPIC_API_URL env override added alongside the ElevenLabs/HeyGen
  ones; the mock rig (scratchpad, not the repo) now mocks all three
  providers plus labeled test footage, and a full sections-mode render
  passed: 4 sections, 4 true chapters, chaptersApplied, avatar x2, real
  clip windows, captions, correct description splice, correct JSON-LD.
- UI (create.js): after a render that auto-filled chapters the package
  reloads in place; the render details line shows "N chapters auto-filled".

**Deployed 2026-07-22 evening (35bd7ae) and launch progress:** the block
above went live (build verified externally via the new /api/health build
field). Signed into production with the studio password (Basic auth; the
password lives in this conversation only, never in the repo). Storage
healthy (7.8GB free), cleanup found nothing stale. Media audit: launch
package media all carry originals; 17 unique video files account-wide
still lack originals (list in session scratchpad prod-media.json). The
launch script got three [ON CAMERA] markers via field edit (open, grocery
bagger story, pricing answer), copy untouched. Launch render v1 completed:
3416bf717fccf3bf, 221s, avatar on camera x3 (Nicci avatar, full frame),
6 true chapters auto-filled into the package, captions, 5 clips over 11
distinct windows. Chapter titling by Claude failed twice in production
(fallback first-words titles used; anthropic itself healthy, cause not yet
identified, diagnostics added, see below).

**HeyGen avatar findings (2026-07-22):** HeyGen's v2 generate now rejects
the legacy "Cynthia Grotefendt" avatar ("does not support unlimited mode,
use Avatar IV or V"), which had been silently degrading every avatar
render all day (fail-safe worked, avatar:false in meta). The account's
"Nicci" avatar (6c15153defb24af3a9a6190ca1e46cd9) is the same person on a
newer generation and renders fine. The plain "Cynthia" avatar is a
different person (bearded man), never use it without asking. The user's
PREFERRED avatar is "Sofia", which the v2 list does not return (newer
generation); find it via the v3 looks list after deploy and verify the
preview face before rendering with it.

**Voice preference (2026-07-22, from the user):** the user's ElevenLabs
voice is 8TIjMlEyk1P66yOtXPHa (professional clone, listed as "Nicci",
category professional). The raw voice reads fast and aggressive to her;
she wants calm and welcoming. Always render with delivery "calm" (which
now also slows narration to 0.93 speed) and that voice id. The instant
clone COsb5gD7rHYmEEDkf7DB was used for launch render v1.

**Deployed 2026-07-22 evening, second and third pushes (891a861, then
cf001ee for avatar group labels), built fourth session and verified
locally against the extended mock rig first:**
- HeyGen v3 migration (lib/providers.js): avatars list via GET
  /v3/avatars/looks (private looks first, one page of public presets, v2
  list as fallback), generation via POST /v3/videos (one script per video;
  long sections submit as consecutive chunk videos and concat after
  download), status via GET /v3/videos/:id. v2 dies 2026-10-31.
- Avatar cutout style (lib/render.js buildCutoutPart): avatar.style
  'cutout' requests HeyGen's transparent webm (VP9 alpha, aspect auto,
  1080p), composites the creator over a muted footage bed built from the
  same variety plan as b-roll (landscape: person full height anchored
  right of center; portrait: centered), audio from the avatar video,
  estimated caption cues burned so captions never drop out on camera.
  Style select in the produce panel defaults to cutout; meta and details
  line carry avatarStyle. Full-frame stays available ('full').
- Narration speed: DELIVERY presets gained speed (calm 0.93, energetic
  1.05) passed to ElevenLabs voice_settings.speed and folded into the
  narration cache key for non-balanced styles.
- Chapter titling hardened: object-wrapped arrays accepted, per-index
  fallback on short lists, and meta now records chapterTitles
  (claude/fallback) plus chapterTitleError so the next failure explains
  itself.
- UI: produce panel prefers the professional voice clone as default and
  labels it "your voice"; burnCaptions factored out and shared.
- Mock rig (scratchpad rig/): v3 endpoints, Sofia private look, alpha
  webm generation; full cutout sections render passed locally (person
  over footage bed verified frame by frame, chapters applied).

**LAUNCH RENDER DONE (2026-07-22, render d7f21fa521b14403):** 243s,
avatar cut out on camera x3 (Sofia group, look "The Clipboard Bearer",
id fde2b14cade8433fbb087d2a217e8e45, kind talking_photo), voice
8TIjMlEyk1P66yOtXPHa, delivery calm, captions, 5 real clips over 13
windows, 6 true chapters auto-filled and then hand-polished via field
edit (question form, real timestamps 00:00 / 00:27 / 02:01 / 02:46 /
02:56 / 03:37). Frames verified: clean alpha edges over real footage.
Score 91 AI-Dominant. The Sofia group has 18 looks; most hold a
champagne flute or are stylized posters, Clipboard Bearer is the clean
presenter. The earlier full-frame cut (3416bf717fccf3bf, Nicci avatar)
stays as fallback. Claude chapter titling failed a third time (fallback
titles were auto-filled, then hand-polished); the failure reason is now
recorded in the render meta on disk but the live job object hides it
until a restart, so after the next deploy or env-save restart, GET
/api/render/d7f21fa521b14403 and read chapterTitleError. Known small
gap: jsonld hasPart Clip names still carry the fallback titles from
pkg.renders (sync them from the chapters field in a future pass).

**FILL facts applied (2026-07-22 night), score 96 AI-Dominant:** the
user supplied the launch facts and 16 field edits landed them across
linkedin, gbp, bing, newsletter, shorts/reel production notes, todo,
and full carousel + x_thread content: deposit $1,000 non-refundable,
25 advisor seats this round expanding to 50, storefront 1012 North Main
Street, Edwardsville, IL 62025, hours by appointment plus on call 24/7
in destination. Profile location rephrased to "Akumal and Tulum, Mexico"
(the old "Akumal/ Tulum" slash never matched copy, failing the geo
check). Phone 618-954-7979 landed in bing.description the next turn; zero
[FILL] placeholders remain in any platform field. Remaining gaps:
pkg.queryMap is empty and pkg.faq answers still carry [FILL] (both need
a citation-layer regenerate endpoint, the PATCH route only reaches
platform fields; build it in the next code pass), and jsonld hasPart
Clip names still carry fallback titles.

**Still parked on the user:** magic-link env vars (MAGIC_EMAILS=
nicci@travelghr.com,whoskha@gmail.com plus RESEND_API_KEY or SMTP trio;
safe to save now, nothing rendering; password auth works meanwhile),
the last four phone digits, then day-one publishing (YouTube upload,
Website Kit into Lovable, LinkedIn same day) whose live URLs feed
upgrade 3. Never regenerate the launch package; it would create a new
package without the render, chapters, or these edits.

## Recommended next for AI visibility (2026-07-22 assessment)

Highest leverage first; 1-3 build directly on the section-based renderer:

1. **True chapters from the render. DONE (built third session 2026-07-22,
   awaiting deploy).** Section parts now have exact start offsets; emit
   real 00:00 chapter lines from finalParts (titles from section content),
   auto-patch the package chapters/description fields after a successful
   render, and add hasPart Clip entries (startOffset/endOffset) plus
   duration/SeekToAction to the VideoObject JSON-LD. Chapters are jump-to
   answers in Google and assistants.
2. **Event + TravelAgency schema.** The launch is literally an event
   (Feb 8-12 retreat, Akumal & Tulum). Add per-package offer/event fields
   (dates, Place with geo, price) emitting Event JSON-LD in the Website
   Kit, and upgrade the business block to TravelAgency (LocalBusiness
   subtype) with areaServed/makesOffer. Most relevant trust signal for
   ranking the retreat itself.
3. **Published-URL registry.** Packages never learn where content went
   live. Add per-platform published-URL fields; feed them into llms.txt
   (canonical versions), JSON-LD url/sameAs, and upgrade the
   cross_surface rubric check to count live URLs instead of drafted
   platforms. Corroboration only works when engines can crawl the copies.
4. **Testimonial/proof store.** Relationship-driven travel ranks on
   attributed client outcomes. Store consented testimonials (name, trip,
   number, date) in the profile, weave them into master context (never
   invent; [FILL] when absent), add a rubric check for at least one
   attributed client outcome per package, and emit Review schema where
   legitimate (on the Event/offer, not self-serving LocalBusiness).
5. **Entity hub.** Website Kit should emit an About/entity-home block:
   Person JSON-LD with sameAs to every canonical profile, the definition
   sentence, NAP identical to GBP/Bing. Add a rubric check for
   person.sameAs >= 3.
6. **Ops: DONE (built third session 2026-07-22, awaiting deploy).** Stamp
   a build id/version into /api/health at deploy so deploys are externally
   verifiable (current deploys are invisible from outside because all
   changed surfaces sit behind auth).

## Agreed roadmap (in order)

1. **Brand Kit** — persistent visual identity (colors, fonts, thumbnail
   style) feeding thumbnail concepts and caption styling in renders
2. **Clustering research** — Claude web-search pass that studies top
   creators/ads for a topic and emits a packaging brief before generation
3. **YouTube retention analyzer** — read audience-retention graphs, flag
   drop-offs, suggest fixes per episode
4. **Multi-tenant SaaS phase** — accounts, encrypted per-user provider keys,
   Postgres, billing (only after the content engine is validated)

## Docs

- `README.md` — setup, full API reference, deploy, auth
- `docs/AI-VISIBILITY-PLAYBOOK.md` — the methodology (E-E-A-T-V, platform
  weighting, capture doctrine, retention loop)
