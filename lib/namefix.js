// Name correction for speech-to-text. Transcription engines misspell the
// creator's name ("Nikki Grotefend"), so every transcript and captions file
// passes through fixNames before it is saved or served. The rules live in
// config/name-corrections.json so a new misspelling is a one-line edit.
// Only the listed names are touched; no other word is ever changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = process.env.NAME_CORRECTIONS_FILE
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'name-corrections.json');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function load() {
  let rules = [];
  try { rules = JSON.parse(fs.readFileSync(FILE, 'utf8')).rules || []; } catch (err) {
    console.error(`namefix: could not read ${FILE}: ${err.message}`);
  }
  return rules.filter((r) => r && typeof r.correct === 'string' && r.correct.trim()).map((r) => {
    const sources = [
      ...(r.variants || []).map((v) => `\\b${escape(String(v).trim()).replace(/\s+/g, '\\s+')}\\b`),
      ...(r.patterns || []),
    ];
    const res = [];
    for (const s of sources) {
      try { res.push(new RegExp(s, 'gi')); } catch (err) { console.error(`namefix: bad pattern ${s}: ${err.message}`); }
    }
    return { correct: r.correct.trim(), keyterm: r.keyterm !== false, res };
  });
}

const RULES = load();

export function fixNames(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const r of RULES) for (const re of r.res) out = out.replace(re, r.correct);
  return out;
}

// Spellings to hand the transcription engine as hints.
export const nameKeyterms = () => RULES.filter((r) => r.keyterm).map((r) => r.correct);

// Word-timed output: a name usually arrives as two word items ("Nikki",
// "Grotefend"), possibly split across caption cues, so fix adjacent pairs at
// the word level before cues are built. Timing is kept as is.
export function fixWordNames(words) {
  const ws = (words || []).filter((w) => (!w.type || w.type === 'word') && String(w.text || '').trim());
  for (let i = 0; i < ws.length; i++) {
    const a = String(ws[i].text);
    const single = fixNames(a);
    if (single !== a) { ws[i].text = single; continue; }
    if (i + 1 >= ws.length) continue;
    const b = String(ws[i + 1].text);
    const joined = `${a.trim()} ${b.trim()}`;
    const fixed = fixNames(joined);
    if (fixed === joined) continue;
    const parts = fixed.split(' ');
    if (parts.length === 2) { ws[i].text = parts[0]; ws[i + 1].text = parts[1]; i++; }
  }
  return words;
}

// SRT text: cue numbers and timings never match a name, so the whole file
// can pass through as is.
export const fixSrt = (srt) => fixNames(String(srt || ''));
