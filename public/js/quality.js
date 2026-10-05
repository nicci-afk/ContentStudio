// Quality: the per-brand data the quality modules run on. Knowledge base
// (fact gate), voice card, hook library, trend inputs, results and the
// feedback report, attribution, reviews, and the entity-consistency check.
// Everything here belongs to the active business only.

import { api, appState } from './api.js';
import { el, toast, spinner, textInput, download, copyBtn } from './ui.js';

const TABS = [
  ['knowledge', 'Knowledge base'], ['voice', 'Voice card'], ['hooks', 'Hook library'], ['trends', 'Trends'],
  ['magnets', 'Lead magnets'], ['results', 'Results'], ['reviews', 'Reviews'], ['entity', 'Entity check'],
];
const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');
const td = (...c) => el('td', { style: 'padding:6px 8px;vertical-align:top' }, ...c);
const th = (t) => el('th', { style: 'text-align:left;padding:6px 8px' }, t);
const table = (head, rows) => el('div', { style: 'overflow-x:auto' }, el('table', { style: 'width:100%;border-collapse:collapse' },
  el('thead', {}, el('tr', {}, head.map(th))), el('tbody', {}, rows)));
const tr = (...cells) => el('tr', { style: 'border-top:1px solid var(--line, #2a2f3a)' }, ...cells);
const err = (e) => toast(e.message, 'err');

export async function renderQuality(root, params) {
  let tab = params?.get?.('tab') || 'knowledge';
  const view = el('div', { class: 'view' });
  const body = el('div', {});
  const tabRow = el('div', { class: 'tab-row' });
  const drawTabs = () => tabRow.replaceChildren(...TABS.map(([id, label]) => el('button', { class: `tab ${id === tab ? 'active' : ''}`, onclick: () => { tab = id; drawTabs(); show(); } }, label)));
  const show = async () => {
    body.replaceChildren(spinner());
    try { body.replaceChildren(await PANELS[tab](show)); } catch (e) { body.replaceChildren(el('p', { class: 'muted' }, `Could not load: ${e.message}`)); }
  };
  view.append(
    el('div', { class: 'hero' }, el('h1', {}, 'Quality'), el('p', { class: 'sub' }, `What every draft for ${appState.profile?.business?.name || 'this business'} is checked against: the facts it may state, the voice it must keep, the hooks it may open with, the trends shaping it, and what the results say.`)),
    tabRow, body);
  root.replaceChildren(view);
  drawTabs();
  show();
}

// ---- knowledge base --------------------------------------------------------
async function knowledgePanel(refresh) {
  const { entries } = await api.knowledge();
  const own = entries.filter((e) => !e.derived);
  const derived = entries.filter((e) => e.derived);
  const rows = own.map((e) => ({ ...e }));
  const list = el('div', { class: 'col gap' });
  const draw = () => list.replaceChildren(...rows.map((e, i) => {
    const claim = el('textarea', { class: 'input textarea', rows: 2, style: 'width:100%', oninput: (ev) => { e.claim = ev.target.value; } }, e.claim);
    const status = el('select', { class: 'input select', onchange: (ev) => { e.status = ev.target.value; } },
      ['verified', 'owner_statement', 'unverified'].map((s) => { const o = el('option', { value: s }, s.replace('_', ' ')); if (s === e.status) o.selected = true; return o; }));
    const source = textInput({ value: e.source || '', placeholder: 'Source: contract, email, booking record, or "owner, date"', oninput: (ev) => { e.source = ev.target.value; } });
    const date = el('input', { class: 'input', type: 'date', value: e.date || '', onchange: (ev) => { e.date = ev.target.value; } });
    return el('div', { class: 'card', style: 'padding:10px' }, claim, el('div', { class: 'row gap wrap', style: 'margin-top:6px' }, status, source, date,
      el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { rows.splice(i, 1); draw(); } }, 'Remove')));
  }));
  draw();
  return el('div', {},
    el('div', { class: 'card' },
      el('h2', {}, 'Claims this business may make'),
      el('p', { class: 'muted' }, 'Every number, date, price, credential, award or superlative in a draft must match a claim here, or the draft is blocked. Verified means confirmed in a contract, correspondence or a firsthand record, with the source named. Owner statement means you said it directly; it is usable and stays attributed to you. Unverified claims are never shipped, so marking something unverified is how you stop a claim from appearing.'),
      list,
      el('div', { class: 'row gap', style: 'margin-top:10px' },
        el('button', { class: 'btn btn-ghost', onclick: () => { rows.push({ claim: '', status: 'owner_statement', source: '', date: new Date().toISOString().slice(0, 10) }); draw(); } }, '+ Add a claim'),
        el('button', { class: 'btn', onclick: async () => { try { await api.saveKnowledge(rows); toast('Knowledge base saved'); refresh(); } catch (e) { err(e); } } }, 'Save'))),
    el('div', { class: 'card' },
      el('h2', {}, 'Also counted (from your profile and approved plan facts)'),
      el('p', { class: 'muted' }, 'These come from your Story Interview, credentials, testimonials and Content Plan facts. Edit them where they live.'),
      derived.length ? el('ul', { style: 'padding-left:18px' }, derived.map((e) => el('li', { class: 'muted' }, `${e.claim.slice(0, 220)} · ${e.status.replace('_', ' ')} · ${e.source}`))) : el('p', { class: 'muted' }, 'Nothing yet.')));
}

