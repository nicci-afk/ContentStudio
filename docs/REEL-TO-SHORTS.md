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
