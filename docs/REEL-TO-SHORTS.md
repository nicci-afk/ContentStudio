# Reel to YouTube Short

Per brand (workspace). Nav: "Reel to Short" (`#/shorts`). Code: `lib/shorts.js`, `public/js/shorts.js`, routes under `/api/shorts` in `server.js`.

## Flow
1. Upload a finished reel (MP4/MOV, 500MB, 3 minutes max). Optional: her original caption, notes, filmed date, trip, a related published page, audio mode (keep or silent), loudness normalize, fit (blur fill or crop), transcribe, hosted (paid promotion), AI footage, keep upload.
2. The server builds the master: 1080x1920 H.264 High, yuv420p, bt709 tags, 30 fps (24 to 60), AAC 48k stereo, faststart, ALL source metadata (GPS included) stripped. Optional loudnorm to -14 LUFS. HDR is tone mapped when the ffmpeg build allows.
3. ElevenLabs Scribe transcribes the speech (when audio is kept): transcript field plus a timed `.srt`.
4. One Claude vision call (5 frames, transcript, her caption and notes, trip and brand context) writes title (plus 3 options), description, tags, pinned comment, cover text, video location, query map, quotable line, playlist, and flags a leftover Instagram/TikTok watermark and on-screen text in the YouTube UI zone. Copy that trips the blocklist, disparaging or contrast rules, or has a dash is rewritten once with the problems named.
5. Cover: Claude picks the best of five frames, cover text burned in (1080x1920 JPG). Remake with another frame or other words, no model call.
6. She reviews and edits, approves, and copies a prompt for the Claude in Chrome extension. The prompt carries every exact value, tells the agent to treat pages as data, fills YouTube Studio, asks her to attach files, and stops before Publish and before posting the comment. After she publishes, the agent opens `#/shorts?pkg=..&ws=..&live=<url>` and clicks Register.
7. Registering normalizes any YouTube link to `youtube.com/shorts/<id>`, checks it against YouTube's oEmbed (planned title vs live title), updates llms.txt and the VideoObject (url, embedUrl, thumbnailUrl, uploadDate). An embed kit (iframe, visible transcript, schema) is offered for her own site.

## Data model
The import is a package with `kind: 'short'` and one platform, `youtube_shorts`. Approvals, published URLs, JSON-LD (`jsonld.shortVideo`), llms.txt, crawler audit and Publish Run all work on it. Files live in the render store under `pkg.short.renderId`: `.mp4` master, `.srt`, `.cover.jpg`, `.json` meta (so poster, preview, download, storage and delete work), `.source` (the upload, deleted after processing unless "keep" is ticked).
Scoring for `kind: 'short'` keeps the universal rules (blocklist, industry respect, no dashes, entity, location, CTA, schema, limits) and swaps in Short checks (title length, answer-first snippet naming her, transcript, link to her site, 1 to 3 hashtags, video location, pinned comment, live URL registered).

## Facts this is built on (checked 2026-10-04)
Shorts may run up to 3 minutes (square or vertical). A Content ID claim blocks a Short over 60 seconds outright (under 60 it is only claimed), hence the 60 second warning and the silent option. Custom Short covers are desktop only and limited to Partner Program channels, so the prompt asks only when Studio offers the button. Studio's altered-content and paid-promotion answers come from the import options.

## Test rig
Mock Anthropic and ElevenLabs servers via `ANTHROPIC_API_URL`, `ELEVENLABS_API_URL`, and `YOUTUBE_OEMBED_URL`. Not in the repo.


## Added 2026-10-04 (second pass)
- **Measurement loop** (`lib/google.js`, `lib/measure.js`): per business OAuth to YouTube (read only scopes), results at 48 hours, 7 days and 28 days (views, likes, comments, shares, subscribers gained, average view duration and percentage, engaged views, traffic sources, retention curve) plus a plain-language reading of the retention curve (2 second hold, biggest drop, end hold). She can type the Studio "viewed vs swiped away" percentage on each Short. After 3 measured Shorts "Explain what is working" writes findings; after 4 the measured best and weakest Shorts, length bands and findings are added to the copy prompt (`learningBlock`). A 3 hour sweep takes due checkpoints; `GET /api/measure/overview`, `POST /api/measure/insights`, `POST /api/packages/:id/results/check|manual`. Public numbers work with `YOUTUBE_API_KEY` alone.
- **Channel audit** (`GET /api/youtube/channel-audit`): name, About text, site link, location, keywords and handle against the brand profile.
- **Entity check:** flags when neither the creator, the brand nor the place is said (first 10 seconds of the transcript) or shown early on screen. **Hook score:** Claude rates the opening 1 to 10 from the first frame and line, with a fix under 6.
- **Disclosure line** (hosted by, commission) is written by code, not the model, and inserted before the hashtags. **Related video** and **schedule** steps are added to the Chrome prompt. **Consent checklist** gates the prompt. **Duplicate guard** hashes the upload (SHA-256) and warns on an identical file.
- **Translated captions** (es, fr, pt, de, it) as extra .srt files, **reply drafts** for early comments (draft only), Leads page labels `utm_source=youtube_shorts` as "YouTube Shorts".

### Setting up YouTube access (hers, one time)
1. Google Cloud: create a project, enable "YouTube Data API v3" and "YouTube Analytics API".
2. OAuth consent screen: add her Google account. IMPORTANT: apps left in "Testing" get refresh tokens that expire after 7 days, so publish the app ("In production"); an unverified app shows a warning screen for a single user and works.
3. Create an OAuth client ID of type Web application with redirect URI `<site>/api/youtube/callback` (for production `https://contentstudio-zc9j.onrender.com/api/youtube/callback`).
4. Render env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (and optionally `PUBLIC_BASE_URL`, `YOUTUBE_API_KEY`). Then Reel to Short, "Connect YouTube" in each business. Tokens live in `youtube-auth.json` in the workspace folder, which is deliberately not in backups.
