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

**THE canonical voice (2026-07-23, user directive, supersedes the
ElevenLabs preference above):** the ONE accurate voice is HeyGen
"Nicci - Voice 1", id dDFO3I2QaLuryXEunPHM (English, female). She wants
it 100% of the time, everywhere a voice is used. CRITICAL LIMIT: that
voice exists ONLY in HeyGen; the ElevenLabs account does not have it
(TTS with that id returns elevenlabs 404, verified in production). The
ElevenLabs "Nicci" clones (8TIjMlEyk1P66yOtXPHa professional, COsb...
instant) sound DIFFERENT from her and are now known mismatches; use
them only where ElevenLabs narration is unavoidable, until a matching
ElevenLabs clone exists (recommended: clone the same source audio that
built the HeyGen voice via Voice Studio, then pin it). Consequences:
short-form should render avatar scope 'all' (HeyGen speaks everything,
correct voice); long-form b-roll narration is ElevenLabs and therefore
mismatched until the matching clone exists.
Voice pinning shipped (session 6): profile.voicePrefs
{narrationVoiceId, avatarVoiceId} with preferredVoice/saveVoicePref in
api.js; every voice select (produce panel, Voice Studio, Avatar Studio)
defaults to the pinned id first and saves any manual change back as the
new studio-wide default. Production data has
voicePrefs.avatarVoiceId=dDFO3I2QaLuryXEunPHM set. The UI used to
default the avatar voice to whatever sat first in the HeyGen list
("Smalls - Voice 1"), which caused the two-voice Reel she caught.
Renders before the fix carry wrong voices; HeyGen also kept FAILING
avatar sections all day 2026-07-23 (fail-safe degraded them to narrated
b-roll; check HeyGen credits before more avatar renders).

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

**Deployed 2026-07-23 early morning (c0dab33), short-form production
pass after user feedback on a 142s Reel with spoken stage directions and
a voice switch:**
- Platform videoSpec (lib/platforms.js) on youtube_shorts (3s cuts,
  target 45s, cap 58s), instagram_reel (45s/85s, Meta recommendation
  eligibility ends at 90s), tiktok (34s/58s). The renderer trims speech
  at a sentence boundary to the cap (meta.trimmedToFit, details line) and
  the produce panel shows how long the script reads vs the sweet spot.
- Avatar scope 'all' (UI default on videoSpec platforms): the avatar
  carries the whole video in one voice, ending the open-vs-narration
  voice mismatch on short form.
- cleanScriptForSpeech understands beat sheets: direction lines (SHOT,
  TEXT OVERLAY, ON SCREEN TEXT, MUSIC and friends) drop entirely, speech
  labels (HOOK, CTA, AUTHORITY BEAT) keep their sentence but lose the
  label even with a parenthetical qualifier, and all parenthetical stage
  directions are stripped, so "(spoken)" is never read aloud again.
- Reused stills reverse zoom direction per appearance.
- IMPORTANT user pattern found: the account held 7 near-duplicate
  packages; the user's problem Reel/Shorts renders came from
  afd860a1f8aecb16, not the launch package. With her explicit OK
  (2026-07-23) the six duplicates were deleted; 0d5825c2e277bfec is now
  the only package in the workspace. Their old renders remain on disk
  (orphaned, cleanable via /api/storage/renders/delete if space is ever
  needed).
- Launch package short-form scripts rewritten to platform length in her
  voice (reel 47s, shorts 40s, tiktok 32s spoken), score still 96.

**Deployed 2026-07-23 (04c9e2f), after the user demanded zero duplicate
footage within a video:** no-repeat guarantee. The renderer estimates
needed slide slots up front (est speech seconds / slot, capped at 80)
and tops the media pool up from the whole library when the package's
attached assets cannot fill every slot (ranking: video originals +3,
analyzed +2, plus quality; meta.mediaPool/mediaTopUp, details line shows
"+N library assets for variety"). buildFootagePlan refuses to reuse any
source while an unused one remains. Repeats now only happen when a video
needs more shots than the library holds. Regeneration is NEVER the fix
for footage variety; the pool is renderer-level. First no-repeat Reel
render on the launch package: 42bb6558c7bb0488.

## Next session pickup (written 2026-07-23, session 5 handoff)

