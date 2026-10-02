// Trips: where the creator is (or is about to be), so content can be written
// from the real trip and the library footage from that trip is preferred.
//
// Data lives in its own per-workspace file (trips.json) so a whole-state save
// from a stale browser tab can never wipe it. Every trip carries its source
// ('manual' | 'ics' | 'google') and the calendar's own event id (externalId),
// so a later automatic calendar sync updates the same trips instead of
// creating duplicates.

import crypto from 'node:crypto';

const uid = () => crypto.randomBytes(8).toString('hex');

const DAY = 86400000;
const isoDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const toMs = (s) => Date.parse(`${s}T00:00:00Z`);
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const clean = (s, n) => String(s || '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().slice(0, n);

export function todayISO(now = new Date(), tz = 'America/Chicago') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function normalizeTrip(t) {
  const name = clean(t?.name, 120);
  if (!name || !isoDay(t?.start)) return null;
  const end = isoDay(t.end) && toMs(t.end) >= toMs(t.start) ? t.end : t.start;
  const list = (v, n, len) => (Array.isArray(v) ? v : String(v || '').split(/[;\n]/)).map((x) => clean(x, len)).filter(Boolean).slice(0, n);
  return {
    id: String(t.id || uid()),
    name,
    start: t.start,
    end,
    places: list(t.places, 8, 80),
    travelers: list(t.travelers, 6, 40),
    notes: clean(t.notes, 400),
    // Off means the trip never reaches generation (private trips).
    useInContent: t.useInContent !== false,
    source: ['manual', 'ics', 'google'].includes(t.source) ? t.source : 'manual',
    externalId: t.externalId ? String(t.externalId).slice(0, 200) : undefined,
    createdAt: t.createdAt || new Date().toISOString(),
  };
}

export function tripStatus(trip, today = todayISO()) {
  if (today < trip.start) return 'upcoming';
  if (today > trip.end) return 'past';
  return 'active';
}

export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);

