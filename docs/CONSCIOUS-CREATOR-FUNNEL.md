# Conscious Creator lead funnel

Status: built on the dev branch 2026-10-02. Resources and the sign-up backend are built; landing pages (Lovable) and the nurture scheduler are next.

## How it works

1. A visitor reaches a landing page on consciouscreator.app (from an ad, a post, an email, or a link in a bio).
2. They give a first name and email, tick the required email consent box, and optionally tick an advertising measurement box.
3. The page posts to `POST /api/leads/capture?id=<captureId>`. The server checks the request came from the site's own origin, ignores bots through a honeypot field, rate limits by IP, and records the consent wording and time.
4. The visitor gets the file two ways: an instant download button and an email with a private link. The link is a per lead token, never a public URL.
5. Nicci gets an alert email. The lead appears on the Leads page with a transparent A, B, or C triage score.
6. If the visitor ticked the advertising box and a Meta token is configured, the server sends a hashed email as a `Lead` event. The browser sends the same `Lead` with the same event id, so Meta counts it once.
7. Later, an application through the Google Form (bridge script) marks the same person as an applicant, alerts Nicci again, and sends a separate `SubmitApplication` event.

## The three resources (PDFs in resources/00c295737118d5e2/)

| Resource | Best for | Landing path |
|---|---|---|
| Destination Story Planner | Cold audiences and ads. Broadly useful. | /resources/destination-story-planner |
| Relationship-Driven Advisor Starter Guide | Advisors who want the philosophy. | /resources/advisor-starter-guide |
| A Look Inside The Conscious Creator | Warm leads and the 50 email contacts. Closest to applying. | /look-inside |

Source HTML is in `resources/00c295737118d5e2/src`. Rebuild PDFs with `node scripts/build-resources.mjs 00c295737118d5e2` (needs Playwright with Chromium). Fonts are embedded.

## Meta events

| Moment | Browser (pixel) | Server (Conversions API) |
|---|---|---|
| Landing page view | PageView, ViewContent (category "resource") | none |
| Free resource sign-up | Lead, event id = lead id | Lead, same event id, only with advertising consent |
| Application submitted | none (Google Form is an iframe) | SubmitApplication, only with advertising consent |

Rank events in Aggregated Event Measurement: SubmitApplication, then Lead, then ViewContent, then PageView.

## Nurture sequence (drafts for approval, not yet sending)

Every email gets the physical address and a one click unsubscribe automatically. The first email (delivery) is already built into the manifest. Suggested timing is days after sign-up.

### Email 2, day 2
Subject: The grocery bagger in Playa del Carmen

Hi {first},

On a trip to Playa del Carmen, a friend who lives there walked me through a local grocery store and explained something I would never have found on my own. The baggers work for free. They are senior citizens who volunteer so that shoppers' tips become their income, a quiet program that keeps elders engaged and supported.

That moment showed me the difference between recommending a place and standing inside it. It is why I build trips around relationships with the people who live there.

If you have a moment like that from your own travels, I would love to hear it. Reply and tell me about it.

Warmly,
Nicci

P.S. The thinking behind this is on the philosophy page: consciouscreator.app/philosophy

### Email 3, day 5
Subject: Three questions for your next local partner

Hi {first},

A good relationship starts with a good question. Here are three from the starter guide that you can use this week:

1. What do you most want a guest to understand before they arrive?
2. How do you work with people in your community, and how can guests support them?
3. Who else in your community do you trust and recommend?

Write the answers in their words, and ask before you share them. If you try one, reply and tell me what you learned.

Warmly,
Nicci

P.S. A look inside five days built around this way of working: consciouscreator.app/look-inside

### Email 4, day 9
Subject: Five days in Akumal and Tulum

Hi {first},

In February 2027, fifty travel advisors will spend five days in Akumal and Tulum, February 8 to 12.

A private villa with onsite chefs. A private catamaran day along the reef. Four cenotes, zip lines, and a Mayan village with Living Dreams Mexico. The Sian Ka'an Biosphere by freshwater channel. And hands-on workshops with Nathan Riddle and Kha Ly on storytelling and publishing in your own voice.

Everything in the seat is included, and optional extras are available on request. Seats are selected by application. If it sounds like a fit, I would be glad to read yours: consciouscreator.app/apply

Warmly,
Nicci

### Email 5, day 14
Subject: Is it a fit?

Hi {first},

Selection is intentionally narrow, and it reads for purpose. It may be a fit if:

- You are a travel advisor or agency owner with real intent to build authority in your own voice.
- You are willing to do creative work in destination: capture, edit, post, refine.
- You believe relationships with local people make a better client experience.
- You can say why you want this education and how you will apply it.
- You arrive with humility and curiosity.

If that sounds like you, tell us who you serve and what you are building: consciouscreator.app/apply

Whether or not you apply, I am glad you are here.

Warmly,
Nicci

## Video script for "A Look Inside" (about 75 seconds, for Nicci to record)

Use only these facts. Shots in brackets come from the media library.

Hi, I'm Nicci Grotefendt, the founder of The Conscious Creator and the CEO of Travel GHR. [on camera]

The most powerful recommendations come from memory, from relationship, from the people who live in the place. [Akumal or Tulum establishing shots]

That is why, in February 2027, fifty travel advisors will join me in Akumal and Tulum, Mexico, for five days. [villa exterior]

You arrive to a private transfer, a private villa, and a welcome dinner prepared by our private chef. Your first education session begins that evening with Nathan Riddle and Kha Ly. [villa, chef, dinner]

We sail a private catamaran along the reef. [catamaran]

We visit four cenotes, zip through the jungle canopy, and spend time in a Mayan village with Living Dreams Mexico, our locally owned and staffed partner. [cenotes, zip line, village]

We float the freshwater channels of the Sian Ka'an Biosphere. [Muyil channels]

And every day, you are learning how to tell what you experience in your own voice. [workshop]

Selection is by application, and we read for purpose. If this sounds like you, apply at consciouscreator.app/apply. I would love to meet you. [on camera]

## Rules for this funnel

- No income claims in any ad or email.
- No comparisons to other advisors, agencies, or suppliers.
- Never send health, allergy, dietary, or accessibility answers anywhere. The bridge sends a short allowlist only.
- Consent is explicit and recorded. Advertising consent is a separate, optional box.
- Real estate is out of scope for all Meta work for now.
