# Lovable prompt: add the Tahiti and Moorea journal article to travelghr.com

Paste this into the Lovable editor for the Travel GHR Website project (f3ebf3fa-86a9-40d8-a2c7-074c248c21bb). Do not send it through the API, which dropped the last request silently. Attach the licensed image `AdobeStock_222935439.jpg` in the same message. Publish on Fri Oct 2, after the LinkedIn article is live.

---

Add one new journal article to `src/data/insights.ts` and nothing else in the content. Rules:

1. Append the entry below to the `insights` array, after the existing entries. Do not edit, reorder or remove any existing article. Do not change `src/data/author.ts`.
2. Save the attached image as `public/insights-images/journal/tahiti-moorea-aerial-hero.jpg`.
3. The article must live at `/journal/how-to-combine-tahiti-and-moorea-in-one-trip` exactly like the existing "What Does a Corporate Event Travel Advisor Actually Do?" article (same route, same `canonicalPath` handling, same layout, same breadcrumbs, same JSON-LD generation: Article, FAQPage, Person, Organization, BreadcrumbList).
4. Add the new URL to `public/sitemap.xml`, `public/rss.xml` and the journal list in `public/llms.txt`, the same way the existing journal articles appear.
5. Make sure the build prerenders the new route (`scripts/prerender.mjs` via `getRoutes`) so the full text and JSON-LD are in the server HTML, then confirm it shows in the prerender manifest.
6. Copy the text verbatim. Do not rewrite, add facts, add prices, or add any em dash or en dash.
7. Reply with the commit and the list of files changed.

```ts
  {
    slug: 'how-to-combine-tahiti-and-moorea-in-one-trip',
    canonicalPath: '/journal/how-to-combine-tahiti-and-moorea-in-one-trip',
    headline: 'How to Combine Tahiti and Moorea in One Trip',
    metaDescription:
      'Tahiti and Moorea are 25 to 45 minutes apart by ferry. Nicci Grotefendt of Travel GHR explains how the two islands fit one trip and why a local operator matters.',
    primaryKeyword: 'combine Tahiti and Moorea in one trip',
    secondaryKeywords: ['Tahiti and Moorea itinerary', 'Moorea ferry from Tahiti', 'French Polynesia travel advisor', 'Tahiti Specialist Program', 'privately curated Tahiti travel'],
    contentPillar: 'Destination',
    targetQueryCategory: 'Destination',
    publishedISO: '2026-10-02',
    modifiedISO: '2026-10-02',
    readingMinutes: 5,
    heroImage: '/insights-images/journal/tahiti-moorea-aerial-hero.jpg',
    heroImageAlt: 'Aerial view of Moorea and Tahiti islands and their lagoon in French Polynesia, about 25 to 45 minutes apart by ferry',
    featuredSnippetTarget:
      'Tahiti and Moorea combine easily in one trip. Moorea is a 25 to 45 minute ferry ride from Tahiti, so the two islands fit one itinerary without a long transfer. Tahiti offers Papeete, markets, museums and waterfalls. Moorea offers lagoon experiences, two bays and mountain viewpoints.',
    bodyMarkdown: `**Yes, Tahiti and Moorea combine easily into one trip, because Moorea sits a short hop from Tahiti.** Tahiti Tourisme lists the ferry at 25 to 45 minutes, so one itinerary can hold Tahiti's culture and Moorea's lagoon without a long travel day between them.

I am Nicci Grotefendt, founder of Travel GHR in Edwardsville, Illinois, a CLIA Certified Cruise Counselor, and a graduate of the Tahiti Specialist Program. This fall I am heading to French Polynesia to personally vet it, and this is the question I want to answer well before I go.

## Can Tahiti and Moorea be combined in one trip?

Tahiti and Moorea combine easily in one trip. Moorea is a 25 to 45 minute ferry ride from Tahiti, so the two islands fit one itinerary without a long transfer. Tahiti offers Papeete, markets, museums and waterfalls. Moorea offers lagoon experiences, two bays and mountain viewpoints.

## Why do the two islands work together?