**Mobile optimization: DONE (deployed 2026-07-23, 11f20c0, session 6).**
Audited every view at 390x844 with Playwright (seeded demo profile,
canvas-generated media, template package; provider list endpoints mocked
via route interception). Root causes found: the mobile top bar showed
one nav icon with labels hidden and no scroll affordance, the package
tab row exposed 2 of 16 tabs, pillar and series inputs collapsed to
slivers, and the produce panel rendered a literal "null" text node
(DOM append stringifies null; the videoSpec conditional in create.js).
Fixes, all inside the existing 760px media query plus two class hooks
(produce-controls, avatar-options) in create.js: two-row top bar (brand
plus workspace switcher, then a full-width labeled nav row), package
tabs wrap so all platforms are visible, .row.spread wraps everywhere,
pkg-row topics take a full line, pillar/series fields stack, produce
panel controls stack full width, media grid goes two columns, inputs go
to 16px on mobile (stops iOS Safari zoom-on-focus), larger touch
targets, toast and scroll-into-view respect the sticky bar and safe
areas. Desktop verified unchanged at 1280px. Before/after pairs live in
the session scratchpad (pairs/).

**Create tab video speed (built session 6, 2026-07-23, after user
feedback that videos load far too slowly):** render delivery layer.
GET /api/render/:id/poster serves a lazily extracted 640px JPEG frame
(cached as <id>.jpg); a phone-sized preview rendition (<id>.preview.mp4,
960px long side, CRF 28, veryfast, AAC 96k, faststart) builds in the
background after every finalize and backfills for the newest 4 done
renders whenever a package's render list is fetched (never while a
render job runs, never under 1536MB free disk, one at a time via a
queue in lib/render.js); GET /api/render/:id/video?q=preview serves it
when present and falls back to the full master while enqueueing.
Video, poster, and srt now send Cache-Control public max-age 1y
immutable (render files are id-addressed and never change; they were
max-age 0 before, so phones re-downloaded every visit). listRenders
rows carry preview/mp4Bytes/previewBytes; deleteRender removes the new
jpg/preview files too. UI (create.js drawRenders): players are
preload=none + playsinline with the poster, so opening a tab moves only
a few KB of JPEG instead of chunks of every 80MB master; the in-app
player streams the preview when ready; the download button is labeled
"MP4 full quality · NN MB" and always serves the master; only the
newest render shows expanded, older cuts sit behind "Show N earlier
renders". Verified locally end to end (network log: tab open fetches
only posters; play fetches ?q=preview; second render collapses).