// ---- voice card ------------------------------------------------------------
async function voicePanel(refresh) {
  const { card, own, defaults } = await api.voiceCard();
  const phrases = el('textarea', { class: 'input textarea', rows: 8, style: 'width:100%', placeholder: 'One banned word or phrase per line' }, (own.banned_phrases || []).join('\n'));
  const patterns = el('textarea', { class: 'input textarea', rows: 4, style: 'width:100%', placeholder: 'One per line: label | regular expression' }, (own.banned_patterns || []).map((p) => `${p.label} | ${p.re}`).join('\n'));
  const maxWords = el('input', { class: 'input', type: 'number', min: 10, max: 80, value: card.style_targets?.max_sentence_words || 32, style: 'width:90px' });
  return el('div', {},
    el('div', { class: 'card' },
      el('h2', {}, 'Your additions'),
      el('p', { class: 'muted' }, 'Added on top of the defaults below and your blocklist. Any draft that uses one is rewritten once with the violation cited; if it fails again it is blocked, never shipped. These rules belong to this business only.'),
      el('div', { class: 'field-label' }, 'Banned words and phrases'), phrases,
      el('div', { class: 'field-label', style: 'margin-top:8px' }, 'Banned structures (advanced)'), patterns,
      el('div', { class: 'row gap', style: 'margin-top:8px;align-items:center' }, el('span', { class: 'muted' }, 'Flag sentences longer than'), maxWords, el('span', { class: 'muted' }, 'words (advisory)')),
      el('button', { class: 'btn', style: 'margin-top:10px', onclick: async () => {
        const pats = patterns.value.split('\n').map((l) => l.split('|')).filter((x) => x.length >= 2).map(([label, ...re], i) => ({ id: `own-${i}`, label: label.trim(), re: re.join('|').trim() }));
        try { await api.saveVoiceCard({ banned_phrases: phrases.value, banned_patterns: pats, style_targets: { max_sentence_words: Number(maxWords.value) || 32 } }); toast('Voice card saved'); refresh(); } catch (e) { err(e); }
      } }, 'Save voice card')),
    el('div', { class: 'card' },
      el('h2', {}, 'Always on'),
      el('p', { class: 'muted' }, `Banned phrases: ${defaults.banned_phrases.filter((p) => p.length > 1).join(', ')}, plus em and en dashes.`),
      el('p', { class: 'muted' }, `Banned structures: ${defaults.banned_patterns.map((p) => p.label).join('; ')}.`),
      el('p', { class: 'muted' }, `Your blocklist: ${card.banned_terms.length ? card.banned_terms.join(', ') : 'none set'} (edit it in the Story Interview).`)));
}

