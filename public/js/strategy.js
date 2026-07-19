import { api, appState } from './api.js';
import { el, field, textInput, textArea, toast, spinner, download } from './ui.js';

const uid = () => Math.random().toString(36).slice(2, 10);

const DAY_PATTERNS = [
  /\bmon(?:day)?\b/, /\btue(?:s|sday)?\b/, /\bwed(?:s|nesday)?\b/,
  /\bthu(?:r|rs|rsday)?\b/, /\bfri(?:day)?\b/, /\bsat(?:urday)?\b/, /\bsun(?:day)?\b/,
];

export function explicitDays(cadence = '') {
  const c = cadence.toLowerCase();
  return DAY_PATTERNS.reduce((days, re, i) => (re.test(c) ? [...days, i] : days), []);
}

export function timesPerWeek(cadence = '') {
  const c = cadence.toLowerCase();
  if (c.includes('daily') || c.includes('every day')) return 7;
  const m = c.match(/(\d+)\s*(?:x|times?)/);
  if (m) return Math.min(7, +m[1]);
  if (c.includes('twice')) return 2;
  if (c.includes('three times')) return 3;
  const days = explicitDays(c);
  if (days.length) return days.length;
  if (c.includes('month')) return 0.25;
  return 1;
}

export function renderStrategy(root) {
  const container = el('div', { class: 'view' });
  const profile = appState.state.profile;
  profile.pillars = profile.pillars || [];
  profile.series = profile.series || [];

  const save = async () => { await appState.save(); };

  const render = () => {
    container.replaceChildren(
      el('div', { class: 'view-head' },
        el('div', {},
          el('h1', {}, 'Pillars & Series'),
          el('p', { class: 'sub' }, 'The architecture: 4-5 pillars weighted for AI visibility, expressed as recurring story series people (and algorithms) learn to expect.')),
        el('button', {
          class: 'btn btn-primary', onclick: async (e) => {
            const btn = e.target;
            btn.replaceWith(spinner('Designing your architecture…'));
            try {
              const result = await api.suggestPillars();
              profile.pillars = (result.pillars || []).map((p) => ({ id: uid(), ...p }));
              profile.series = (result.series || []).map((s) => ({
                id: uid(), name: s.name, format: s.format, cadence: s.cadence,
                episodeIdeas: s.episodeIdeas || [],
                pillarId: profile.pillars.find((p) => p.name === s.pillar)?.id || profile.pillars[0]?.id || null,
              }));
              await save();
              toast('Architecture designed');
            } catch (err) { toast(err.message, 'err'); }
            render();
          },
        }, '✦ Design my architecture')),
    );

    const pillarRow = (p) => el('div', { class: 'pillar-row' },
      el('div', { class: 'pillar-bar', style: `--pct:${p.pct || 0}%` }),
      el('div', { class: 'pillar-fields' },
        textInput({ value: p.name, oninput: (e) => { p.name = e.target.value; }, onchange: save }),
        textInput({ value: String(p.pct || 0), class: 'input pct-input', oninput: (e) => { p.pct = +e.target.value || 0; }, onchange: () => { save(); render(); } }),
        el('button', {
          class: 'btn btn-danger btn-xs', onclick: async () => {
            profile.pillars = profile.pillars.filter((x) => x.id !== p.id);
            await save(); render();
          },
        }, '×')),
      textArea({ value: p.description || '', rows: 2, placeholder: 'What this pillar proves', oninput: (e) => { p.description = e.target.value; }, onchange: save }),
      p.exampleTopics?.length ? el('div', { class: 'chip-row' }, p.exampleTopics.map((t) => el('span', { class: 'chip' }, t))) : null);

    const pillarWrap = el('div', { class: 'card' },
      el('h2', {}, 'Content pillars'),
      profile.pillars.length
        ? profile.pillars.map((p) => pillarRow(p))
        : el('p', { class: 'intro' }, 'No pillars yet. Use “Design my architecture” (after the Interview) or add one manually.'),
      el('button', {
        class: 'btn btn-ghost btn-xs', onclick: async () => {
          profile.pillars.push({ id: uid(), name: 'New pillar', pct: 10, description: '' });
          await save(); render();
        },
      }, '+ Add pillar'));

    container.append(pillarWrap);

    const seriesWrap = el('div', { class: 'card' },
      el('h2', {}, 'Story series'),
      el('p', { class: 'intro' }, 'Named, recurring formats train audiences and algorithms alike. Consistent naming (“Sunday Ship Review, Ep. 12”) builds episodic pull and entity recognition.'),
      profile.series.map((s) => el('div', { class: 'series-row' },
        el('div', { class: 'series-fields' },
          textInput({ value: s.name, oninput: (e) => { s.name = e.target.value; }, onchange: save }),
          el('select', {
            class: 'input select',
            onchange: (e) => { s.pillarId = e.target.value; save(); },
          }, profile.pillars.map((p) => {
            const opt = el('option', { value: p.id }, p.name);
            if (p.id === s.pillarId) opt.selected = true;
            return opt;
          })),
          textInput({ value: s.cadence || '', placeholder: '3x week · daily · Mon/Wed/Fri', class: 'input cadence-input', oninput: (e) => { s.cadence = e.target.value; }, onchange: save }),
          el('button', {
            class: 'btn btn-danger btn-xs', onclick: async () => {
              profile.series = profile.series.filter((x) => x.id !== s.id);
              await save(); render();
            },
          }, '×')),
        textInput({ value: s.format || '', placeholder: 'format (e.g. YouTube long form → Shorts cutdowns)', oninput: (e) => { s.format = e.target.value; }, onchange: save }),
        s.episodeIdeas?.length ? el('ul', { class: 'plain-list' }, s.episodeIdeas.map((i) => el('li', {}, `💡 ${i}`))) : null)),
      el('button', {
        class: 'btn btn-ghost btn-xs', onclick: async () => {
          profile.series.push({ id: uid(), name: 'New series', pillarId: profile.pillars[0]?.id || null, format: '', cadence: 'weekly' });
          await save(); render();
        },
      }, '+ Add series'));

    container.append(seriesWrap, weekPlan(profile));
  };

  render();
  root.replaceChildren(container);
}