**Industry respect incident and hardening (session 6, 2026-07-23):**
the user caught "cesspool" in the long-form YouTube video ("the
cesspool of generic bookings"). Her standing rule is BROADER than the
old law 17 text: never anything negative about ANY part of the travel
industry, including booking sites, listing platforms, OTAs, other
advisors, or any way people book travel; differentiate only by
describing her value. FIXED live via field edits (never regenerate):
youtube_long.script now reads "That's the gap I built this to close",
instagram_reel.caption now reads "I wanted advisors to hand their
clients more than a generic booking, something with a real
relationship behind it"; jsonld transcript rebuilt itself; zero
occurrences remain anywhere in the package; score still 96.
Prevention (built, tested locally): law 17 in lib/engine.js extended
to every part of the industry with the derogatory-vocabulary ban and
the differentiate-on-value rule, and a new industry_respect rubric
check in lib/visibility.js (weight 10) fails the score on unambiguous
slurs (cesspool, dumpster fire, scammy, rip-off, sleazy, shady,
sketchy, predatory, soulless, race to the bottom, churn and burn).
RESOLVED: the corrected render is 7068627d7cc2fcbe (255s, calm, her
professional voice, Sofia Clipboard Bearer cutout, captions, 6 chapters
re-applied, 48 distinct clip windows, srt verified zero occurrences,
"the gap I built this to close" spoken at 1:16). THIS is the upload
cut. Two dirty cuts from the same morning remain on disk as fallbacks
(98a6532432f60e48 and 9906ce6902f90764, both speak the old word near
1:16-1:23); offer deletion. CAVEAT on the corrected cut: avatarFailed
2, so only ONE of the three on-camera sections shows the avatar; the
other two degraded to narrated b-roll (fail-safe). The user accepted
completion but may want a re-try once the HeyGen failure cause (check
credits) is known. Chapter titling by Claude WORKED on this render
(chapterTitles claude, no error) for the first time in production; the
temperature fix is confirmed good. The guard (law 17 widened plus the
industry_respect rubric check) deployed as 9e8afb9 and the launch
package rescored 96 with industry_respect passing.

**Carousel media matching LIVE (session 6, 2026-07-23, builds e54755c
then 30ac016):** POST /api/packages/:id/carousel-media matches one
library asset per numbered slide (Claude-ranked for AI visibility,
keyword fallback with carouselPlan.error recording the reason), writes
per-slide alt text into the carousel alt_text field, stores
pkg.carouselPlan, rebuilds jsonld and score. Launch package matched in
full AI mode: 7 slides, slide-specific reasons, entity-rich alts
(Akumal, Tulum, Living Dreams Mexico, consciouscreator.app), score
96. Found and fixed along the way: slide headers with parentheticals
("Slide 1 (cover):") never parsed; the AI reply truncated at 2000
output tokens with a large catalog (now 4000); the industry_respect
check false-positived on "shady tree" (now requires a business object
after "shady"). NOTE: an earlier heuristic run overwrote the carousel
alt_text and the original slide-targeted lines were restored from a
saved copy before re-running; the current alt_text is the AI slide-
matched set.

**HeyGen credit conservation + short-beat avatars (session 6,
2026-07-23, user: credits burned fast, never wants a full-video avatar,
just a few seconds on camera then B-roll):**
- Avatar clip cache (lib/render.js): finished HeyGen clips are cached
  in <workspace>/renders/avatar-cache keyed on
  sha256(avatarId|avatarKind|voiceId|ext|orientation|avatarSpeed|text).
  Re-rendering the same on-camera beat reuses the raw clip (webm/mp4)
  and composites it over fresh footage, so iteration costs ZERO HeyGen
  credits. Only the raw clip is cached (compositing is local + cheap).
  Fully-cached beats resolve before the HeyGen poll loop (no wait).
  meta/job carry avatarCached and avatarFresh; details line shows "N
  avatar clips reused (no new HeyGen credits)". storage report adds
  avatarCacheBytes. This is THE fix for the burn: every re-render I did
  this day re-spent credits because HeyGen had no cache (narration did).
- Short on-camera beats: capAvatarBeat caps each avatar beat to
  AVATAR_BEAT_SECONDS (12s) at a sentence boundary; overflow speaks over
  B-roll (no text lost). Applies to open and each sections beat. Bounds
  HeyGen seconds per beat, and each capped beat is now a single chunk.
- UI default scope is now 'open' for EVERY video platform (was 'all'
  for short-form). Scope select reworded with credit cost: open = "A
  few seconds on camera, then B-roll (fewest credits)", sections =
  "Short on-camera beat at each [ON CAMERA] mark", all = "...(most
  credits)". She never wants 'all'; it stays available but demoted.
- Voice pins updated per her exact IDs: avatarVoiceId
  e44aa04c8d60430ab6da51db943f1caf (HeyGen "Nicci"), narrationVoiceId
  COsb5gD7rHYmEEDkf7DB (ElevenLabs "Nicci" cloned). Both set in
  production voicePrefs. preferredVoice defaults every voice select to
  these. NOTE she still hasn't shared any video; goal is one she loves,
  cheaply. Avatar beats speak the HeyGen voice, B-roll narration the
  ElevenLabs voice: if those two still sound different to her, the fix
  is one matching clone (upload the HeyGen source audio into Voice
  Studio). Built + tested locally (boot, silent render, beat-cap unit
  tests, cache-key determinism, UI scope default); the HeyGen cache
  hit/miss only proves out in a real production avatar render.

**Render state end of session 6 (voice truth applied):** newest reel
21c48c2da17a88ac (51s, open in Nicci - Voice 1, body narration still
the ElevenLabs clone). Long-form ad5312a5f9624681 (264s, clean copy,
chapters, 50 windows, NO avatar: HeyGen failed 3/3 sections) and
7068627d7cc2fcbe (255s, 1 avatar section in the wrong Smalls voice)
are the upload candidates; ad5312a5 is the most voice-consistent.
PENDING her word: check HeyGen credits (sections failed all day), then
re-render the Reel avatar scope 'all' (100% Nicci - Voice 1) and
decide the long-form narration path (recommended: clone the HeyGen
source audio into ElevenLabs via Voice Studio, pin it as
narrationVoiceId, then one final long-form render).