// Merge by externalId first (so a later sync updates in place), then id,
// then name + start. Hand-edited fields (places, notes, travelers, the
// useInContent switch) survive a re-import of the same calendar event.
export function upsertTrips(existing, incoming) {
  const out = [...existing];
  for (const raw of incoming) {
    const t = normalizeTrip(raw);
    if (!t) continue;
    const i = out.findIndex((e) => (t.externalId && e.externalId === t.externalId) || e.id === t.id || (e.name === t.name && e.start === t.start));
    if (i < 0) { out.push(t); continue; }
    const prev = out[i];
    out[i] = {
      ...prev, ...t, id: prev.id, createdAt: prev.createdAt,
      places: t.places.length ? t.places : prev.places,
      travelers: t.travelers.length ? t.travelers : prev.travelers,
      notes: t.notes || prev.notes,
      useInContent: raw.useInContent === undefined ? prev.useInContent : t.useInContent,
    };
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// The trip generation should lean on when the creator does not pick one:
// the active trip, else one that ended within a week (still being posted
// about), else one starting within three weeks.
export function pickTrip(trips, today = todayISO()) {
  const usable = trips.filter((t) => t.useInContent !== false);
  const active = usable.filter((t) => tripStatus(t, today) === 'active');
  if (active.length) return active.sort((a, b) => b.start.localeCompare(a.start))[0];
  const justBack = usable.filter((t) => tripStatus(t, today) === 'past' && daysBetween(t.end, today) <= 7);
  if (justBack.length) return justBack.sort((a, b) => b.end.localeCompare(a.end))[0];
  const soon = usable.filter((t) => tripStatus(t, today) === 'upcoming' && daysBetween(today, t.start) <= 21);
  return soon.sort((a, b) => a.start.localeCompare(b.start))[0] || null;
}

const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

// Context block for the system prompt. Facts only: name, dates, places.
export function tripContextBlock(trips, picked, today = todayISO()) {
  const usable = trips.filter((t) => t.useInContent !== false);
  if (!picked && !usable.length) return '';
  const lines = ['\n--- TRIP CONTEXT (real trips from the creator\'s calendar) ---'];
  lines.push(`Today is ${fmt(today)}, ${today.slice(0, 4)}.`);
  if (picked) {
    const st = tripStatus(picked, today);
    const where = picked.places.length ? picked.places.join('; ') : 'location not specified';
    const when = picked.start === picked.end ? fmt(picked.start) : `${fmt(picked.start)} to ${fmt(picked.end)}`;
    const tense = st === 'active' ? `The creator is on this trip RIGHT NOW (day ${daysBetween(picked.start, today) + 1} of ${daysBetween(picked.start, picked.end) + 1}). Write in the present tense about being there.`
      : st === 'upcoming' ? `This trip begins in ${daysBetween(today, picked.start)} day(s). Write about it as upcoming; do not describe it as already happening.`
      : `This trip ended ${daysBetween(picked.end, today)} day(s) ago. Write about it as just returned, in the past tense.`;
    lines.push(`FEATURED TRIP: "${picked.name}", ${when}. Places: ${where}.${picked.travelers.length ? ` Traveling with: ${picked.travelers.join(', ')}.` : ''}${picked.notes ? ` Notes: ${picked.notes}` : ''}`);
    lines.push(tense);
    lines.push('GEO RULES: name the specific place (city or region from the places above) naturally in the first line of the caption and in the alt text. For any "location_tag" field, give the place exactly as someone would search for it in the app (for example "Akumal, Quintana Roo, Mexico"), chosen from the places above. Never invent a hotel, restaurant or venue name, and never state a detail of the trip that is not given here or in the media descriptions.');
  }
  const others = usable.filter((t) => !picked || t.id !== picked.id)
    .filter((t) => tripStatus(t, today) === 'upcoming' && daysBetween(today, t.start) <= 120)
    .sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4);
  if (others.length) {
    lines.push(`Other upcoming trips (context only, do not feature unless the topic is about them): ${others.map((t) => `${t.name} (${fmt(t.start)}${t.places.length ? `, ${t.places[0]}` : ''})`).join('; ')}.`);
  }
  return lines.join('\n');
}

// Library items shot during the trip window (a day of slack either side for
// travel days), so footage from the trip is preferred over the whole library.
export function mediaInTrip(items, trip) {
  if (!trip) return [];
  const lo = toMs(trip.start) - DAY;
  const hi = toMs(trip.end) + 2 * DAY;
  return (items || []).filter((m) => {
    const t = m.takenAt ? Date.parse(m.takenAt) : NaN;
    return Number.isFinite(t) && t >= lo && t < hi;
  });
}

// ---- calendar export (.ics) import ---------------------------------------
// A Google Calendar export carries titles, dates, locations and ids but NOT
// event colors, so the importer proposes upcoming all-day (or multi-day)
// events and the creator ticks the ones that are trips.

const unescapeIcs = (s) => String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
const icsDate = (v) => {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export function parseIcs(text, { today = todayISO(), horizonDays = 730 } = {}) {
  const unfolded = String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const out = [];
  for (const blk of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = blk.split('END:VEVENT')[0];
    const f = {};
    let allDay = false;
    for (const line of body.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const head = line.slice(0, i);
      const key = head.split(';')[0];
      if (!['SUMMARY', 'LOCATION', 'DTSTART', 'DTEND', 'UID', 'STATUS', 'RRULE'].includes(key) || f[key] !== undefined) continue;
      f[key] = line.slice(i + 1);
      if (key === 'DTSTART' && /VALUE=DATE(?!-)/.test(head) && !/VALUE=DATE-TIME/.test(head)) allDay = true;
    }
    if (f.RRULE !== undefined || f.STATUS === 'CANCELLED') continue;
    const start = icsDate(f.DTSTART);
    if (!start) continue;
    let end = icsDate(f.DTEND) || start;
    // All-day DTEND is exclusive; a timed event ending at midnight is too.
    if (allDay || /T000000/.test(f.DTEND || '')) end = fromMs(Math.max(toMs(start), toMs(end) - DAY));
    if (end < today || daysBetween(today, start) > horizonDays) continue;
    const days = daysBetween(start, end) + 1;
    if (!allDay && days < 2) continue; // a timed one-day appointment is not a trip
    const name = clean(unescapeIcs(f.SUMMARY), 120);
    if (!name) continue;
    out.push({
      name, start, end, days,
      places: unescapeIcs(f.LOCATION) && !/^https?:/i.test(f.LOCATION) ? [clean(unescapeIcs(f.LOCATION), 80)] : [],
      externalId: f.UID ? String(f.UID).slice(0, 200) : undefined,
      source: 'ics',
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