// ---- hook library ----------------------------------------------------------
async function hooksPanel(refresh) {
  const { hooks, ranked, patterns } = await api.hooks();
  const rank = new Map(ranked.map((id, i) => [id, i + 1]));
  const rows = hooks.sort((a, b) => (rank.get(a.id) || 99) - (rank.get(b.id) || 99)).map((h) => tr(
    td(rank.get(h.id) ? `#${rank.get(h.id)}` : 'retired'),
    td(el('strong', {}, h.template), el('div', { class: 'muted', style: 'font-size:12px' }, `${h.pattern.replace(/_/g, ' ')} · slots: ${Object.entries(h.slots).map(([k, v]) => `${k} (${v})`).join(', ')}${h.note ? ` · ${h.note}` : ''}`)),
    td(h.source === 'promoted' ? `★ promoted ${fmt(h.promotedAt)}` : h.source),
    td(`${h.performance.uses} uses`, el('div', { class: 'muted', style: 'font-size:12px' }, `calls ${h.performance.bookedCalls} · DMs ${h.performance.dms} · saves ${h.performance.saves} · shares ${h.performance.shares} · follows ${h.performance.follows}`)),
    td(h.source === 'owner' ? el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { if (confirm('Delete this template?')) { await api.deleteHook(h.id).catch(err); refresh(); } } }, 'Delete') : '')));
  const tpl = textInput({ placeholder: 'e.g. [NUMBER] guests, zero missed transfers. [HOW].', style: 'width:100%' });
  const pat = el('select', { class: 'input select' }, patterns.map((p) => el('option', { value: p }, p.replace(/_/g, ' '))));
  const free = textInput({ placeholder: 'Slots that may be your own words (comma separated); all others must be checked facts' });
  // Try a fill.
  const testSel = el('select', { class: 'input select' }, hooks.filter((h) => !h.retiredAt).map((h) => el('option', { value: h.id }, h.template)));
  const slotBox = el('div', { class: 'col gap' });
  const result = el('div', {});
  const drawSlots = () => {
    const h = hooks.find((x) => x.id === testSel.value);
    slotBox.replaceChildren(...Object.keys(h?.slots || {}).map((k) => textInput({ placeholder: `${k} (${h.slots[k]})`, 'data-slot': k })));
  };
  testSel.onchange = drawSlots; drawSlots();
  return el('div', {},
    el('div', { class: 'card' },
      el('h2', {}, 'Templates, best first'),
      el('p', { class: 'muted' }, 'Generation may only open with one of these. Fact slots are filled from the knowledge base; a fill that is not a checked fact is rejected. Winners promoted by the results loop rank above the seeds. The contrarian template challenges a belief, never a group of people, so it stays within your industry-respect rule.'),
      table(['Rank', 'Template', 'Source', 'Performance', ''], rows)),
    el('div', { class: 'card' },
      el('h2', {}, 'Try a fill'),
      el('div', { class: 'col gap' }, testSel, slotBox,
        el('button', { class: 'btn btn-ghost', onclick: async () => {
          const slots = Object.fromEntries([...slotBox.querySelectorAll('input')].map((i) => [i.dataset.slot, i.value]));
          try { const r = await api.testHook(testSel.value, slots); result.replaceChildren(el('p', {}, r.ok ? `✅ ${r.text}` : `⛔ ${r.text}`), r.problems.length ? el('ul', {}, r.problems.map((p) => el('li', { class: 'muted' }, p))) : ''); } catch (e) { err(e); }
        } }, 'Check this fill'), result)),
    el('div', { class: 'card' },
      el('h2', {}, 'Add your own template'),
      el('p', { class: 'muted' }, 'Write slots in square brackets in capitals. No dashes.'),
      el('div', { class: 'col gap' }, tpl, pat, free,
        el('button', { class: 'btn', onclick: async () => {
          const names = [...tpl.value.matchAll(/\[([A-Z_]+)\]/g)].map((m) => m[1]);
          const freeSet = new Set(free.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
          try { await api.saveHook({ template: tpl.value, pattern: pat.value, slots: Object.fromEntries(names.map((n) => [n, freeSet.has(n) ? 'free' : 'fact'])) }); toast('Template added'); refresh(); } catch (e) { err(e); }
        } }, 'Add template'))));
}

