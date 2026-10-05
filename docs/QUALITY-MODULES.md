# Quality modules (the 7-module upgrade)

Built 2026-10-05 on dev branch `claude/admiring-goldberg-hwp9er`. Not deployed.
Everything is per workspace (brand entity); nothing crosses between brands.
UI: the **Quality** page (nav), plus panels on every platform tab in Create
and a pacing block on Publish Run.

## Module 1: voice card (`lib/voice.js`)
Default banned phrases and structures, plus `profile.voiceCard` additions,
plus the `neverMention` blocklist. Every generated asset is scanned; a
violation is cited with its span. API: `GET/PUT /api/voice-card`.

## Module 5: fact gate (`lib/facts.js`, `lib/gate.js`)
Knowledge base `profile.knowledgeBase`: `{claim, status: verified |
owner_statement | unverified, source, date}`, plus read-only entries derived
from the profile and Content Plan facts. Checkable claims (money, %, years,
counts, dates, credentials, superlatives) must match a usable entry or they
block. Every decision is logged on `asset.gate.decisions`. Jev is a stub
(`externalClassifier`). API: `GET/PUT /api/knowledge`, `POST /api/packages/:id/gate`.

**Gate flow:** generate, check (voice + facts + format), retry once with the
problems cited, then ship as `gate.status: 'blocked'` if it still fails.
Approval of a blocked asset returns 409 unless `override: true` (logged on
the approval). Field edits re-check. Preflight lists `voice_gate`,
`fact_gate`, `format_gate`, `cross_post`, `thumbnail_brief`, `retired_angle`.

## Module 4: platform formatters (`lib/formats.js`)
`POST /api/formats {core_idea, hook_id, entity_id, asset_refs, platforms}`
(default Instagram post, LinkedIn, Facebook; quick package). Checks:
Instagram hook as line 1, at most 3 hashtags and only at the end, no caption
links, comment trigger when a lead magnet is mentioned; LinkedIn four parts,
first line <= 210 chars, no feed link, quiet CTA; Facebook first line free of
Reels context. Cross-posted text (>= 45% shared 4-grams) gets one rewrite,
then blocks only the later asset. `asset.assetSpec` carries aspect and size.
Instagram specs now cap hashtags at 3.

## Module 2: hook library (`lib/hooks.js`)
Five seed templates plus owner templates (`studio.hooks`) and per-template
stats (`studio.hookStats`). One hook per package is chosen BEFORE platform
writing (one light-tier call), filled only from checked facts for fact
slots, validated against voice and facts, and forced verbatim into every
`hook` field (`enforceHook`). No passing hook means a `[FILL]` placeholder,
never a freeform hook. Hand-edited hooks outside the library fail
`hook_trace`. Deviation from the spec: the contrarian seed challenges a
BELIEF ("Most people think ..."), never a group of practitioners, because
law 17 forbids disparaging anyone in the industry.
API: `GET/POST /api/hooks`, `DELETE /api/hooks/:id`, `POST /api/hooks/test`.

## Module 6: thumbnail briefs (`lib/thumbs.js`)
Every video asset gets `pkg.thumbnails[platformId]`: overlay (<= 6 words,
never the caption's first line), visual direction (face and motion
preferred, full bleed, no letterbox), safe zone (top 14% and bottom 35%
clear), 9:16 at 1080x1920 (16:9 at 1920x1080 for long-form YouTube).
A failing model brief falls back to a deterministic one. Packages made by
the new engine (`qualityGate`) fail preflight without passing briefs.
API: `POST /api/packages/:id/thumbnails`, `PATCH /api/packages/:id/thumbnails/:platformId`.

## Module 3: trend inputs (`lib/trendinputs.js`)
`studio.trendInputs`, imported as a weekly `trends.json`. Entries need a
date and a source or they are rejected. Active for 30 days from the last
observation; re-import renews and keeps the id. Applied as structure
constraints in the platform prompt; each asset records `trendIds`. No
entries means the evergreen baseline. API: `GET/POST /api/trend-inputs`,
`DELETE /api/trend-inputs/:id`.

## Module 7: feedback loop (`lib/feedback.js`)
Metrics: booked calls, DMs, saves, shares, follows (likes ignored). Entered
per published asset (`POST /api/packages/:id/performance`); booked calls
also attribute from leads via `utm_content` = package id (new tracked links
carry it) or the older source + campaign pair. Scheduler every 6 hours runs
what is due: weekly promote (winning pillar's hook templates), biweekly
retire bottom quartile (needs 4 measured, 7+ days old), monthly first-party
trend entries, quarterly lead-magnet review. Retired angles feed the prompt
and a `retired_angle` preflight blocker. Report: `GET /api/feedback/report`
(winners, retired with replacement, promoted share of hook uses by month).
`PUT /api/feedback/settings {auto}`; env `DISABLE_FEEDBACK`, `FEEDBACK_FIRST_RUN_MS`.

## Audit items
- **Book a brief call:** `profile.business.bookingUrl`; public tracked
  redirects `/book/c/<captureId>?p=<pkg>&s=<platform>` and `/book/<lead token>`
  count clicks. New lead status `call_booked` (stamps `bookedAt`, stops the
  nurture sequence); `won` stamps `wonAt`.
- **Closed-loop attribution:** `GET /api/attribution` per package and platform:
  booking clicks, leads, booked, signed.
- **Anti-flag publishing protocol (`lib/pacing.js`):** `GET /api/packages/:id/publish-plan`
  gives each approved asset a suggested time (platform windows, daily caps,
  LinkedIn one a day on weekdays, spacing, never a round minute) and a
  variance check against recent posts. Posting exceptions per platform
  (`PUT /api/publishing/automation`) live in `profile.publishing.automation`;
  only one workspace may hold exceptions unless she confirms volume justifies
  another. With an exception, the instruction SHE copies lets the assistant
  click Post for that platform only after her "post it" for that card.
- **Reviews (`lib/reviews.js`):** same request to every client marked won, once,
  N days later, business hours, unsubscribe link, no gating or incentives.
  Off until switched on. Velocity from recorded counts. Env `DISABLE_REVIEWS`.
- **Entity monitoring (`lib/entitymon.js`):** reads profile links plus listed
  directory pages as a plain bot, checks name, phone and street; walled sites
  are listed for a hand check. Monthly when switched on.

Server-owned profile fields (`knowledgeBase`, `voiceCard`,
`publishing.automation`, `business.bookingUrl`) survive a stale tab's
whole-state save.

## Not built
Interactive lead magnets (quiz, calculator); Meta metric ingestion by API
(numbers are entered by hand); the Jev classifier (stub only).

## Tests
`node tests/voice-facts.test.js` and `node tests/modules.test.js`.
