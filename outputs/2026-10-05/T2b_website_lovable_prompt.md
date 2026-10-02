# Lovable prompt: add the second Tahiti journal article to travelghr.com

Paste into the Lovable editor for the Travel GHR Website project (f3ebf3fa-86a9-40d8-a2c7-074c248c21bb) with the licensed image `AdobeStock_310089200.jpg` (Tahiti waterfall) attached. Do not send through the API. Run it only after the first Tahiti article prompt has been applied. Publish Thu Oct 8, after the LinkedIn article is live.

---

Add one new journal article to `src/data/insights.ts` and nothing else in the content. Rules:

1. Append the entry below to the `insights` array, after the existing entries (including the Tahiti and Moorea article). Do not edit, reorder or remove any existing article. Do not change `src/data/author.ts`.
2. Save the attached image as `public/insights-images/journal/tahiti-waterfall-hero.jpg`.
3. Route `/journal/is-tahiti-worth-visiting-on-its-own`, same layout, breadcrumbs, `canonicalPath` handling and JSON-LD generation as the existing journal articles.
4. Add the URL to `public/sitemap.xml`, `public/rss.xml` and the journal list in `public/llms.txt`, as the existing articles appear.
5. Confirm the new route is prerendered with its full text and JSON-LD in the server HTML and appears in the prerender manifest.
6. Copy the text verbatim. Do not rewrite, add facts or prices, or use any em dash or en dash.
7. Reply with the commit and the files changed.

```ts
  {
    slug: 'is-tahiti-worth-visiting-on-its-own',
    canonicalPath: '/journal/is-tahiti-worth-visiting-on-its-own',
    headline: 'Is Tahiti Worth Visiting on Its Own?',
    metaDescription:
      'Yes. Tahiti is the largest of the Society Islands, with a central market, waterfalls and black sand beaches. Nicci Grotefendt of Travel GHR on how to plan it.',
    primaryKeyword: 'is Tahiti worth visiting',
    secondaryKeywords: ['things to do in Tahiti', 'Tahiti and Bora Bora', 'Papeete market', 'French Polynesia travel advisor', 'Tahiti Specialist Program'],
    contentPillar: 'Destination',
    targetQueryCategory: 'Destination',
    publishedISO: '2026-10-07',
    modifiedISO: '2026-10-07',
    readingMinutes: 5,
    heroImage: '/insights-images/journal/tahiti-waterfall-hero.jpg',
    heroImageAlt: 'Waterfall over volcanic rock into a tranquil pond in Tahiti, French Polynesia',
    featuredSnippetTarget:
      'Tahiti is worth visiting on its own. It is the largest island in the Society Islands, about 1,042 square kilometers, and it is home to Papeete, the capital and administrative center. It offers a central market, local food trucks, waterfalls, black sand beaches and the Teahupo\'o surf break, so the island holds its own as a destination.',
    bodyMarkdown: `**Yes, Tahiti is worth visiting on its own, because it is the largest island in the Society Islands and holds the capital, the main market, waterfalls, black sand beaches and the Teahupo'o surf break.** Tahiti Tourisme counts about 1,042 square kilometers and roughly 192,000 residents on the island, which is why a stay here feels like a destination and not a doorway.

I am Nicci Grotefendt, founder of Travel GHR in Edwardsville, Illinois, and a graduate of the Tahiti Specialist Program. This fall I am heading to French Polynesia to personally vet it, and this is one of the first questions I want to answer well.

## Is Tahiti worth visiting on its own?

Tahiti is worth visiting on its own. It is the largest island in the Society Islands, about 1,042 square kilometers, and it is home to Papeete, the capital and administrative center. It offers a central market, local food trucks, waterfalls, black sand beaches and the Teahupo'o surf break, so the island holds its own as a destination.

## Why do so many itineraries start on Tahiti?

Tahiti is the main entry point to the Islands of Tahiti, with the international airport, so most journeys touch it first. Tahiti Tourisme describes the Society Islands as eight islands in two groups, the Windward and Leeward Islands. Tahiti and Moorea are Windward Islands. Bora Bora is a Leeward Island. The real question is not whether Tahiti is worth a visit, but how long it deserves.