// ---- trends ------------------------------------------------------------------
async function trendsPanel(refresh) {
  const { trends, ttlDays } = await api.trendInputs();
  const file = el('input', { type: 'file', accept: '.json,application/json' });
  const paste = el('textarea', { class: 'input textarea', rows: 6, style: 'width:100%', placeholder: '[{"platform": "instagram", "format_shift": "...", "hook_structure": "...", "audio_trend": "...", "observed_date": "2026-10-05", "source": "first-party: my October insights"}]' });
  const doImport = async (text) => {
    try {
      const r = await api.importTrendInputs(JSON.parse(text));
      toast(`${r.accepted} accepted${r.rejected.length ? `, ${r.rejected.length} rejected: ${r.rejected[0].reason}` : ''}`, r.rejected.length ? 'err' : 'ok');
      refresh();
    } catch (e) { err(e); }
  };
  file.onchange = async () => { if (file.files[0]) doImport(await file.files[0].text()); };
  return el('div', {},
    el('div', { class: 'card' },
      el('h2', {}, 'Import this week\'s trends.json'),
      el('p', { class: 'muted' }, `Each entry needs a platform (instagram, facebook, meta, youtube, linkedin, all, or a format id), an observed_date and a source, or it is rejected. Trends shape structure only, never wording, and every output they shape names the entry. An entry stops applying ${ttlDays} days after it was last observed; importing it again renews it. With no trends at all, drafts follow the evergreen baseline.`),
      el('div', { class: 'col gap' }, file, paste, el('button', { class: 'btn', onclick: () => doImport(paste.value) }, 'Import pasted JSON'))),
    el('div', { class: 'card' },
      el('h2', {}, 'Observations'),
      trends.length ? table(['Id', 'Platform', 'Observation', 'Observed', 'Source', ''], trends.map((t) => tr(
        td(t.id), td(t.platform),
        td([t.format_shift && `Format: ${t.format_shift}`, t.hook_structure && `Hook: ${t.hook_structure}`, t.audio_trend && `Audio: ${t.audio_trend}`].filter(Boolean).join(' · ')),
        td(`${t.observed_date}`, el('div', { class: 'muted', style: 'font-size:12px' }, t.active ? `active until ${t.expiresOn}` : 'expired')),
        td(t.source), td(el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { await api.deleteTrendInput(t.id).catch(err); refresh(); } }, 'Remove'))))) : el('p', { class: 'muted' }, 'No trend observations yet.')),
    el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download('trends.json', JSON.stringify(trends.map(({ platform, format_shift, hook_structure, audio_trend, observed_date, source }) => ({ platform, format_shift, hook_structure, audio_trend, observed_date, source })), null, 2), 'application/json') }, 'Download current trends.json'));
}