**Then, in order:** the user posts the Reel and uploads the long-form
video to YouTube; when she shares the URL, build upgrade 3
(published-URL registry: pkg.publishedUrls feeding llms.txt, jsonld
url/sameAs, SeekToAction already wired to read
publishedUrls.youtube_long, cross_surface check counts live URLs); a
citation-layer regenerate endpoint (fills the empty pkg.queryMap and the
three [FILL] FAQ answers, the PATCH route only reaches platform fields);
sync jsonld hasPart Clip names from the edited chapters field; Website
Kit into Lovable (clean the FAQ answers first); then upgrades 2, 4, 5
from the list below (ask her for retreat venue details, price already
known, and for testimonials).

**Auth for the next session:** sign in with the studio password via
Basic auth on /api (password lives in the user's conversations only,
ask her for it; never store it in the repo). Magic links work for
nicci@travelghr.com (whoskha@gmail.com still needs the Resend domain
verification plus MAGIC_FROM). Confirm the running build first via GET
/api/health (build field, currently 04c9e2f).

## Session 7 (2026-08-03): launch video LIVE + full upgrade batch built

**PUBLISHED:** the long-form YouTube video is live:
https://youtu.be/rVG3I3usS9c ("What Is The Conscious Creator? Who It's
Actually For", channel @niccigrotefendt.travel). HeyGen balance 3,000+
credits (user confirmed), so the 2026-07-23 section failures were the
credit outage. User approved R2 off-site backups (has a Cloudflare
account).

**VOICE DIRECTIVE (2026-08-03, supersedes the 2026-07-23 canonical-voice
note):** the user wants her ElevenLabs clone for ALL audio in her voice,
everywhere. Avatar beats now lip-sync the ElevenLabs narration by default
(HeyGen audio-asset path below); HeyGen "Nicci - Voice 1" is no longer
the target. OPEN QUESTION for her: which ElevenLabs clone is THE voice,
professional 8TIjMlEyk1P66yOtXPHa or instant COsb5gD7rHYmEEDkf7DB
(currently pinned as narrationVoiceId). If the published video's
narration sounds right to her, pin the clone that cut used.

**Built 2026-08-03 on dev branch claude/app-system-improvements-d9qe6g
(verified end to end against a scratchpad mock rig for Anthropic,
ElevenLabs, HeyGen, and an S3 mock; NOT yet deployed):**
- Off-site backups (lib/backup.js): daily gzipped JSON bundle (workspace
  registry, every workspace's state/media/packages, render metas) to any
  S3-compatible bucket via hand-rolled SigV4 (zero new deps), 30-day
  retention, GET/POST /api/backup, hourly due-check from boot. Activates
  when R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
  land in the Render env (R2_ENDPOINT/R2_PREFIX optional). Media
  originals and MP4s are NOT included (phase 2 is R2 media offload).
- HeyGen v2 avatar-list fallback removed (v2 dies 2026-10-31). Credit
  preflight: heygenQuota() reads GET /v3/users/me (all three billing
  shapes), cached 5 min; GET /api/avatar/quota; produce panel shows
  "HeyGen balance: ~N credits"; a zero-credit account degrades every
  fresh avatar beat to narrated b-roll up front; meta.heygenCredits.
- Auth rate limiting (lib/auth.js, failures only, per client IP, in
  memory): password 10/15min, Basic auth 25/15min, magic-link sends
  12/hour (response never varies). /api/health stays public.
- Cache eviction (lib/storage.js): narration-cache entries idle >45
  days and avatar-cache entries idle >120 days age out during cleanup
  and the boot sweep (cache hits refresh mtime via touch);
  removedCacheFiles in the cleanup report. deleteRender also removes
  <id>.clip-N.mp4 files.
- ONE-VOICE PIPELINE (the big one): render avatar option audioSource
  ('narration' default | 'heygen'). In narration mode each avatar beat's
  speech renders through ElevenLabs (narration cache applies), uploads
  via POST /v3/assets, and HeyGen lip-syncs it (audio_asset_id replaces
  script+voice_id in POST /v3/videos); one clip per beat (no text
  chunking); avatar captions become word-timed from the ElevenLabs
  alignment (cachedAlignment() recovers timing for cached clips). Avatar
  clip cache keys on narration voice+delivery+text ('elaudio' prefix);
  legacy HeyGen-voice keys unchanged, so every already-paid clip stays
  valid. UI: avatar options gain "Speaks in my narration voice (one
  voice everywhere)" (default) vs "Speaks with a HeyGen voice"; the
  HeyGen voice select hides unless overridden. meta/details line carry
  avatarVoice ("one voice (your clone)").
