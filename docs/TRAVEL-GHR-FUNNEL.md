# Travel GHR corporate events lead funnel

Status: content built 2026-10-02. Workspace `bb9470f36532761b` (Travel GHR, corporate events). Manifest, source HTML and PDF live in `resources/bb9470f36532761b/`. Landing page, capture id and scheduler switch are still to be set up.

## Funnel map

1. A visitor reaches `https://travelghr.com/resources/corporate-event-checklist` from an event QR code, a LinkedIn post, an email signature, or a link.
2. They enter a first name and email and tick the required email consent box (and optionally the advertising measurement box).
3. The page posts to `POST /api/leads/capture?id=<captureId>` (the capture id for this workspace is minted in the Leads page; it is not a secret). The server checks the origin against `profile.business.links.website`, applies the honeypot and rate limit, and records the consent wording and time.
4. The visitor gets the PDF two ways: an instant download button and an email with a private per-lead link.
5. Nicci gets an alert email and the lead appears on the Leads page with its triage score.
6. If switched on in the Leads page, the four follow-up emails below send on days 2, 5, 9 and 14, during business hours Central. The sequence stops when someone unsubscribes, becomes an application or inquiry, or is marked won or lost.
7. Days 9 and 14 invite a discovery call at https://travelghr.com/contact.

### QR code use at events

Point a printed QR code at the landing page URL with a source tag, for example `https://travelghr.com/resources/corporate-event-checklist?utm_source=event&utm_medium=qr&utm_campaign=<event-name>`. Use a different campaign value per event so the Leads page shows which event each sign-up came from. Print the short line "Scan for the Corporate Event Travel Checklist" with the QR code. Test the code on a phone before printing.

## The resource

| Item | Value |
|---|---|
| Title | The Corporate Event Travel Checklist |
| File | `resources/bb9470f36532761b/corporate-event-checklist.pdf` (4 pages, letter) |
| Source | `resources/bb9470f36532761b/src/corporate-event-checklist.html` |
| Rebuild | `node scripts/build-resources.mjs bb9470f36532761b` (needs Playwright with Chromium) |

Sections: attendee information, flights and ground transport, room blocks and the venue, meals and catering, badges and credentials, communicating with each attendee, onsite contingencies, after the event, plus a suggested rhythm and a discovery call invitation.

## Follow-up sequence (drafts, same text as manifest.json)

Every email gets the physical address and a one click unsubscribe automatically.

### Day 2
Subject: Packing lists and portable batteries

Hi {first},

One detail I include for every attendee at an event is a packing list built from three things: their itinerary, their meetings, and the weather where they are going.

It is a small thing, and it is often the one people mention afterward. A reminder about a portable battery before a long education day. A note about what to wear to the evening plan. Practical tips that mean no one has to ask.

If you are planning an event now, section 6 of the checklist covers this. I would love to hear what you would add to your own list. Reply and tell me.

Warmly,
Nicci

### Day 5
Subject: Three questions to ask a venue before you sign

Hi {first},

Before a contract feels settled, a few questions can make the rest of the planning calmer. Here are three from section 3 of the checklist:

1. What is the cutoff date for the room block, and what happens to rooms not reserved by then?
2. When are final counts due for each meal, and how are changes handled after that date?
3. What is the loading and delivery schedule on event days, and how does it affect transfer timing?

Write the answers down and share them with everyone on your team. If you try one, reply and tell me what you learned.

Warmly,
Nicci

### Day 9
Subject: A dinner that came together in two hours

Hi {first},

During one of the events I hosted in Orlando in 2026, a group needed dinner reservations at a restaurant that almost never has openings, plus transportation for everyone, with no advance notice.

It came together in under two hours, through relationships built over years. The evening came off without a visible seam, and the group never saw the work behind it, which is exactly how I like it.

That is the kind of care I bring to each event: every attendee considered individually, and someone reachable the whole way through. If you are planning an event and would like to talk it through, a discovery call is a relaxed place to start: https://travelghr.com/contact

