# ContentStudio — AI Visibility Engine

A standalone content studio that designs storytelling to rank where attention actually lives now: **AI recommendations**. It interviews you, fingerprints your voice from your MD profile files, enriches your real photo/video library with AI metadata, and generates complete platform-native content packages — scored against a rubric that exceeds Google's E-E-A-T and targets citation by ChatGPT, Gemini, Perplexity, and Copilot.

It is a self-contained service **with its own REST API**: everything the UI does, any other tool or agent can do with an HTTP call.

## Quick start

```bash
npm install
cp .env.example .env   # add your keys (all optional — see below)
npm start              # → http://localhost:4600
```

| Key | Unlocks |
|---|---|
| `ANTHROPIC_API_KEY` | Story Brief synthesis, Voice DNA, media analysis, all content generation |
| `ELEVENLABS_API_KEY` | Voice Studio: voice cloning + narration audio |
| `HEYGEN_API_KEY` | Avatar Studio: photoreal talking-head video |

Without keys the studio runs in **template mode** — every structure, spec, and rubric still works, with `[FILL]` placeholders instead of AI writing.

### On your iPhone

Run the server anywhere reachable from your phone (same Wi-Fi, or deploy to Render/Railway/Fly), open it in Safari, and tap **Import from device** in the Library — Safari opens your photo library and you can select hundreds of photos/videos at once. The studio extracts capture dates + GPS from EXIF, builds thumbnails, and writes alt text, keywords, and story ideas for every asset.

> iOS never lets a website silently scan your camera roll — the picker is the Apple-sanctioned path. Selecting a large batch once gives the studio the same effect.

## The workflow

1. **Story Interview** — 7-section guided deep-dive (identity, goals, signature story, proof inventory, audience truth, voice, production reality) → synthesized into a persistent **Story Brief**.
2. **Voice DNA** — upload MD/TXT files written in your voice; the studio extracts a forensic voice fingerprint (rhythm, signature phrases, stance, never-dos) used in every generation.
3. **Media Library** — import from the iPhone photo picker; every asset gets AI alt text (≤125 chars, entity-rich), keywords, place detection, quality score, and story ideas.
4. **Pillars & Series** — AI-designed pillar architecture (weighted toward answer/education content that AI engines cite) and named recurring story series with a weekly rhythm + `.ics` export.
5. **Create** — one topic → a full package across 12 formats: YouTube long form, YouTube Shorts, Instagram Reel, Instagram Carousel, TikTok, Facebook, X/Twitter thread, LinkedIn (post + article), Google Business Profile, Alignable, Pinterest, Bing Places — each platform-native, never cross-posted copy.
6. **Visibility Lab** (inside each package) — E-E-A-T-V score, per-check fixes, FAQ layer, keywords/entities, alt text, schema.org JSON-LD (VideoObject with transcript, Article, FAQPage, LocalBusiness, Person, ImageObject), and a live `/llms.txt`.
7. **Voice Studio / Avatar Studio** — clone your voice (ElevenLabs), narrate any script, and render photoreal avatar video (HeyGen) in portrait or landscape.

The methodology is documented in [`docs/AI-VISIBILITY-PLAYBOOK.md`](docs/AI-VISIBILITY-PLAYBOOK.md).

## The API

Base URL: `http://localhost:4600`

### System
| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Provider status |
| GET | `/api/platforms` | Platform playbook (specs, limits, algorithm notes) |
| GET | `/llms.txt` | Live AI-crawler manifest built from your profile |

### Workspaces (one per business)
Every business gets its own isolated workspace — profile, interview, voice DNA, media library, pillars, and packages. The switcher lives at the top of the sidebar; all endpoints below operate on the active workspace. Existing single-profile installs migrate automatically on first boot.

| Method | Path | Description |
|---|---|---|
| GET | `/api/workspaces` | List workspaces + active id |
| POST | `/api/workspaces` | `{name}` → create and activate |
| POST | `/api/workspaces/:id/activate` | Switch active workspace |
| PATCH / DELETE | `/api/workspaces/:id` | Rename / delete (last one is protected) |

