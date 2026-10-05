// Acceptance tests for Module 1 (voice card) and Module 5 (fact gate).
// Run: node tests/voice-facts.test.js
import assert from 'node:assert/strict';
import { getVoiceCard, scanText } from '../lib/voice.js';
import { getKnowledgeBase, classifyClaim, gateText } from '../lib/facts.js';

const profile = {
  business: { name: 'Travel GHR', neverMention: ['Expedia', 'budget'], location: 'Edwardsville, Illinois',
    person: { name: 'Nicci Grotefendt', credentials: 'More than 15 years in hotels, front desk to general manager. CLIA certified.' } },
  knowledgeBase: [
    { id: 'k1', claim: 'The retreat runs February 8 to 12, 2027 in Akumal and Tulum.', status: 'verified', source: 'signed venue contract', date: '2026-09-01' },
    { id: 'k2', claim: 'There are 50 advisor seats this round.', status: 'owner_statement', source: 'owner, chat', date: '2026-10-02' },
    { id: 'k3', claim: 'The deposit is $1,000 and non-refundable.', status: 'verified', source: 'application terms', date: '2026-09-01' },
    { id: 'k4', claim: 'The retreat was featured in Forbes.', status: 'unverified', source: 'not confirmed', date: null },
  ],
};
const card = getVoiceCard(profile);

const off = [
  'This retreat is a game-changer for advisors.', 'Let us dive into the details of Tulum.', 'Our stunning villa awaits you.',
  'Hidden gem alert: Akumal.', 'A bucket list trip for every advisor.', 'It’s not just a retreat, but a movement.',
  "It's not about selling trips, it's about connection.", 'Drop a 🔥 in the comments below if you agree.', 'Moreover, the villa has a pool.',
  'Furthermore, meals are included.', 'Unlock your potential in Mexico.', 'The retreat — held in Akumal — is open.',
  'Dates: Feb 8 – 12.', 'Book with Expedia for the flights.', 'Keep it under budget for the group.', 'Ever wondered what a conscious creator does?',
  'A trip of a lifetime awaits.', 'Wanderlust meets purpose.', 'Tag someone who needs this retreat.', 'This seamless experience will elevate your business.',
];
const on = [
  'I spent fifteen years behind a hotel front desk before I started advising.', "I'm building the retreat around real relationships with local partners.",
  'We eat dinner together every night in the villa.', 'My first week in Akumal taught me to slow down.', 'The morning session starts with coffee on the terrace.',
  "Here's what I learned from running events in Orlando.", 'Advisors leave with a plan for their own content.', 'The villa sits ten minutes from the beach.',
  "I wrote this guide after a long day of site visits.", 'Each seat includes private transportation.', 'Ask me anything about the application.',
  'The group is small on purpose.', "I'll share the full itinerary after acceptance.", 'Tulum has a quiet side most visitors miss.',
  'My clients tell me the planning is the hard part.', 'We start with a conversation, not a sales call.', 'The chef cooks local dishes each night.',
  'You will meet the two educators on day one.', "I kept notes on every site visit, and I'm happy to share them.", 'Applications are open now.',
];
off.forEach((t) => assert.ok(scanText(card, t).length > 0, `off-voice passed: ${t}`));
on.forEach((t) => assert.deepEqual(scanText(card, t), [], `on-voice rejected: ${t} ${JSON.stringify(scanText(card, t))}`));

// Cards do not leak across entities.
const other = getVoiceCard({ business: { neverMention: ['Marriott'] } });
assert.ok(scanText(other, 'Book with Expedia.').length === 0, 'blocklist leaked across entities');
assert.ok(scanText(card, 'Book with Expedia.').length > 0);

// Fact gate: 10 verified, 10 owner statements, 10 fabricated.
const kb = getKnowledgeBase(profile);
const verified = [
  'The retreat runs February 8 to 12, 2027 in Akumal and Tulum.', 'The retreat dates are February 8 to 12, 2027.', 'The retreat takes place in Akumal and Tulum in 2027.',
  'The deposit is $1,000 and non-refundable.', 'A $1,000 deposit is non-refundable.', 'The $1,000 deposit is non-refundable.',
  'The retreat runs February 8 to 12, 2027.', 'Your deposit of $1,000 is non-refundable.', 'The retreat is in Akumal and Tulum, 2027.', 'Deposit: $1,000, non-refundable.',
];
const owner = [
  'There are 50 advisor seats this round.', 'We have 50 advisor seats this round.', 'This round offers 50 advisor seats.', '50 advisor seats are open this round.',
  'Only 50 advisor seats this round.', 'I have 50 advisor seats this round.', 'The round includes 50 advisor seats.', 'There are 50 advisor seats available this round.',
  'This round has 50 advisor seats.', 'Advisor seats this round total 50.',
];
const fake = [
  'The retreat was featured in Forbes.', 'We have hosted 400 advisors since 2019.', 'The deposit is $5,000 and fully refundable.', 'Tulum was ranked the number one destination in 2026.',
  'There are 200 advisor seats this round.', 'Nicci is an award-winning advisor.', 'The retreat is the only one of its kind in Mexico.', '98% of past attendees rebook.',
  'The retreat runs March 3 to 9, 2028 in Cancun.', 'Our partners include a leading five star resort group.',
];
verified.forEach((c) => assert.equal(classifyClaim(c, kb).status, 'verified', `not verified: ${c}`));
owner.forEach((c) => assert.equal(classifyClaim(c, kb).status, 'owner_statement', `not owner_statement: ${c}`));
fake.forEach((c) => assert.equal(classifyClaim(c, kb).status, 'unverified', `fabricated claim passed: ${c}`));

// Every decision carries status and source; blocked list is exactly the unverified.
const g = gateText('I have 50 advisor seats this round. We hosted 400 advisors since 2019.', kb, { platformId: 'linkedin' });
assert.equal(g.decisions.length, 2);
assert.ok(g.decisions.every((d) => d.status && 'source' in d));
assert.equal(g.blocked.length, 1);
console.log('voice + fact gate: all assertions passed');