function weekPlan(profile) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const slots = days.map((d) => ({ day: d, entries: [] }));
  const sorted = [...profile.series].sort((a, b) => timesPerWeek(b.cadence) - timesPerWeek(a.cadence));
  let cursor = 0;
  for (const s of sorted) {
    const named = explicitDays(s.cadence);
    if (named.length) {
      for (const d of named) slots[d].entries.push(s.name);
      continue;
    }
    const n = timesPerWeek(s.cadence);
    if (n < 1) { slots[0].entries.push(`${s.name} (monthly)`); continue; }
    if (n >= 7) { for (const slot of slots) slot.entries.push(s.name); continue; }
    const count = Math.round(n);
    const stride = 7 / count;
    for (let i = 0; i < count; i++) {
      slots[Math.floor(i * stride + cursor) % 7].entries.push(s.name);
    }
    cursor = (cursor + 1) % 7;
  }

  const ics = () => {
    const start = new Date();
    start.setDate(start.getDate() + ((8 - start.getDay()) % 7 || 7));
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ContentStudio//EN'];
    slots.forEach((slot, i) => slot.entries.forEach((entry, k) => {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:cs-${ymd}-${k}@contentstudio`, `DTSTART;VALUE=DATE:${ymd}`,
        `SUMMARY:📣 ${entry}`, 'END:VEVENT');
    }));
    lines.push('END:VCALENDAR');
    download('contentstudio-week.ics', lines.join('\r\n'), 'text/calendar');
  };

  return el('div', { class: 'card' },
    el('div', { class: 'row spread' },
      el('h2', {}, 'Publishing rhythm'),
      el('button', { class: 'btn btn-ghost btn-xs', onclick: ics }, '⬇ Add week to calendar (.ics)')),
    el('div', { class: 'week-grid' },
      slots.map((s) => el('div', { class: 'day-cell' },
        el('strong', {}, s.day.slice(0, 3)),
        s.entries.length ? s.entries.map((e) => el('span', { class: 'day-entry' }, e)) : el('span', { class: 'muted' }, '—')))));
}
