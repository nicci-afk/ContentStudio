# Handoff: Tahiti FAM marketing session (2026-09-30 to 2026-10-01)

**Start here (new session):** read this file, then `docs/` and `outputs/` on branch `claude/tahiti-weekly-plan-drafts`. Ask the creator for the studio password (Basic auth on /api). Nothing in this file is a secret.

## State at close (Oct 1)
- LIVE: LinkedIn article (standalone, CLIA claim since removed by Nicci), Facebook teaser 1 (crossposted to Instagram), website article on travelghr.com (Lovable commit 40b512b, deployed, verified from server HTML). All live URLs are registered in the Tahiti FAM workspace.
- NOT done: newsletter (held by Nicci), Google Business Profile post (blocked on listing verification), week-of-Oct-5 article (drafted and approved in Content Studio, Lovable prompt ready in `outputs/2026-10-05/`), teasers 2 and 3.

The studio password is never stored in the repo. The itinerary and costs live only in her own files.

## Where things are
- Production workspace "Tahiti FAM" id `3aedae398d985776` (the switcher shows it as "Travel GHR": the studio renames the active workspace to `profile.business.name` on every state save in `lib/store.js syncName`, so it matches the original Travel GHR workspace `bb9470f36532761b`).
- Packages in it: `19fa3c3ad1b4f760` "How to combine Tahiti and Moorea in one trip" (linkedin, gbp, newsletter, score about 85); `eb29c063e012e55e` "Is Tahiti worth visiting on its own?" (linkedin, gbp, about 82, target Wed Oct 7); teasers `0765f6dc8136a0b4`, `b30d64662c336a5d`, `62cc9183b83f7a87` (facebook + instagram caption). The creator approved the LinkedIn and Google tabs of both article packages on Oct 1 (approval is hers alone; never approve for her). The teaser packages are not marked approved in the studio even though teaser 1 is live on Facebook and Instagram.
- Drafts, sources and Lovable prompts: branch `claude/tahiti-weekly-plan-drafts`, `outputs/2026-09-30/` and `outputs/2026-10-05/`.
- Content Plan (autopilot drafting) built and pushed on `claude/content-autopilot`, not merged, not deployed. Review notes are in that branch's final commit messages and in the session summary: advisory preflight (approve not gated), UTC schedule, server-owned plan on PUT /api/state, no media in drafts.

## Facts and rules for this brand
- Voice and rules: no firsthand claims until she lands (Oct 10, 18:55 Tahiti); no itinerary, advisor pricing, property names, program name, trainers or flyer; Lois is not named personally, Tahiti Adventures is named ("a local and destination specialist tour operator that helps with lodging, transfers, and activities"; Lois approved naming the company).
- Blocklist in the workspace profile (38 terms) includes the itinerary terms; add to it rather than relying on prose.
- Tahiti facts come from Tahiti Tourisme pages; sources are in `T1_sources.md` and `T1b_sources.md`. The 15 minute flight figure was removed everywhere (unverified).

## Open items
1. **CLIA Certified Cruise Counselor claim: LEFT OUT everywhere (resolved Oct 1).** Not confirmed. Removed from every package field, the profile, the Lovable prompts, the website, and the live LinkedIn article (Nicci edited it). Add it back only after she provides certification evidence (Lovable `roadmap.md` item).
2. **Google Business Profile** has four unverified Travel GHR listings, one suspended. She is keeping 1012 North Main Street, Edwardsville. No GBP post until a listing is verified. Check which listing the profile's Maps link and reviews sit on before removing duplicates.
3. **LinkedIn newsletter default.** The article editor pre-selects her "Expedition Intelligence" newsletter under Publish to. She must select "Individual article". The Chrome extension missed this once; fixed wording is in `public/js/publish.js` on `claude/content-autopilot` and in the run sheet.
4. During-trip daily posts (Oct 13 to 23) are planned privately; she approves from her phone.
5. Lovable commit `d2b7cdc` had an unrelated edit to `src/integrations/supabase/previewAuthStorage.ts`; reverted in `40b512b`. That commit also mirrored the article into `supabase/functions/mcp/index.ts` (consistent with existing articles).
6. Backups are off (`R2_*` env vars not set); production data exists only on the Render disk and snapshots.