### Profile & strategy
| Method | Path | Description |
|---|---|---|
| GET / PUT / PATCH | `/api/state` | Full profile state (interview, voice DNA, pillars, series) |
| POST | `/api/interview/brief` | `{answers}` → synthesized Story Brief |
| POST | `/api/voice-dna` | `{files:[{name,text}]}` → voice fingerprint |
| POST | `/api/pillars/suggest` | Pillar + series architecture from the profile |
| POST | `/api/demo` | Load the demo profile |

### Media
| Method | Path | Description |
|---|---|---|
| GET / POST | `/api/media` | List / add asset (`thumbB64`, `analysisB64`, EXIF fields) |
| POST | `/api/media/:id/analyze` | AI alt text, keywords, place, story ideas |
| PATCH / DELETE | `/api/media/:id` | Edit / remove |
| GET | `/api/media/:id/thumb` | Thumbnail JPEG |

### Generation
| Method | Path | Description |
|---|---|---|
| POST | `/api/generate` | `{topic, angle?, pillarId?, seriesId?, platforms[], mediaIds[]}` → `{jobId}` |
| GET | `/api/generate/:jobId` | Poll progress → finished package |
| GET | `/api/packages` | Package index with visibility scores |
| GET / DELETE | `/api/packages/:id` | Full package / remove |
| POST | `/api/packages/:id/rescore` | Re-run rubric + JSON-LD |

### Voice & avatar
| Method | Path | Description |
|---|---|---|
| GET | `/api/voice/voices` | ElevenLabs voices (clones flagged) |
| POST | `/api/voice/clone` | `{name, samples:[{name,mime,b64}]}` → instant voice clone |
| POST | `/api/voice/tts` | `{voiceId, text}` → mp3 |
| GET | `/api/avatar/avatars` · `/api/avatar/voices` | HeyGen avatars / voices |
| POST | `/api/avatar/generate` | `{avatarId, voiceId, text, orientation}` → `{videoId}` |
| GET | `/api/avatar/status/:id` | Render status + video URL |

Example — generate a package from anywhere:

```bash
curl -X POST http://localhost:4600/api/generate \
  -H 'content-type: application/json' \
  -d '{"topic":"Is an Antarctica cruise worth the money?","platforms":["youtube_long","linkedin","gbp"]}'
```

## Deploying

## Signing in

Two ways in, both yielding a 30-day session: **magic link** (enter an email from the `MAGIC_EMAILS` allowlist; a one-time link valid 15 minutes arrives by mail) and the **studio password** (`STUDIO_PASSWORD`). Magic links need an email sender: set `RESEND_API_KEY` (resend.com), or SMTP — for Gmail, create an App Password at myaccount.google.com/apppasswords and set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER`, `SMTP_PASS`. Basic auth with the password still works for API/curl calls.

## Deploying

**Render (recommended):** this repo ships a `render.yaml` blueprint. In Render choose **New → Blueprint**, connect the repo, pick the branch, and Render provisions the service with a persistent 1 GB disk for your data. It prompts for `STUDIO_PASSWORD` (required — gates the whole studio behind a password) and your provider keys (optional, add later in the Environment tab anytime).

Any other Node 18+ host also works. `Dockerfile` included:

```bash
docker build -t contentstudio . && docker run -p 4600:4600 --env-file .env -v cs-data:/app/data contentstudio
```

Data (profile, media, packages) lives in `./data/` — mount or back it up. Keys live only in `.env` on the server.

## Honest notes

- **Photo library**: iOS only exposes photos through the picker (by design, for privacy). The studio makes one big selection session equivalent to a scan.
- **Voice cloning**: clone only your own voice or one you have written permission to use.
- **Avatars**: the realism ceiling comes from HeyGen's custom avatars trained on ~2 minutes of your real footage (recorded via HeyGen); once created they appear in the Avatar Studio automatically. Disclose synthetic media where platforms require it (Meta, TikTok, and YouTube all do).
- **Template mode**: with no Anthropic key, generation returns structured `[FILL]` scaffolds — the specs, limits, and rubric still apply.