Warmly,
Nicci

### Day 14
Subject: What a discovery call covers

Hi {first},

If you would like to talk about an event, a discovery call is simply a conversation. We would cover:

- The event, the dates, and where your attendees are traveling from.
- What you would most like handled, and what is already in place.
- Any attendees with specific needs, such as speakers or hosts.
- Whether working together feels like a good fit for both of us.

If it is a fit, we will talk about next steps. If it is not, I will say so kindly. You can reach me here: https://travelghr.com/contact

Whether or not we work together, I hope the checklist serves your event well.

Warmly,
Nicci

## Code notes for the other engineer

`lib/leads.js` still carries Conscious Creator wording that will read wrongly for this workspace: `deliveryEmail` adds a P.S. about "the five days this work grows into" pointing at `lookInsideUrl` (non-look-inside slugs), and both `deliveryEmail` and `sequenceEmail` footers say "at consciouscreator.app". Make those manifest driven (for example an optional `emailPs` and `siteName` in the manifest) before enabling this funnel. Until then the manifest `lookInsideUrl` is set to the corporate travel services page.

## LANDING PAGE SPEC (paste into a website builder)

Route: `/resources/corporate-event-checklist`

**Eyebrow:** A checklist from Travel GHR

**H1:** The Corporate Event Travel Checklist

**Sub:** A practical guide to the details behind every attendee, from the first list of names to the thank-you notes afterward.

**Bullets:**
- Eight sections that follow the work in the order it usually unfolds.
- Attendee data, arrivals and ground transport, room blocks, catering counts and dietary needs, badges, and onsite contingencies.
- Written by Nicci Grotefendt, a corporate event travel advisor and tour operator in Edwardsville, Illinois.

**Form fields:** First name, email. Required checkbox: "Email me the checklist and a few follow-up notes from Travel GHR. I can unsubscribe at any time." Optional checkbox: advertising measurement (use the same wording as the Conscious Creator pages).

**Button text:** Send me the checklist

**Meta title:** Corporate Event Travel Checklist | Travel GHR

**Meta description:** A practical 4 page checklist for corporate event organizers, from attendee data and arrivals to catering counts and onsite plans. By Nicci Grotefendt of Travel GHR.

**At a glance (definition paragraph):** The Corporate Event Travel Checklist is a four page guide for people who organize business events. It covers eight areas: attendee information, flights and ground transport, room blocks and the venue, meals and catering, badges and credentials, communicating with each attendee, onsite contingencies, and the follow-up after the event. A corporate event travel advisor manages every logistical layer of a business event, flights, transfers, accommodations, meals, and communication, for every individual attendee, not just the group as a whole. This checklist was written by Nicci Grotefendt of Travel GHR, based in Edwardsville, Illinois.

**FAQ (visible on the page; mark up as FAQPage):**

1. **What is the Corporate Event Travel Checklist?**
   A four page PDF that walks through the details of a corporate event in the order the work usually unfolds, from the first attendee list to the thank-you notes afterward.

2. **Who is it for?**
   Business owners, executives, and event organizers who plan or attend corporate events and want each attendee's journey considered individually.

3. **What does it cover?**
   Eight sections: attendee information, flights and ground transport, room blocks and the venue, meals and catering, badges and credentials, communicating with each attendee, onsite contingencies, and after the event. It also includes a suggested rhythm for the planning period.

4. **Who wrote it?**
   Nicci Grotefendt of Travel GHR, a corporate event travel advisor and tour operator in Edwardsville, Illinois, with more than 15 years in hospitality, from the hotel front desk to general manager. She is a CLIA member, an ASTA member, a Travel Leaders Network member, and a Marriott preferred agency.

5. **What happens after I sign up?**
   You receive the checklist immediately and by email with a private link. If you agree, you will also receive four short follow-up emails over about two weeks. Every email includes an unsubscribe link.

**Optional closing line under the form:** Planning an event? Start a conversation at travelghr.com/contact.