Tahiti is the largest island in the Society Islands, about 1,042 square kilometers with roughly 192,000 residents, and it is the main entry point to the Islands of Tahiti, with the international airport. Moorea is far smaller, about 133.5 square kilometers with roughly 18,000 residents. Tahiti Tourisme calls Moorea "Tahiti's little sister" and describes it as a popular weekend escape for people who live on Tahiti.

That scale difference is the reason the pairing works. One island is where you arrive and meet the place. The other is where you slow down.

## What does Tahiti add to the trip?

Tahiti is where most journeys begin. Papeete is the capital and administrative center. Tahiti Tourisme points to the food trucks and local dining around Place Vaiete, the gardens of the Museum of Tahiti and Its Islands, waterfalls such as those in the Fara'ura valley, the Arahoho blowhole, black sand beaches, and the wilder Tahiti Iti peninsula, known for the Teahupo'o surf break.

## What does Moorea add to the trip?

Moorea is where the landscape takes over. Tahiti Tourisme highlights Opunohu Bay and Cook's Bay, the Montagne Percee (the "pierced mountain"), the belvedere viewpoint, archaeological marae and the Papetoai temple, hiking, and lagoon experiences including diving, whale watching and swimming with rays. Accommodation ranges from hotels to Tahitian guesthouses, and sailboat cruises also reach the island.

## How do you move between Tahiti and Moorea?

Moorea is reached from Tahiti by passenger ferry or by plane. Ferry timing varies by vessel, and schedules change, so I confirm the crossing for each client at the time of planning rather than assume. The choice between sea and air is usually about the rest of the day: what you are carrying, when you land, and what you want the transfer itself to feel like.

## Why does a destination operator matter for Tahiti and Moorea?

An island pairing looks simple on a map, and the details live on the ground: transfers timed to arrivals, the right guide on the right island, local knowledge that does not show up in a brochure. That is why I build Tahiti with a destination operator. I work with Tahiti Adventures, a local and destination specialist tour operator that helps with lodging, transfers, and activities. Local knowledge is what lets a trip feel personal.

My approach is the Travel GHR promise: **Privately Curated. Personally Yours.** I can tell you how I plan it and who I plan it with, and this fall I am going to see it for myself.

## What should you decide before planning Tahiti and Moorea?

- How much of the trip should be culture and how much should be water and mountains?
- Do you want to arrive and move on quickly, or start slowly?
- Is one island the main event, or are both?

The answers decide how the days are split between Tahiti and Moorea. If you would like to think it through together, I am glad to.

If this resonates, I would love to help you design that journey.`,
    faq: [
      { question: "Is it easy to visit both Tahiti and Moorea in one trip?", answer: "Yes. Moorea is reached from Tahiti by a passenger ferry of roughly 25 to 45 minutes, so both islands fit into one itinerary without a long transfer." },
      { question: "What is the difference between Tahiti and Moorea?", answer: "Tahiti is the largest island in the Society Islands and the main gateway, with Papeete, markets and museums. Moorea is much smaller, at about 133.5 square kilometers, and is known for its bays, mountain viewpoints and lagoon experiences." },
      { question: "Why use a travel advisor to plan Tahiti and Moorea?", answer: "Ground transfers, island timing and local access are easier to arrange with a destination operator who lives there. I work with Tahiti Adventures, a local and destination specialist tour operator, and I completed the Tahiti Specialist Program." },
    ],
    sources: [
      { title: 'Tahiti Tourisme: Moorea', url: 'https://tahititourisme.pf/en-pf/islands-and-archipelagos/the-society-islands/moorea' },
      { title: 'Tahiti Tourisme: Tahiti', url: 'https://tahititourisme.pf/en-pf/islands-and-archipelagos/the-society-islands/tahiti' },
    ],
    internalLinkSuggestions: [],
    keyTakeaways: [
      "Moorea is a 25 to 45 minute ferry ride from Tahiti, so the two islands fit one itinerary.",
      "Tahiti is the gateway and the culture stop. Moorea is where the bays, mountains and lagoon take over.",
      "A local destination operator is what makes the pairing feel planned rather than assembled.",
    ],
  },
```
