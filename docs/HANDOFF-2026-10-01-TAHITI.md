# Handoff: Tahiti FAM marketing session (2026-09-30 to 2026-10-01)

Not secrets, not itinerary. The studio password is never stored in the repo; ask the creator. The itinerary and costs live only in her own files.

## Where things are
- Production workspace "Tahiti FAM" id `3aedae398d985776` (the switcher shows it as "Travel GHR": the studio renames the active workspace to `profile.business.name` on every state save in `lib/store.js syncName`, so it matches the original Travel GHR workspace `bb9470f36532761b`).
- Packages in it: `19fa3c3ad1b4f760` "How to combine Tahiti and Moorea in one trip" (linkedin, gbp, newsletter, score about 85); `eb29c063e012e55e` "Is Tahiti worth visiting on its own?" (linkedin, gbp, about 82, target Wed Oct 7); teasers `0765f6dc8136a0b4`, `b30d64662c336a5d`, `62cc9183b83f7a87` (facebook + instagram caption). Nothing is approved; the creator approves.
- Drafts, sources and Lovable prompts: branch `claude/tahiti-weekly-plan-drafts`, `outputs/2026-09-30/` and `outputs/2026-10-05/`.
- Content Plan (autopilot drafting) built and pushed on `claude/content-autopilot`, not merged, not deployed. Review notes are in that branch's final commit messages and in the session summary: advisory preflight (approve not gated), UTC schedule, server-owned plan on PUT /api/state, no media in drafts.

## Facts and rules for this brand
- Voice and rules: no firsthand claims until she lands (Oct 10, 18:55 Tahiti); no itinerary, advisor pricing, property names, program name, trainers or flyer; Lois is not named personally, Tahiti Adventures is named ("a local and destination specialist tour operator that helps with lodging, transfers, and activities"; Lois approved naming the company).
- Blocklist in the workspace profile (38 terms) includes the itinerary terms; add to it rather than relying on prose.
- Tahiti facts come from Tahiti Tourisme pages; sources are in `T1_sources.md` and `T1b_sources.md`. The 15 minute flight figure was removed everywhere (unverified).

## Open items
1. **CLIA Certified Cruise Counselor claim: LEFT OUT (decided Oct 1).** Not confirmed. Removed from every unpublished field in the Tahiti workspace, the Lovable prompts and the profile (credentials are the Tahiti Specialist Program only). The LinkedIn article published Oct 1 still states it until she edits it. Website article published through Lovable without the claim. Add it back only after she provides certification evidence (Lovable roadmap.md item).
2. **Google Business Profile** has four unverified Travel GHR listings, one suspended. She is keeping 1012 North Main Street, Edwardsville. No GBP post until a listing is verified. Check which listing the profile's Maps link and reviews sit on before removing duplicates.
3. **LinkedIn newsletter default.** The article editor pre-selects her "Expedition Intelligence" newsletter under Publish to. She must select "Individual article". The Chrome extension missed this once; fixed wording is in `public/js/publish.js` on `claude/content-autopilot` and in the run sheet.
4. During-trip daily posts (Oct 13 to 23) are planned privately; she approves from her phone.
5. Lovable commit `d2b7cdc` contains an unrelated platform edit to `src/integrations/supabase/previewAuthStorage.ts`; it ships with the next publish.
6. Backups are off (`R2_*` env vars not set); production data exists only on the Render disk and snapshots.