// ---- results: feedback report + attribution + booking link ----------------
async function resultsPanel(refresh) {
  const [rep, attr] = await Promise.all([api.feedbackReport(), api.attribution()]);
  const booking = textInput({ value: attr.bookingUrl || '', placeholder: 'https://calendly.com/you/brief-call (your calendar booking page)', style: 'flex:1;min-width:260px' });
  const run = (job) => el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { try { await api.feedbackRun(job); toast(`${job} run done`); refresh(); } catch (e) { err(e); } } }, `Run ${job} now`);
  const metricLine = (m = {}) => `calls ${m.bookedCalls || 0} · DMs ${m.dms || 0} · saves ${m.saves || 0} · shares ${m.shares || 0} · follows ${m.follows || 0}`;
  return el('div', {},
    el('div', { class: 'card' },
      el('h2', {}, 'What won, what was retired, what replaced it'),
      el('p', { class: 'muted' }, `Ranked by booked calls, then DMs, saves, shares and follows. Likes are never counted. ${rep.measured} asset(s) measured so far. Weekly the winning pillar's hook templates are promoted; every two weeks the bottom quarter is retired; monthly your own results become first-party trend entries; quarterly the lead magnets are reviewed.`),
      el('div', { class: 'row gap wrap' }, run('weekly'), run('biweekly'), run('monthly'), run('quarterly')),
      el('h3', {}, 'Winners'),
      rep.winners.length ? table(['Content', 'Platform', 'Results'], rep.winners.map((w) => tr(td(w.topic), td(w.platformId), td(metricLine(w.metrics))))) : el('p', { class: 'muted' }, 'Enter results on published posts (Create, each platform tab) to start ranking.'),
      el('h3', {}, 'Retired'),
      rep.retired.length ? table(['Content', 'Platform', 'Retired', 'Replaced by'], rep.retired.map((r) => tr(td(r.topic), td(r.platformId), td(fmt(r.at)), td(r.replacedBy ? `${r.replacedBy.topic} (${fmt(r.replacedBy.at)})` : 'nothing yet')))) : el('p', { class: 'muted' }, 'Nothing retired yet.'),
      el('h3', {}, 'Hook library shift (share of hooks from promoted winners)'),
      el('p', {}, rep.hookShift.map((m) => `${m.month}: ${m.promotedShare == null ? 'no hooks used' : `${Math.round(m.promotedShare * 100)}% of ${m.uses}`}`).join(' · ')),
      rep.unmeasured.length ? el('details', {}, el('summary', { class: 'muted' }, `${rep.unmeasured.length} published asset(s) with no results entered`), el('ul', {}, rep.unmeasured.slice(0, 30).map((u) => el('li', { class: 'muted' }, `${u.topic} · ${u.platformId}`)))) : null,
      el('h3', {}, 'Lead magnets'),
      rep.leadMagnets.length ? table(['Resource', 'Sign-ups', 'Applied', 'Booked', 'Signed'], rep.leadMagnets.map((r) => tr(td(r.resource), td(String(r.leads)), td(String(r.applied)), td(String(r.booked)), td(String(r.signed))))) : el('p', { class: 'muted' }, 'No lead magnet sign-ups yet.'),
      el('details', {}, el('summary', { class: 'muted' }, 'Run log'), el('ul', {}, rep.log.map((l) => el('li', { class: 'muted' }, `${fmt(l.at)} · ${l.job}: ${l.result}`))))),
    el('div', { class: 'card' },
      el('h2', {}, 'Post to lead to booked call to signed'),
      el('p', { class: 'muted' }, 'Leads are matched to the post whose tracked link they came through. Mark a lead "call_booked" or "won" on the Leads page to move it along.'),
      attr.rows.length ? table(['Content', 'Platform', 'Booking clicks', 'Leads', 'Booked', 'Signed'], attr.rows.map((r) => tr(td(r.topic), td(r.platformId), td(String(r.bookingClicks)), td(String(r.leads)), td(String(r.booked)), td(String(r.signed))))) : el('p', { class: 'muted' }, 'No attributed leads yet.')),
    await metaBlock(refresh),
    el('div', { class: 'card' },
      el('h2', {}, 'Book-a-brief-call link'),
      el('p', { class: 'muted' }, 'Your calendar booking page. The studio gives every post and email a tracked link that counts the click and forwards to it, so booked calls trace back to the post.'),
      el('div', { class: 'row gap' }, booking, el('button', { class: 'btn', onclick: async () => { try { await api.patchState('profile.business.bookingUrl', booking.value.trim()); if (appState.state?.profile) appState.state.profile.business = { ...(appState.state.profile.business || {}), bookingUrl: booking.value.trim() }; toast('Booking link saved'); refresh(); } catch (e) { err(e); } } }, 'Save'))));
}

