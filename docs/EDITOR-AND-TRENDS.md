# Editor, templates, trend watch

Nav: "Editor" (`#/editor`). Code: `lib/edit.js`, `lib/trends.js`, `public/js/editor.js`, routes under `/api/edits`, `/api/templates`, `/api/trends`.

## Principle
The studio cuts video from HER OWN footage (library and uploads) and her own true words. It never reuses anyone else's footage, voice, wording or sound, and it never scrapes. Trending sounds are licensed inside Instagram, Facebook and TikTok and cannot be used outside them, so the cut is made here and she adds the sound in the app when she posts natively.

## Edit list (EDL)
Plain JSON: clips (library or uploaded source, in and out, speed 0.25 to 4, fit blur/crop/contain, optional slow push in, keep or mute its sound, transition into it: cut, fade, dissolve, slideleft, slideright, slideup, fadeblack), text overlays (hook, caption, label, cta; top, middle, bottom, lower-third; pop, fade, none; kept out of YouTube's covered zones), and sound (an uploaded music bed with volume, ducking under speech, start offset, loudness to -14 LUFS). `sanitizeEdl` clamps and whitelists everything, drops unknown sources, removes dashes. Max 40 clips, 180 seconds.
Claude plans the list from a brief (`planEdit`), optionally following a template's structure; text is checked against the blocklist, disparaging and contrast rules and retried once. Every row stays hand editable.
Rendering (`startEditRender`) builds one normalized segment per clip (1080x1920, 30 fps, AAC), joins them (concat copy when all cuts, otherwise an overlay and acrossfade graph; the server ships a 2018 ffmpeg without xfade, so transitions use overlay, fade and alpha), then burns text (ASS) and mixes the music in one final pass. Output is a normal render (`<id>.mp4` plus meta, poster, preview), so downloads, previews and storage tools apply. One heavy job at a time (`lib/busy.js`).
Beat detection (`analyzeBeats`) estimates tempo and beat times from the audio by energy flux and autocorrelation; "Cut to the beat" moves clip boundaries onto the nearest beat (within 0.35s).
Finished edits can write Instagram, Facebook and TikTok captions (hashtags capped at 5, audio note describes mood and tempo, never a song) or be sent down the Reel to Short pipeline.

## Templates
A template is a structure: hook pattern, beats (role, seconds, shot type, text pattern), cut pace, text style, transitions, audio kind, caption pattern. Sources: six starter patterns, a reference reel (scene detection plus 8 frames read by Claude for structure only; the upload is deleted immediately), or her own description. Prompts forbid transcribing speech, naming people, brands or songs.

## Trend watch
Public YouTube Shorts metadata only (search by her niche, place and pillars, last 14 days, under 3 minutes) via the official API: titles, lengths, views a day, hashtags. Claude summarizes title shapes, topics, length and hashtags and proposes ORIGINAL ideas she can film from her own trips. Weekly auto refresh is off until switched on. Needs `YOUTUBE_API_KEY` or a connected channel. Instagram and TikTok have no public trend feed for a personal creator account, so those patterns come from reference reels she adds.

## Not built
Effects and stickers from the Edits and CapCut catalogs, green screen, keyframed motion beyond the slow push, auto caption style packs, and a visual drag timeline (rows are edited as a list).