- Chapter-to-clips repurposer: POST /api/render/:id/clips cuts every
  chapter of a finished render into a 9:16 blur-fill vertical clip with
  its SRT caption window re-burned. Zero provider spend. GET
  /api/render/clips/:jobId polls; GET /api/render/:id/clip/:n downloads;
  clip lists ride the render meta and the render rows (download button
  per chapter, titles included). Needs 2+ chapters and 1GB free disk.
- Published-URL registry (upgrade 3): POST /api/packages/:id/published
  {platformId, url}; "Published URL" field on every platform tab. Feeds
  llms.txt ("## Published content (canonical URLs)"), VideoObject url +
  per-Clip deep links + SeekToAction, Article url/mainEntityOfPage
  (website URL beats linkedin), and cross_surface now counts LIVE
  registered URLs (3+ to pass) instead of drafted platforms. Scores dip
  until 3 URLs are registered; that is the point.
- Citation-layer regenerate: POST /api/packages/:id/citations rebuilds
  queryMap/citeLines/keywords/entities and fills only FAQ answers that
  are empty or [FILL] (real answers kept, deduped by question), grounded
  in a digest of the package's finished hand-edited copy. Platform
  fields never touched. UI: "Rebuild AI-answer layer" in AI Metadata.
- Chapters field edits sync into pkg.renders chapter titles (PATCH
  matches "MM:SS Title" lines to recorded starts within 2s), so jsonld
  hasPart Clip names follow the hand-polished titles. Closes the known
  fallback-titles gap.
- Event + TravelAgency schema (upgrade 2): POST /api/packages/:id/event
  (name, startDate, endDate, locationName, address, price, currency,
  url, description) emits Event JSON-LD (Place, Offer, organizer,
  performer); business block @type comes from
  profile.business.schemaType (set "TravelAgency"), plus areaServed and
  makesOffer. Event editor in AI Metadata.

**Verified locally (mock rig in the session scratchpad, not the repo):**
backup upload grows with data; quota 3120; rate limits 401 to 429 at the
caps with health public; sections render where 2 avatar beats = 2
uploaded audio assets and 2 HeyGen videos carrying audio_asset_id and NO
voice_id; re-render reuses both cached clips with zero new HeyGen calls;
chapters recorded; published/citations/event/chapter-sync all reflected
in JSON-LD; clips are 1080x1920 with audio and burned captions, titled
from the edited chapters field; llms.txt lists the live URL; Playwright
UI smoke clean (no console errors, no stray null text).

**After deploy, in production, in order:**
1. Register https://youtu.be/rVG3I3usS9c as the launch package's
   youtube_long Published URL (0d5825c2e277bfec).
2. PATCH profile.business.schemaType="TravelAgency" (and areaServed),
   then set the launch package event facts (retreat Feb 8-12, CONFIRM
   the year with the user, deposit $1,000, Akumal & Tulum) and rescore.
3. Run the citations regenerate on the launch package (fills the empty
   queryMap and the three [FILL] FAQ answers). Then the Website Kit into
   Lovable is unblocked.
4. Cut chapter clips from the uploaded long-form cut (ad5312a5f9624681
   was the recommended upload; confirm which cut she posted).
5. R2: user creates a bucket + Object Read & Write API token in the
   Cloudflare dashboard and adds the four env vars; env save restarts
   the service (check nothing rendering); then POST /api/backup and
   verify GET /api/backup shows lastSuccess.
6. Voice: pin whichever ElevenLabs clone she confirms as THE voice; the
   next avatar render then speaks entirely in it (open beats included).

**Publish workflow (built 2026-08-03, second push of session 7; user
directives: works across ALL brands/workspaces — she added a Travel GHR
corporate-travel workspace and more brands are coming; NEVER propose
Zapier, she rejected it; token/credit frugality is a standing
requirement):**
- Per-platform approval gate: POST /api/packages/:id/approve stores
  pkg.approvals; an "Approve for publishing" toggle sits on every
  platform tab. Nothing unapproved reaches the publish flow.
- Publish Run page (#/publish?pkg=..., public/js/publish.js, hidden from
  the nav, opened from the package header button): approved assets only,
  in day-one posting order, each card carrying the composer deep link,
  exact field text with copy buttons, media downloads (newest finished
  render + SRT for video platforms, carousel slide files in order), and
  a live-URL box that writes the published registry (llms.txt, JSON-LD,
  cross_surface update on paste). Fully workspace-scoped, so every brand
  gets it automatically.