// ---- reviews -------------------------------------------------------------------
async function reviewsPanel(refresh) {
  const r = await api.reviews();
  const g = textInput({ value: r.links.google || '', placeholder: 'Google review link (from your Business Profile, "Ask for reviews")', style: 'width:100%' });
  const f = textInput({ value: r.links.facebook || '', placeholder: 'Facebook reviews link', style: 'width:100%' });
  const auto = el('input', { type: 'checkbox', checked: r.auto ? true : null });
  const delay = el('input', { class: 'input', type: 'number', min: 1, max: 60, value: r.delayDays, style: 'width:80px' });
  const plat = el('select', { class: 'input select' }, ['google', 'facebook'].map((p) => el('option', { value: p }, p)));
  const count = el('input', { class: 'input', type: 'number', min: 0, placeholder: 'count', style: 'width:100px' });
  const rating = el('input', { class: 'input', type: 'number', min: 0, max: 5, step: 0.1, placeholder: 'rating', style: 'width:100px' });
  return el('div', {},
    el('div', { class: 'card' },
      el('h2', {}, 'Review requests'),
      el('p', { class: 'muted' }, 'Every signed client (status "won") gets the same request, once, a set number of days after signing, inside business hours. No gating, no incentives, no asking for a star rating: that is what Google and the FTC require. Off until you switch it on.'),
      el('div', { class: 'col gap' }, g, f,
        el('label', { style: 'display:flex;gap:8px;align-items:center' }, auto, 'Send requests automatically,', delay, 'days after a deal is won'),
        el('div', { class: 'row gap' },
          el('button', { class: 'btn', onclick: async () => { try { await api.reviewSettings({ links: { google: g.value, facebook: f.value }, auto: auto.checked, delayDays: Number(delay.value) }); toast('Saved'); refresh(); } catch (e) { err(e); } } }, 'Save'),
          el('button', { class: 'btn btn-ghost', disabled: r.eligible.length ? null : true, onclick: async () => { try { const o = await api.reviewSend(); toast(`${o.sent} request(s) sent`); refresh(); } catch (e) { err(e); } } }, `Send to ${r.eligible.length} eligible client(s) now`))),
      el('p', { class: 'muted' }, `${r.requested} request(s) sent so far.`)),
    el('div', { class: 'card' },
      el('h2', {}, 'Review velocity'),
      el('p', { class: 'muted' }, 'Record your review count from each platform now and then; velocity is new reviews per 30 days.'),
      Object.keys(r.velocity).length ? table(['Platform', 'Reviews', 'Rating', 'Per 30 days (recent)', 'Per 30 days (90 day avg)', 'As of'], Object.entries(r.velocity).map(([p, v]) => tr(td(p), td(String(v.count)), td(v.rating == null ? '' : String(v.rating)), td(v.per30 == null ? 'need a second count' : String(v.per30)), td(v.per30over90 == null ? '' : String(v.per30over90)), td(v.asOf)))) : el('p', { class: 'muted' }, 'No counts recorded yet.'),
      el('div', { class: 'row gap wrap', style: 'margin-top:8px' }, plat, count, rating, el('button', { class: 'btn btn-ghost', onclick: async () => { try { await api.reviewCount({ platform: plat.value, count: count.value, rating: rating.value }); refresh(); } catch (e) { err(e); } } }, 'Record count'))));
}

