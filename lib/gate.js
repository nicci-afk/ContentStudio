// Combines Module 1 (voice card) and Module 5 (fact gate) into one verdict
// per platform asset. Deterministic and token-free; the only model cost is
// the single retry, which generation pays when an asset fails.

import { getVoiceCard, scanFields, formatViolations } from './voice.js';
import { getKnowledgeBase, gateFields, formatBlocked } from './facts.js';

// Fields that carry production direction or tags, not claims about the world.
const NO_FACT_CHECK = new Set(['production_notes', 'todo', 'hashtags', 'audio_note', 'thumbnail_text', 'alt_text', 'chapters']);

export function checkAsset(platformId, fields, profile) {
  const card = getVoiceCard(profile);
  const voiceAll = scanFields(card, fields);
  const voice = voiceAll.filter((v) => v.rule !== 'style'); // style is advisory
  const style = voiceAll.filter((v) => v.rule === 'style');
  const factFields = Object.fromEntries(Object.entries(fields || {}).filter(([k]) => !NO_FACT_CHECK.has(k)));
  const facts = gateFields(factFields, getKnowledgeBase(profile), platformId);
  return {
    status: voice.length || facts.blocked.length ? 'blocked' : 'passed',
    checkedAt: new Date().toISOString(),
    voice, style,
    // Every decision is logged with its status and source.
    decisions: facts.decisions.map(({ field, claim, status, source, entryId }) => ({ field, claim: claim.slice(0, 200), status, source, entryId })),
    blocked: facts.blocked.map((d) => ({ field: d.field, claim: d.claim.slice(0, 200) })),
    retried: false,
  };
}

export const retryNote = (gate, fields) => {
  const parts = [];
  if (gate.voice.length) parts.push(`VOICE VIOLATIONS (rewrite without them):\n${formatViolations(gate.voice)}`);
  if (gate.blocked.length) parts.push(`UNVERIFIED CLAIMS (remove them, or restate using only facts in your context; never invent a number, date, credential, or superlative, and use a [FILL: ...] placeholder where a fact is missing):\n${formatBlocked(gate.blocked)}`);
  return `\n\nYOUR PREVIOUS DRAFT WAS REJECTED BY THE QUALITY GATE. Fix every item below and return the full JSON again.\n${parts.join('\n\n')}`;
};

// Generate, check, retry once with the violations cited. A second failure is
// returned as blocked so the owner sees it, never shipped as clean.
export async function generateGated({ platformId, profile, produce }) {
  let fields = await produce('');
  let gate = checkAsset(platformId, fields, profile);
  if (gate.status === 'blocked') {
    const note = retryNote(gate, fields);
    try {
      const second = await produce(note);
      const g2 = checkAsset(platformId, second, profile);
      g2.retried = true;
      fields = second; gate = g2;
    } catch { gate.retried = true; }
  }
  return { fields, gate };
}