## What is there to do on Tahiti itself?

Tahiti Tourisme highlights several things:
- **Papeete and its market.** The Papeete Market sits in the middle of town. The ground floor sells fruit, vegetables, fish and flower garlands. The upper floor sells handwoven baskets, hats and mats, carvings, pareos and Tahitian cultured pearls. Tahiti Tourisme notes that Sunday mornings are particularly lively and that early morning is the best time to go.
- **Local food.** Food trucks and local dining around Place Vaiete.
- **Culture.** The gardens of the Museum of Tahiti and Its Islands.
- **Landscape.** Waterfalls such as those in the Fara'ura valley, the Arahoho blowhole, black sand beaches and mountains to hike.
- **The wilder side.** The Tahiti Iti peninsula, known for the Teahupo'o surf break.

## How does Tahiti fit with the other islands?

Tahiti pairs easily with its neighbors. Moorea is a 25 to 45 minute ferry ride away. Bora Bora, with about 24 square kilometers and roughly 10,605 residents, is a 50 minute flight from Tahiti according to Tahiti Tourisme, which describes its lagoon as having "50 shades of blue." Each island offers something different, and Tahiti is the one that connects them all.

## Who is Tahiti right for?

Tahiti suits travelers who want a sense of place: markets, local food, landscape and culture, in addition to lagoon time. How many nights to give it, and which islands to pair it with, depends on what you want from the trip. That is the part I plan personally with each client.

## Why does a destination operator matter on Tahiti?

An island this varied has details that live on the ground: the right guide, transfers timed to arrivals, local knowledge that does not show up in a brochure. That is why I build Tahiti with a destination operator. I work with Tahiti Adventures, a local and destination specialist tour operator that helps with lodging, transfers, and activities.

My approach is the Travel GHR promise: **Privately Curated. Personally Yours.**

If this resonates, I would love to help you design that journey.`,
    faq: [
      { question: "Is Tahiti worth visiting or should I go straight to another island?", answer: "Tahiti is worth a stay of its own. It is the largest of the Society Islands, with Papeete, a central market, waterfalls, black sand beaches and the Tahiti Iti peninsula. Other islands, such as Bora Bora, are a short flight away, so you do not have to choose one over the other." },
      { question: "How far is Bora Bora from Tahiti?", answer: "Tahiti Tourisme lists Bora Bora as a 50 minute flight from Tahiti." },
      { question: "Why use a travel advisor to plan Tahiti?", answer: "Island timing, transfers and local access are easier to arrange with a destination operator. I work with Tahiti Adventures, a local and destination specialist tour operator, and I completed the Tahiti Specialist Program." },
    ],
    sources: [
      { title: 'Tahiti Tourisme: Tahiti', url: 'https://tahititourisme.pf/en-pf/islands-and-archipelagos/the-society-islands/tahiti' },
      { title: 'Tahiti Tourisme: The Society Islands', url: 'https://tahititourisme.pf/en-pf/islands-and-archipelagos/the-society-islands' },
      { title: 'Tahiti Tourisme: Bora Bora', url: 'https://tahititourisme.pf/en-pf/islands-and-archipelagos/the-society-islands/bora-bora' },
      { title: 'Tahiti Tourisme: Papeete Market', url: 'https://www.tahititourisme.com/a-visit-to-papeete-market/' },
    ],
    internalLinkSuggestions: [
      { label: 'How to Combine Tahiti and Moorea in One Trip', slug: 'how-to-combine-tahiti-and-moorea-in-one-trip' },
    ],
    keyTakeaways: [
      "Tahiti is the largest of the eight Society Islands and the main entry point, with the international airport.",
      "On the island itself: Papeete and its market, food trucks, a museum garden, waterfalls, black sand beaches and the Tahiti Iti peninsula.",
      "Bora Bora is a 50 minute flight from Tahiti, so the two are easy to combine without choosing one over the other.",
    ],
  },
```