- The posting model is assisted, not autonomous: the page carries a
  copyable instruction for the Claude in Chrome extension that fills
  each platform's composer verbatim from the card and ALWAYS stops
  before posting. The creator attaches media (the OS file picker cannot
  be driven by an extension) and clicks Post herself, then pastes the
  live URL back. Platform APIs/OAuth deliberately avoided.
- Token economy: claude() gained tier 'light' (used by chapter titling)
  that routes to ANTHROPIC_MODEL_LIGHT when that env var is set; content
  generation always stays on the main model. To activate, set
  ANTHROPIC_MODEL_LIGHT=claude-haiku-4-5-20251001 in the Render env.
- Standards watch: a monthly Routine (created 2026-08-03, fires a fresh
  session on the 1st, 14:00 UTC) researches platform / E-E-A-T / AI
  answer-engine standard changes, writes docs/STANDARDS-WATCH.md,
  applies safe spec-text updates to lib/platforms.js on the dev branch,
  and never deploys. Manage it via the claude-code-remote trigger tools
  (list_triggers / update_trigger / delete_trigger).

## DEPLOYED AND LIVE (2026-08-03, session 7 close, build 6097aff)

Both batches shipped to production with her explicit go-ahead. Deploy
branch fast-forwarded from the dev branch twice (a63fc45, then 6097aff).

**Applied in production (launch package 0d5825c2e277bfec, score 96
AI-Dominant):**
- Published URL registered: https://youtu.be/rVG3I3usS9c on
  youtube_long. VideoObject now carries url, 6 hasPart Clips with her
  hand-polished titles and real offsets, and a SeekToAction; llms.txt
  lists it under "Published content (canonical URLs)".
- profile.business.schemaType = "TravelAgency", areaServed =
  "United States" (confirm areaServed with her; it was a reasonable
  default, not her words).
- Event JSON-LD: The Conscious Creator, 2027-02-08 to 2027-02-12
  (year CONFIRMED by her), Akumal and Tulum, Quintana Roo, Mexico,
  url consciouscreator.app. PRICE DELIBERATELY OMITTED: the $1,000 is a
  non-refundable deposit, not the price, and seats run $2,200 to $3,300
  by room share. Adding an Offer with a real price range is a good next
  step if she wants it.
- THE voice pinned: narrationVoiceId = 8TIjMlEyk1P66yOtXPHa (the
  professional clone, her confirmed choice). avatarVoiceId is now
  irrelevant by default since avatar beats lip-sync the narration.
- Citation layer rebuilt: 15 query phrasings, 3 cite lines, 4 real FAQ
  answers. Zero [FILL] anywhere in the package.
- Six chapter clips cut from the published cut ad5312a5f9624681
  (1080x1920, audio, burned captions): 35s, 92s, 52s, 11s, 49s, 25s.
  Clip 2 at 92s is over the short-form sweet spot; the rest are ready.

**INDUSTRY RESPECT, second incident and the real fix (2026-08-03):** the
citation regenerate produced FAQ answers comparing her to "big-box travel
sites" and "advisors chasing the fastest commission". Root cause: the
FAQ_PROMPT explicitly demanded a comparative question ("...vs...",
"...worth it compared to..."), which overrode law 17, and the
industry_respect rubric only caught outright slurs so it passed them.
Fixed in 6097aff:
- FAQ_PROMPT now asks for a value question and carries an explicit
  no-comparison rule (no booking site, platform, OTA, search engine,
  supplier, agency, or other advisor may be compared to or
  characterized).
- regenerateCitations tells the model NOT to inherit contrasts from the
  source copy: take the fact, state it as what she provides.
- New rubric check industry_respect_comparative (weight 8) catches
  differentiating by contrast: big-box <travel object>, cookie cutter,
  order takers, chasing commission, unlike other advisors, just a
  booking site. It deliberately does NOT flag "more than a generic
  booking" (she approved that exact line as the fix after the cesspool
  incident) and requires a travel object after "big-box" so a literal
  big box store never trips it.
- PATCH /api/packages/:id/citations makes the answer layer hand-editable
  (FAQ pairs, query map, cite lines, definition, quotable) with editors
  in AI Metadata. This was the last surface with no in-place editing.
  NOTE: the regenerate keeps FAQ answers that are already real, so a bad
  answer survives regeneration; hand-edit is the way to replace one.
