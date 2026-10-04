import { api } from './api.js';
import { el, field, textInput, textArea, toast, spinner, emptyState, readFileAsText } from './ui.js';

const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const span = (t) => (t.start === t.end ? fmt(t.start) : `${fmt(t.start)} to ${fmt(t.end)}`);
const STATUS = { active: 'On this trip now', upcoming: 'Upcoming', past: 'Past' };

export async function renderTrips(root) {
  const view = el('div', { class: 'view' });
  root.replaceChildren(view);
  let data = { items: [], autoPickId: null, today: '' };
  let editing = null; // trip id, 'new', or null
  let candidates = null;

  const load = async () => {
    try { data = await api.trips(); } catch (err) { toast(err.message, 'err'); }
    draw();
  };

  const tripForm = (t) => {
    const f = {
      name: textInput({ value: t.name || '', placeholder: 'e.g. Tahiti FAM' }),
      start: textInput({ type: 'date', value: t.start || '' }),
      end: textInput({ type: 'date', value: t.end || '' }),
      places: textInput({ value: (t.places || []).join('; '), placeholder: 'e.g. Tahiti, French Polynesia; Moorea, French Polynesia' }),
      travelers: textInput({ value: (t.travelers || []).join(', '), placeholder: 'optional, e.g. Nicci, Tim' }),
      notes: textArea({ rows: 2, value: t.notes || '', placeholder: 'optional facts the content may use' }),
    };
    const use = el('input', { type: 'checkbox' });
    use.checked = t.useInContent !== false;
    return el('div', { class: 'card' },
      el('h3', {}, t.id ? 'Edit trip' : 'Add a trip'),
      field('Trip name', f.name),
      el('div', { class: 'row gap wrap' }, field('First day', f.start), field('Last day', f.end)),
      field('Places', f.places, 'Separate with semicolons. These become the location tags and place names in the copy.'),
      field('Traveling with (optional)', f.travelers),
      field('Notes (optional)', f.notes),
      el('label', { class: 'row gap', style: 'align-items:center;margin:8px 0' }, use, el('span', {}, 'Use this trip when writing content (turn off for a private trip)')),
      el('div', { class: 'row gap' },
        el('button', { class: 'btn btn-primary', onclick: async () => {
          const body = {
            name: f.name.value, start: f.start.value, end: f.end.value || f.start.value,
            places: f.places.value, travelers: f.travelers.value, notes: f.notes.value, useInContent: use.checked,
          };
          if (!body.name.trim() || !body.start) return toast('A trip needs a name and a first day', 'err');
          try {
            if (t.id) await api.updateTrip(t.id, body); else await api.upsertTrips([{ ...body, source: 'manual' }]);
            editing = null; toast('Trip saved'); await load();
          } catch (err) { toast(err.message, 'err'); }
        } }, 'Save trip'),
        el('button', { class: 'btn btn-ghost', onclick: () => { editing = null; draw(); } }, 'Cancel')));
  };

  const importCard = () => {
    const input = el('input', { type: 'file', accept: '.ics,text/calendar', style: 'display:none' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      candidates = 'loading'; draw();
      try {
        const text = await readFileAsText(file);
        const { candidates: list } = await api.parseTripsIcs(text);
        candidates = list.map((c) => ({ ...c, pick: false, placesText: c.places.join('; ') }));
        if (!candidates.length) toast('No upcoming all-day or multi-day events found in that file');
      } catch (err) { candidates = null; toast(err.message, 'err'); }
      draw();
    });
    return el('div', { class: 'card' },
      el('h3', {}, 'Add trips from a calendar export'),
      el('p', { class: 'muted' }, 'In Google Calendar, open Settings, Import & export, Export, and upload the .ics file here. Calendar exports do not include event colors, so you tick the events that are trips. Each trip remembers its calendar event, so a later sync can update it instead of duplicating it.'),
      input,
      el('button', { class: 'btn btn-ghost', onclick: () => input.click() }, 'Choose calendar file (.ics)'));
  };

  const candidateList = () => {
    if (candidates === 'loading') return el('div', { class: 'card' }, spinner('Reading your calendar…'));
    if (!candidates?.length) return null;
    const rows = candidates.map((c) => {
      const box = el('input', { type: 'checkbox', onchange: () => { c.pick = box.checked; } });
      box.checked = c.pick; box.disabled = c.exists;
      const place = textInput({ value: c.placesText, placeholder: 'place (city, region, country)', oninput: (e) => { c.placesText = e.target.value; } });
      return el('div', { class: 'row gap wrap', style: 'align-items:center;padding:6px 0;border-bottom:1px solid var(--border, #ddd)' },
        box,
        el('div', { style: 'min-width:220px;flex:1' }, el('strong', {}, c.name), el('div', { class: 'muted' }, `${span(c)} · ${c.days} day${c.days === 1 ? '' : 's'}${c.exists ? ' · already added' : ''}`)),
        el('div', { style: 'min-width:240px;flex:1' }, place));
    });
    return el('div', { class: 'card' },
      el('h3', {}, `${candidates.length} upcoming events`),
      el('p', { class: 'muted' }, 'Tick the events that are trips and check the place for each. Leave a place blank if you are not sure; it is never guessed.'),
      ...rows,
      el('div', { class: 'row gap', style: 'margin-top:10px' },
        el('button', { class: 'btn btn-primary', onclick: async () => {
          const picked = candidates.filter((c) => c.pick && !c.exists);
          if (!picked.length) return toast('Tick at least one event', 'err');
          try {
            await api.upsertTrips(picked.map((c) => ({ name: c.name, start: c.start, end: c.end, places: c.placesText, externalId: c.externalId, source: 'ics' })));
            candidates = null; toast(`${picked.length} trip${picked.length === 1 ? '' : 's'} added`); await load();
          } catch (err) { toast(err.message, 'err'); }
        } }, 'Add ticked trips'),
        el('button', { class: 'btn btn-ghost', onclick: () => { candidates = null; draw(); } }, 'Close')));
  };

  function tripRow(t) {
    return el('div', { class: 'card', style: 'margin-bottom:10px' },
      el('div', { class: 'row spread' },
        el('div', {},
          el('strong', {}, t.name),
          el('div', { class: 'muted' }, `${span(t)}${t.places.length ? ` · ${t.places.join(' · ')}` : ' · no place yet'}`),
          el('div', { class: 'muted', style: 'font-size:12px' },
            `${STATUS[t.status]}${data.autoPickId === t.id ? ' · used automatically for new content' : ''}${t.useInContent === false ? ' · private (not used in content)' : ''}${t.source !== 'manual' ? ` · from ${t.source === 'ics' ? 'a calendar export' : t.source}` : ''}`)),
        el('div', { class: 'row gap' },
          el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { editing = t.id; draw(); } }, 'Edit'),
          el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => {
            if (!confirm(`Remove "${t.name}"?`)) return;
            try { await api.deleteTrip(t.id); await load(); } catch (err) { toast(err.message, 'err'); }
          } }, 'Remove'))));
  }

  function draw() {
    const upcoming = data.items.filter((t) => t.status !== 'past');
    const past = data.items.filter((t) => t.status === 'past');
    view.replaceChildren(...[
      el('div', { class: 'view-head' },
        el('div', {},
          el('h1', {}, 'Trips'),
          el('p', { class: 'sub' }, 'Where you are and where you are going, so posts are written from the real trip and footage from it is picked first.')),
        el('button', { class: 'btn btn-primary', onclick: () => { editing = 'new'; draw(); } }, '+ Add a trip')),
      editing === 'new' ? tripForm({}) : null,
      editing && editing !== 'new' ? tripForm(data.items.find((t) => t.id === editing) || {}) : null,
      upcoming.length ? el('div', {}, el('h3', {}, 'Now and upcoming'), ...upcoming.map(tripRow))
        : emptyState('No trips yet', 'Add a trip, or upload a calendar export below.'),
      past.length ? el('details', {}, el('summary', {}, `${past.length} past trip${past.length === 1 ? '' : 's'}`), ...past.map(tripRow)) : null,
      candidateList(),
      importCard()].filter(Boolean));
  }

  draw();
  await load();
}
