// One-click demo profile so the studio can be explored before onboarding.
// Generic luxury-travel creator — replace by running the real interview.

export const DEMO_STATE = {
  profile: {
    business: {
      name: 'Harbor & Compass Travel',
      tagline: 'Expedition and luxury cruise travel, planned by someone who has actually been there.',
      industry: 'Travel',
      niche: 'Expedition cruising & luxury small-ship travel',
      audience: 'Affluent 45-70 travelers who want once-in-a-lifetime trips without the planning risk',
      location: 'St. Louis, Missouri',
      offers: 'Complimentary itinerary design, supplier-protected pricing, 24/7 travel support',
      localBusiness: true,
      person: {
        name: 'Jordan Avery',
        title: 'Founder & Expedition Travel Advisor',
        credentials: '14 years planning travel; sailed 31 itineraries across 6 continents including Antarctica twice',
        sameAs: ['https://www.linkedin.com/in/example', 'https://www.youtube.com/@example'],
      },
      links: {
        website: 'https://example.com',
        youtube: 'https://www.youtube.com/@example',
        instagram: 'https://www.instagram.com/example',
        gbp: 'https://maps.google.com/?cid=example',
      },
    },
    interview: {
      answers: {},
      completedAt: new Date('2026-01-05').toISOString(),
      brief: {
        positioning: 'The advisor who has stood on the deck before you book the cabin.',
        coreStory: 'Jordan left a corporate career after a single Drake Passage crossing rearranged their priorities. Now they scout expedition ships in person so clients spend money on the right trip the first time. Every piece of content ladders back to one idea: lived experience beats brochure promises.',
        audienceTruth: 'They can afford any trip; what they cannot buy back is a wasted trip. They fear choosing wrong more than spending more.',
        proofAssets: ['31 itineraries sailed personally', 'Two Antarctica expeditions', 'Supplier relationships with 9 luxury lines'],
        storyThemes: ['Brochure vs reality', 'What the crew knows', 'The cost of choosing wrong', 'Small-ship intimacy', 'Bucket-list biology'],
        contentGoals: ['Be the cited answer when AI is asked about expedition cruising', 'Book 2 consult calls per week from content'],
        differentiators: ['First-person ship reviews with real numbers', 'Will tell you which trip NOT to take'],
      },
    },
    voiceDna: {
      sources: [{ name: 'demo-voice.md', chars: 1200, addedAt: new Date('2026-01-05').toISOString() }],
      corpus: [],
      summary: {
        voiceSummary: 'Warm, direct, quietly authoritative. Talks like a well-traveled friend who refuses to oversell.',
        tone: ['candid', 'warm', 'specific', 'wry', 'reassuring'],
        rhythm: 'Short declarative sentences punctuated by one long sensory sentence per paragraph.',
        signaturePhrases: ["Here's what the brochure won't tell you", 'I checked so you don\'t have to', 'Worth every penny — or not'],
        vocabulary: ['zodiac', 'expedition leader', 'sea day', 'cabin category', 'shoulder season'],
        stance: 'A scout reporting back, never a salesperson.',
        neverDo: ['hype words', 'exclamation stacking', 'pressure tactics'],
        sampleParagraph: 'The gym on deck five is fine. Skip it. What you want is the aft deck at 6 a.m., coffee in hand, when the fjord goes pink and the engines cut. That moment is why this ship costs what it costs — and why I keep sending people there.',
      },
    },
    pillars: [
      { id: 'p1', name: 'Ship Truths', pct: 35, description: 'First-person ship and itinerary reviews with real numbers — the brochure-vs-reality pillar.' },
      { id: 'p2', name: 'Ask an Advisor', pct: 35, description: 'Direct answers to the exact questions travelers ask AI assistants about expedition travel.' },
      { id: 'p3', name: 'The Long Way Here', pct: 15, description: 'Origin story, values, and the moments that made this a calling.' },
      { id: 'p4', name: 'Proof & Postcards', pct: 15, description: 'Client wins, trip reports, and one clear next step.' },
    ],
    series: [
      { id: 's1', name: 'Sunday Ship Review', pillarId: 'p1', format: 'YouTube long form + Shorts cutdowns', cadence: 'weekly' },
      { id: 's2', name: '60-Second Verdict', pillarId: 'p2', format: 'One question, one direct answer, all short-video platforms', cadence: '3x week' },
      { id: 's3', name: 'Postcards from Clients', pillarId: 'p4', format: 'Carousel + GBP post', cadence: 'weekly' },
    ],
  },
  settings: { demo: true },
};
