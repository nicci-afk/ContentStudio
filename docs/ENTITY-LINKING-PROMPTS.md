# Entity linking prompts for the two Lovable sites

Facts supplied by the owner (2026-10-01), used verbatim:

- Registered legal name: **Travel GHR LLC**
- DBA (trade name) exactly as filed: **Conscious Creator**
- Canonical home for Nicci's Person profile: **travelghr.com**

Why: Travel GHR LLC is one legal entity that also operates as Conscious Creator. Today consciouscreator.app publishes The Conscious Creator as a separate organization with its own Person id for Nicci, so an engine can read two companies and two people. These two prompts make every page point at one legal entity and one Person. Run each prompt in the matching Lovable project, then ask for a re-check so the live pages can be fetched and verified from outside.

What Google documents: `legalName` ("the registered, legal name ... if different from name") and `alternateName` ("another common name your organization goes by") on Organization. Google does not document `parentOrganization` or `@id`; they are standard schema.org and harmless, but treat them as supporting links, not as the part that carries the DBA.

---

## Prompt 1: travelghr.com (paste into the Travel GHR Website project)

```
Update the site-wide JSON-LD only. Do not change any page copy or design.

First read the current JSON-LD this site already renders (Organization, TravelAgency, WebSite, Person) and keep every existing property and every existing @id. Make only these changes:

1. On the Organization with @id "https://travelghr.com/#org" add:
   - "legalName": "Travel GHR LLC"
   - "alternateName": ["Conscious Creator"]
   - "subOrganization": { "@id": "https://consciouscreator.app/#org" }
2. If the TravelAgency node is a separate node, add the same "legalName": "Travel GHR LLC" to it as well.
3. Keep the Person with @id "https://travelghr.com/#nicci" exactly as is. This is the single canonical Person for every brand. Make sure its "worksFor" points to { "@id": "https://travelghr.com/#org" }.

Keep the JSON-LD in the prerendered HTML, so it is present in the raw server response with no JavaScript. Do not add dashes of any kind to visible text.
```

## Prompt 2: consciouscreator.app (paste into the Conscious Creator project)

```
Update the site-wide JSON-LD only. Do not change any page copy or design.

First read the current JSON-LD this site renders. Keep every existing node, property and URL except the specific changes below.

1. Nicci's Person: change its "@id" from "https://consciouscreator.app/#nicci" to "https://travelghr.com/#nicci". Update every place on this site that references the old id (founder, organizer, performer, author, worksFor, and so on) to the new id. Keep the Person node fully defined on this site, with the same name, jobTitle and sameAs list, so each page stands on its own. Add "https://travelghr.com" to its sameAs if it is not there.
2. On the organization with @id "https://consciouscreator.app/#org" (The Conscious Creator) keep the name "The Conscious Creator" and add:
   - "legalName": "Travel GHR LLC"
   - "alternateName": ["Conscious Creator"]
   - "parentOrganization": { "@type": "Organization", "@id": "https://travelghr.com/#org", "name": "Travel GHR LLC", "url": "https://travelghr.com" }
   - "founder": { "@id": "https://travelghr.com/#nicci" }
3. The Travel GHR node already on this site (@id "https://travelghr.com/#org"): keep it, and add "legalName": "Travel GHR LLC" and "url": "https://travelghr.com".
4. The Event (@id ".../akumal-2027/#event") keeps "organizer": { "@id": "https://consciouscreator.app/#org" }.

Keep the JSON-LD in the prerendered HTML so it is in the raw server response with no JavaScript. Do not add dashes of any kind to visible text.
```

---

## After both prompts are live (verification, run from this repo)

Fetch each homepage as a plain bot and confirm:

- both sites carry the Person id `https://travelghr.com/#nicci` and no other Person id for Nicci
- `https://travelghr.com/#org` shows `legalName` "Travel GHR LLC" and `alternateName` "Conscious Creator"
- `https://consciouscreator.app/#org` shows `legalName`, `alternateName` and `parentOrganization` pointing at `https://travelghr.com/#org`
- the crawler-view audit still passes 9 of 9 on both

## One name decision for the owner

The DBA as filed is "Conscious Creator". The site and campaign use "The Conscious Creator". The prompts keep the site name and carry the filed DBA in `alternateName`, so both strings resolve to the same entity. Aligning the public name to the filed DBA is a branding choice, not a schema one.