// ---- entity consistency ----------------------------------------------------------
async function entityPanel(refresh) {
  const e = await api.entityCheck();
  const urls = el('textarea', { class: 'input textarea', rows: 4, style: 'width:100%', placeholder: 'Directory or listing pages that mention you, one per line (Yelp, BBB, chamber, association profiles)' }, e.urls.join('\n'));
  const auto = el('input', { type: 'checkbox', checked: e.auto ? true : null });
  const last = e.last;
  return el('div', {},
    el('div', { class: 'card' },
      el('h2', {}, 'Name, address and phone everywhere'),
      el('p', { class: 'muted' }, `Expected: ${e.expected.names.join(' / ') || 'no business name set'}${e.expected.phone ? ` · ${e.expected.phone}` : ''}${e.expected.address ? ` · ${e.expected.address}` : ''}. The check reads each page as a plain bot and changes nothing. Login-walled sites are listed for you to check by hand.`),
      el('div', { class: 'col gap' }, urls,
        el('label', { style: 'display:flex;gap:8px;align-items:center' }, auto, 'Check automatically every month'),
        el('div', { class: 'row gap' },
          el('button', { class: 'btn btn-ghost', onclick: async () => { try { await api.entitySettings({ urls: urls.value, auto: auto.checked }); toast('Saved'); refresh(); } catch (er) { err(er); } } }, 'Save'),
          el('button', { class: 'btn', onclick: async (ev) => { ev.target.disabled = true; try { await api.entitySettings({ urls: urls.value, auto: auto.checked }); await api.entityRun(); toast('Check finished'); refresh(); } catch (er) { err(er); ev.target.disabled = false; } } }, 'Run the check now')))),
    el('div', { class: 'card' },
      el('h2', {}, `Last check: ${last ? `${fmt(last.at)}, ${last.issues} issue(s)` : 'never'}`),
      last ? table(['Page', 'Result'], last.results.map((x) => tr(td(el('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.url.slice(0, 70))),
        td(x.skipped || x.error || (x.issues.length ? `⛔ ${x.issues.join('; ')}` : '✅ consistent'))))) : el('p', { class: 'muted' }, `${e.targets.length} page(s) will be checked: your profile links plus the list above.`)));
}

// ---- Meta connection (results by API) -----------------------------------------
async function metaBlock(refresh) {
  const st = await api.meta();
  const token = el('input', { class: 'input', type: 'password', placeholder: st.connected ? 'Token saved (paste a new one to replace it)' : 'Access token with instagram_manage_insights and pages_read_engagement', style: 'width:100%' });
  const ig = textInput({ value: st.igUserId, placeholder: 'Instagram professional account id (digits)' });
  const page = textInput({ value: st.pageId, placeholder: 'Facebook Page id (digits, optional)' });
  return el('div', { class: 'card' },
    el('h2', {}, `Meta results by API${st.connected ? ' · connected' : ''}`),
    el('p', { class: 'muted' }, 'Pulls saves, shares and follows for your published Instagram and Facebook posts once a day, read-only. DMs are not available from Meta, and booked calls come from your leads, so those stay as you enter them. The token is stored for this business only and is never shown again or included in backups.'),
    el('div', { class: 'col gap' }, token, el('div', { class: 'row gap wrap' }, ig, page),
      el('div', { class: 'row gap wrap' },
        el('button', { class: 'btn', onclick: async () => { try { await api.metaConnect({ accessToken: token.value || undefined, igUserId: ig.value, pageId: page.value }); toast('Saved'); refresh(); } catch (e) { err(e); } } }, 'Save connection'),
        st.connected ? el('button', { class: 'btn btn-ghost', onclick: async (e) => { e.target.disabled = true; try { const r = await api.metaSync(); toast(`${r.synced} post(s) updated`); refresh(); } catch (er) { err(er); e.target.disabled = false; } } }, 'Pull results now') : null,
        st.connected ? el('button', { class: 'btn btn-ghost', onclick: async () => { if (confirm('Disconnect Meta for this business?')) { await api.metaDisconnect().catch(err); refresh(); } } }, 'Disconnect') : null)),
    el('p', { class: 'muted' }, `Last pull: ${fmt(st.lastSync)}${st.lastError ? ` · last error: ${st.lastError}` : ''}`));
}

// ---- interactive lead magnets --------------------------------------------------------
async function magnetsPanel(refresh) {
  const { magnets } = await api.magnets();
  const kind = el('select', { class: 'input select' }, el('option', { value: 'quiz' }, 'Quiz'), el('option', { value: 'calculator' }, 'Calculator'));
  const topic = textInput({ placeholder: 'e.g. Which kind of group trip fits your team?', style: 'width:100%' });
  const audience = textInput({ placeholder: 'Who it is for (optional)', style: 'width:100%' });
  const card = (m) => {
    const json = el('textarea', { class: 'input textarea', rows: 14, style: 'width:100%;font-family:monospace;font-size:12px' }, JSON.stringify((({ kind: k, title, intro, questions, inputs, constants, outputs, results, consentText }) => ({ kind: k, title, intro, questions, inputs, constants, outputs, results, consentText }))(m), null, 2));
    const embedBox = el('div', {});
    const tryBox = el('div', {});
    return el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('h3', { style: 'margin:0' }, `${m.title} · ${m.kind}`),
        el('span', {}, m.status === 'approved' ? `✅ approved${m.override ? ' (override)' : ''}` : m.gate.status === 'passed' ? 'draft · passes the gate' : '⛔ draft · blocked by the gate')),
      m.gate.problems.length ? el('ul', {}, m.gate.problems.slice(0, 15).map((p) => el('li', { class: 'muted' }, p))) : null,
      el('p', { class: 'muted' }, m.intro),
      el('details', {}, el('summary', { class: 'muted' }, 'Edit (JSON)'), json,
        el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { try { await api.saveMagnet(m.slug, JSON.parse(json.value)); toast('Saved and re-checked (back to draft)'); refresh(); } catch (e) { err(e); } } }, 'Save edits')),
      el('div', { class: 'row gap wrap', style: 'margin-top:8px' },
        el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => {
          const body = m.kind === 'quiz' ? { answers: Object.fromEntries(m.questions.map((q) => [q.id, q.options[0]?.id])) } : { inputs: Object.fromEntries(m.inputs.map((x) => [x.id, x.default])) };
          try { const r = await api.tryMagnet(m.slug, body); const res = m.results.find((x) => x.key === r.resultKey); tryBox.replaceChildren(el('p', { class: 'muted' }, `Sample run: ${res?.title || r.resultKey}${r.outputs ? ` · ${r.outputs.map((o) => `${o.label}: ${o.value}`).join(', ')}` : ''}`)); } catch (e) { err(e); }
        } }, 'Try a sample run'),
        m.status === 'approved'
          ? el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { await api.approveMagnet(m.slug, false).catch(err); refresh(); } }, 'Back to draft')
          : el('button', { class: 'btn btn-primary btn-xs', onclick: async () => {
            try { await api.approveMagnet(m.slug, true); toast('Approved'); refresh(); } catch (e) {
              if (e.status === 409 && confirm('The quality gate blocked this magnet. Approve anyway? The override is logged.')) { await api.approveMagnet(m.slug, true, true).catch(err); refresh(); } else err(e);
            }
          } }, 'Approve'),
        m.status === 'approved' ? el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => {
          try { const r = await api.magnetEmbed(m.slug); embedBox.replaceChildren(el('p', { class: 'muted' }, r.note), el('div', { class: 'row gap' }, copyBtn(r.html, 'Copy embed code'), el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`${m.slug}.html`, r.html, 'text/html') }, 'Download'))); } catch (e) { err(e); }
        } }, 'Get embed code') : null,
        el('button', { class: 'btn btn-danger btn-xs', onclick: async () => { if (confirm('Delete this lead magnet?')) { await api.deleteMagnet(m.slug).catch(err); refresh(); } } }, 'Delete')),
      tryBox, embedBox);
  };
  return el('div', {},
    el('div', { class: 'card' },
      el('h2', {}, 'Interactive lead magnets'),
      el('p', { class: 'muted' }, 'A quiz or a calculator for your own site. Visitors see a result on the page and can have the full result emailed, which arrives here as a lead. Every number and claim must come from your knowledge base, and a calculator\'s rates must each be a checked fact. Nothing goes live until you approve it.'),
      el('div', { class: 'col gap' }, el('div', { class: 'row gap' }, kind), topic, audience,
        el('button', { class: 'btn', onclick: async (e) => {
          if (!topic.value.trim()) return toast('Add a topic first', 'err');
          e.target.disabled = true; e.target.textContent = 'Drafting…';
          try { await api.draftMagnet({ kind: kind.value, topic: topic.value, audience: audience.value }); toast('Draft ready'); refresh(); } catch (er) { err(er); e.target.disabled = false; e.target.textContent = 'Draft it'; }
        } }, 'Draft it'))),
    ...magnets.map(card));
}

const PANELS = { magnets: magnetsPanel, knowledge: knowledgePanel, voice: voicePanel, hooks: hooksPanel, trends: trendsPanel, results: resultsPanel, reviews: reviewsPanel, entity: entityPanel };