- Her platform copy carried the same class of phrasing and four
  passages were rewritten live via field edits (all in UNPUBLISHED
  fields; nothing live on YouTube was touched): linkedin.article lost
  "competing on price against big-brand packages" and both "chasing the
  fastest commission" lines, gbp.post lost "can't just Google or book on
  a big-box site", newsletter.body lost "tired of being order-takers"
  and "a search engine can't book". Before and after for each is in the
  session transcript; every replacement uses only grounded facts.
  LEFT ALONE as her judgment call: "not for anyone chasing volume over
  connection" (newsletter), "instead of just booking trips and leaving"
  (reddit, self-referential), and the Living Dreams Mexico "only
  excursion company in the area offering a 100% satisfaction guarantee"
  claim, which she wrote and which is a superlative about a partner.

**Flyer pricing captured (2026-08-03, from her designed flyer):** seats
are all inclusive per person by room share, $2,200 quad / $2,450 triple /
$2,800 double / $3,300 single, 2% payment processing added at checkout,
application only. Event JSON-LD now carries an AggregateOffer
(lowPrice 2200, highPrice 3300, offerCount 4); build 4e58270 added
lowPrice/highPrice support so a tiered price is never flattened to one
number and a deposit is never published as a price. Two FAQ pairs added
from the flyer: what the seat covers (4 nights private villa, all chef
meals, housekeeping, all private transport, every Living Dreams Mexico
excursion, marina/docking/Sian Ka'an fees, daily education with Kha Ly
and Nathan Riddle, Founding Collective membership) and what it does not
(flights, gratuities, trip insurance, 2% processing; upgrades on request:
private SUV $150 round trip, in-villa spa from $150/hour).
UPGRADE PRICING (2026-08-03, from her, CORRECTING THE FLYER): the event
is FEES INCLUDED and private transportation is already in the seat price;
add-ons are optional enhancements only. Alcoholic beverage package $200
per attendee. Luxury private SUV upgrade $100 each way, $200 round trip
(the flyer's "$150 round trip" is WRONG). Payment processing is 3%, not
the 2% printed on the flyer. Gratuity package pricing is still pending
from her. The flyer's "in-villa spa from $150 per hour" is unverified;
two of its three numbers were stale, so confirm before publishing it.
FAQ 5 was rewritten to lead with the fees-included framing and now
carries 3%, the $200 beverage package, and the $100 each way SUV.
FLYER COPY FLAG (her call, outside ContentStudio): the intro reads
"...the way no brochure, agency, or tour operator can", and the inclusions
list has "The fees others forget". Both differentiate by contrast with
other operators, the class she has twice asked to eliminate.

**Still open for her:** the four R2 env vars (bucket contentstudio-backup
created; GET /api/backup reports configured:false until they land), then
POST /api/backup to verify. Register two more live URLs (site, LinkedIn)
to clear cross_surface, the only failing check. Consider an Offer price
range on the Event. ANTHROPIC_MODEL_LIGHT=claude-haiku-4-5-20251001 in
the Render env activates the cheap tier for utility calls.

## Channel strategy + Travel GHR launch (2026-08-03, her decision)

**One flagship channel per brand, to start:** Conscious Creator publishes
long-form YouTube (rVG3I3usS9c already live); Travel GHR publishes a
LinkedIn article. She keeps LinkedIn corporate-focused, so the Conscious
Creator newsletter should NOT be a LinkedIn newsletter (a personal-profile
newsletter notifies her corporate followers; a company-page one separates
cleanly but reaches far fewer). Recommended instead: an owned email
newsletter with a public archive on consciouscreator.app, delivering the
Founding Collective membership the flyer already promises, since an owned
archive is crawlable AND can carry JSON-LD (LinkedIn strips schema).
Not built yet, awaiting her platform choice.

**Travel GHR workspace (bb9470f36532761b) first package, live in
production: eefa86e1b3805561, 96 AI-Dominant.** Topic "What does a
corporate event travel advisor actually do?" (definitional authority),
LinkedIn only to hold token spend down. Profile already had the brief,
voice DNA, and a blocklist (Airbnb, VRBO, Expedia, Booking.com, budget,
deal, discount, cheapest, bucket list, hidden gem, wanderlust, luxurious,
trip of a lifetime). schemaType set to TravelAgency. Still missing:
pillars/series (0) and media (0, so the article needs a cover image she
supplies).

Generated at 75, fixed to 96 by hand:
- BLOCKLIST LEAK: "under budget pressure" reached the post and article
  because it is HER OWN WORDING in profile.business.person.credentials.
  Copy changed to "under real financial pressure". THE PROFILE STILL
  SAYS "budget pressure" and will leak again on the next generation;
  recommend editing the credentials field (or dropping "budget" from
  the blocklist, her call).
- INDUSTRY RESPECT, third instance: the draft had a section titled
  "How Is This Different From a Regular Travel Agent?" opening "A travel
  agent typically books a trip", plus a "The Trust Gap" passage asking
  whether an advisor has "only ever seen the guest side of the desk".
  Rewritten to contrast the WORK, not the people: "How Is This Different
  From Booking a Trip?" and "What to Look For". The new
  industry_respect_comparative check did not catch either, because they
  disparage by sentence construction rather than by known phrase; the
  rubric can only ever catch known patterns, so drafts still need a read.
- Added "operating from Edwardsville, Illinois" (geo check) and changed
  "15+ years" to "more than 15 years" so the stats check matches.
- The AI-answer layer FAILED SILENTLY during generation (template FAQ
  with [FILL], empty queryMap/citeLines/definition). Rebuilt via the
  citations endpoint: 15 query phrasings, 3 cite lines, 4 real FAQ
  answers, clean definition. Build de6dbc8 now records answerLayerError
  on the package and surfaces it in AI Metadata so this is never silent
  again, and clears it on a successful rebuild.
- VERIFIED GROUNDED, nothing invented: CLIA/ASTA/Travel Leaders/Marriott
  preferred agency, 15+ years front desk to GM, turnaround work, and the
  five 2026 Orlando events (Creator Cut 100 attendees Feb 13, EMS Edition
  65 attendees May 19, three Kha Ly MasterClass sessions, sixth booked
  Sept 30 to Oct 6) all trace to her interview answers.

NOTE: cross_surface stays red on any single-channel package (it wants 3
live URLs). That is expected under a one-channel-per-brand strategy;
adding the site page is the cheap way to clear it.

**Travel GHR media library loaded (2026-08-03):** 206 items, 111 images
and 95 videos, ALL analyzed, ALL 95 videos carry their originals, 205
have GPS and every one has a date. Roughly 2GB. This unlocks Auto-Produce
video for Travel GHR (real moving b-roll, not just stills).

**Attach-media gap found and closed (build fb15f3f):** media was only
ever selected during generation, so importing photos AFTER generating
left a finished package with no visuals and no remedy except
regenerating, which would have destroyed every hand edit on the article.
POST /api/packages/:id/media now attaches explicit picks or runs the AI
selection over the analyzed library, takes alt text from each item's
stored analysis (zero extra model calls), and rebuilds jsonld and score.
Control sits in AI Metadata ("Pick media from my library"). Ran it on
eefa86e1b3805561: 8 assets in a story arc (packed conference room hook,
badge and capacity and catering and shuttle proof shots, an itinerary
video, Nicci with her badge as the human moment, group dinner closer),
8 ImageObject entries in the JSON-LD, still 96.

**DISK WATCH:** 4.6GB free of 10.5GB after both libraries (Conscious
Creator 2.4GB, Travel GHR 2.0GB). A render refuses under 1.5GB free, so
there is room for now, but R2 media offload (phase 2 of backups, bucket
and credentials already proven) is the real fix before the library grows
much further.

## Recommended next for AI visibility (2026-07-22 assessment)

Highest leverage first; 1-3 build directly on the section-based renderer:

1. **True chapters from the render. DONE (built third session 2026-07-22,
   awaiting deploy).** Section parts now have exact start offsets; emit
   real 00:00 chapter lines from finalParts (titles from section content),
   auto-patch the package chapters/description fields after a successful
   render, and add hasPart Clip entries (startOffset/endOffset) plus
   duration/SeekToAction to the VideoObject JSON-LD. Chapters are jump-to
   answers in Google and assistants.
2. **Event + TravelAgency schema. DONE (built session 7, 2026-08-03,
   awaiting deploy).** The launch is literally an event
   (Feb 8-12 retreat, Akumal & Tulum). Add per-package offer/event fields
   (dates, Place with geo, price) emitting Event JSON-LD in the Website
   Kit, and upgrade the business block to TravelAgency (LocalBusiness
   subtype) with areaServed/makesOffer. Most relevant trust signal for
   ranking the retreat itself.
3. **Published-URL registry. DONE (built session 7, 2026-08-03,
   awaiting deploy).** Packages never learn where content went
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
