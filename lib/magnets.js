// Interactive lead magnets: a quiz or a calculator per brand, drafted by
// Claude from the brand's own facts, held to the same voice card and fact
// gate as every other output, approved by the owner, and shipped as a
// self-contained embed for her own site. The visitor sees a result on the
// page and can have the full result emailed (explicit consent), which lands
// as a lead through the existing /api/leads/capture endpoint.
//
// Stored per workspace in studio.json under magnets.
//
// Quiz: questions with fixed options; each option adds points to result
// keys; the highest total wins. Calculator: numeric inputs, named constants
// that must each trace to a usable knowledge-base claim, and outputs written
// in a tiny safe expression language (numbers, + - * / and parentheses,
// input and constant ids). No eval anywhere.

import { studioStore, uid } from './store.js';
import { getVoiceCard, scanText } from './voice.js';
import { getKnowledgeBase, gateText } from './facts.js';

const clean = (s, n) => String(s ?? '').replace(/\s*[–—]\s*/g, ', ').replace(/\s+/g, ' ').trim().slice(0, n);
const idOf = (s, n = 30) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, n);
const slugOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
// Unit conversions are the only bare numbers a formula may carry.
const UNIT_LITERALS = new Set([1, 2, 7, 12, 24, 52, 60, 100, 365, 1000]);

// ---- expression language --------------------------------------------------------
export function tokenize(expr) {
  const out = [];
  const re = /\s*(\d+(?:\.\d+)?|[a-z_][a-z0-9_]*|[-+*/()])/gy;
  let m; let pos = 0;
  const s = String(expr || '');
  while (pos < s.length) {
    re.lastIndex = pos;
    m = re.exec(s);
    if (!m) { if (/^\s*$/.test(s.slice(pos))) break; throw new Error(`cannot read "${s.slice(pos, pos + 12)}"`); }
    out.push(m[1]); pos = re.lastIndex;
  }
  return out;
}

// Recursive descent; returns a function of the variable map.
export function compile(expr, known) {
  const t = tokenize(expr);
  let i = 0;
  const peek = () => t[i];
  const take = () => t[i++];
  const primary = () => {
    const x = take();
    if (x === undefined) throw new Error('formula ends too early');
    if (x === '(') { const v = sum(); if (take() !== ')') throw new Error('missing )'); return v; }
    if (x === '-') { const v = primary(); return (env) => -v(env); }
    if (/^\d/.test(x)) { const n = Number(x); return () => n; }
    if (!known.has(x)) throw new Error(`unknown name "${x}"`);
    return (env) => Number(env[x]) || 0;
  };
  const product = () => {
    let v = primary();
    while (peek() === '*' || peek() === '/') {
      const op = take(); const r = primary(); const l = v;
      v = op === '*' ? (env) => l(env) * r(env) : (env) => { const d = r(env); return d === 0 ? 0 : l(env) / d; };
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (peek() === '+' || peek() === '-') {
      const op = take(); const r = product(); const l = v;
      v = op === '+' ? (env) => l(env) + r(env) : (env) => l(env) - r(env);
    }
    return v;
  };
  const f = sum();
  if (i !== t.length) throw new Error(`unexpected "${t[i]}"`);
  return f;
}

export const literalsIn = (expr) => tokenize(expr).filter((x) => /^\d/.test(x)).map(Number);

// ---- normalize + validate --------------------------------------------------------
export function normalizeMagnet(raw = {}) {
  const kind = raw.kind === 'calculator' ? 'calculator' : 'quiz';
  const results = (Array.isArray(raw.results) ? raw.results : []).slice(0, 6).map((r, i) => ({
    key: idOf(r.key || `result_${i + 1}`), title: clean(r.title, 90), body: clean(r.body, 700), cta: clean(r.cta, 160),
    ...(r.maxValue !== undefined && r.maxValue !== null && r.maxValue !== '' ? { maxValue: Number(r.maxValue) } : {}),
    ...(r.resourceSlug ? { resourceSlug: slugOf(r.resourceSlug) } : {}),
  }));
  const base = {
    kind, title: clean(raw.title, 90), intro: clean(raw.intro, 400), results,
    consentText: clean(raw.consentText, 240) || 'Email me my full result and occasional notes. I can unsubscribe at any time.',
  };
  if (kind === 'quiz') {
    base.questions = (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 12).map((q, i) => ({
      id: idOf(q.id || `q${i + 1}`), text: clean(q.text, 200),
      options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o, j) => ({
        id: idOf(o.id || `o${j + 1}`), label: clean(o.label, 140),
        scores: Object.fromEntries(Object.entries(o.scores || {}).map(([k, v]) => [idOf(k), Math.max(0, Math.min(10, Math.round(Number(v) || 0)))])),
      })),
    }));
  } else {
    base.inputs = (Array.isArray(raw.inputs) ? raw.inputs : []).slice(0, 8).map((x, i) => ({
      id: idOf(x.id || `in${i + 1}`), label: clean(x.label, 120), unit: clean(x.unit, 20),
      min: Number.isFinite(Number(x.min)) ? Number(x.min) : 0, max: Number.isFinite(Number(x.max)) ? Number(x.max) : 100000,
      default: Number.isFinite(Number(x.default)) ? Number(x.default) : 0,
    }));
    base.constants = (Array.isArray(raw.constants) ? raw.constants : []).slice(0, 8).map((c, i) => ({
      id: idOf(c.id || `k${i + 1}`), label: clean(c.label, 140), value: Number(c.value), source: clean(c.source, 300),
    }));
    base.outputs = (Array.isArray(raw.outputs) ? raw.outputs : []).slice(0, 5).map((o, i) => ({
      id: idOf(o.id || `out${i + 1}`), label: clean(o.label, 120), formula: String(o.formula || '').slice(0, 200),
      format: ['currency', 'percent', 'hours', 'number'].includes(o.format) ? o.format : 'number',
    }));
  }
  return base;
}

const allText = (m) => [m.title, m.intro, ...m.results.flatMap((r) => [r.title, r.body, r.cta]),
  ...(m.questions || []).flatMap((q) => [q.text, ...q.options.map((o) => o.label)]),
  ...(m.inputs || []).map((x) => x.label), ...(m.outputs || []).map((o) => o.label), ...(m.constants || []).map((c) => c.label)].filter(Boolean);

// Fail closed: returns every problem; an empty list is the only pass.
export function validateMagnet(m, profile) {
  const p = [];
  if (!m.title) p.push('title is empty');
  if (m.results.length < 2) p.push('needs at least 2 results');
  const keys = new Set(m.results.map((r) => r.key));
  if (keys.size !== m.results.length) p.push('result keys must be unique');
  if (m.kind === 'quiz') {
    if (m.questions.length < 3) p.push('a quiz needs at least 3 questions');
    for (const q of m.questions) {
      if (q.options.length < 2) p.push(`question ${q.id} needs at least 2 options`);
      for (const o of q.options) for (const k of Object.keys(o.scores)) if (!keys.has(k)) p.push(`option ${q.id}.${o.id} scores an unknown result "${k}"`);
    }
    for (const r of m.results) if (!m.questions.some((q) => q.options.some((o) => (o.scores[r.key] || 0) > 0))) p.push(`no answer leads to result "${r.key}"`);
  } else {
    if (!m.inputs.length || !m.outputs.length) p.push('a calculator needs inputs and at least one output');
    const kb = getKnowledgeBase(profile).filter((e) => e.status !== 'unverified');
    for (const c of m.constants) {
      if (!Number.isFinite(c.value)) { p.push(`constant ${c.id} has no number`); continue; }
      // A constant is a claim: its number must sit in a usable knowledge-base entry.
      const num = String(c.value);
      const ok = kb.some((e) => (e.claim.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []).includes(num));
      if (!ok) p.push(`constant ${c.id} (${c.value}) is not a checked fact in the knowledge base`);
    }
    const known = new Set([...m.inputs.map((x) => x.id), ...m.constants.map((c) => c.id)]);
    for (const o of m.outputs) {
      try {
        compile(o.formula, known);
        for (const n of literalsIn(o.formula)) if (!UNIT_LITERALS.has(n)) p.push(`output ${o.id} uses the bare number ${n}; make it a named constant backed by a fact`);
      } catch (err) { p.push(`output ${o.id}: ${err.message}`); }
    }
    const banded = m.results.filter((r) => Number.isFinite(r.maxValue));
    if (banded.length < m.results.length - 1) p.push('every result but the last needs a maxValue band on the first output');
  }
  const card = getVoiceCard(profile);
  const kb = getKnowledgeBase(profile);
  for (const t of allText(m)) {
    for (const v of scanText(card, t)) if (v.rule !== 'style') p.push(`voice: ${v.message} ("${v.span}")`);
    for (const d of gateText(t, kb).blocked) p.push(`unverified claim: "${d.claim}"`);
  }
  return [...new Set(p)];
}

// Same scoring the embed runs in the browser, for server-side checks.
export function scoreQuiz(m, answers = {}) {
  const totals = Object.fromEntries(m.results.map((r) => [r.key, 0]));
  for (const q of m.questions) {
    const o = q.options.find((x) => x.id === answers[q.id]);
    if (o) for (const [k, v] of Object.entries(o.scores)) totals[k] = (totals[k] || 0) + v;
  }
  return m.results.reduce((best, r) => (totals[r.key] > totals[best.key] ? r : best), m.results[0]).key;
}

export function runCalculator(m, values = {}) {
  const env = {};
  for (const x of m.inputs) env[x.id] = Math.min(x.max, Math.max(x.min, Number(values[x.id] ?? x.default) || 0));
  for (const c of m.constants) env[c.id] = c.value;
  const known = new Set(Object.keys(env));
  const outputs = m.outputs.map((o) => ({ id: o.id, label: o.label, format: o.format, value: Math.round(compile(o.formula, known)(env) * 100) / 100 }));
  const first = outputs[0]?.value ?? 0;
  const banded = [...m.results].sort((a, b) => (a.maxValue ?? Infinity) - (b.maxValue ?? Infinity));
  const result = banded.find((r) => first <= (r.maxValue ?? Infinity)) || banded[banded.length - 1];
  return { inputs: env, outputs, resultKey: result.key };
}

// Clean only what the visitor could send: known option ids and clamped numbers.
export function sanitizeSubmission(m, body = {}) {
  if (m.kind === 'quiz') {
    const answers = {};
    for (const q of m.questions) if (q.options.some((o) => o.id === body.answers?.[q.id])) answers[q.id] = body.answers[q.id];
    return { answers, resultKey: scoreQuiz(m, answers) };
  }
  const r = runCalculator(m, body.inputs || {});
  return { inputs: Object.fromEntries(m.inputs.map((x) => [x.id, r.inputs[x.id]])), outputs: r.outputs, resultKey: r.resultKey };
}

// ---- store ---------------------------------------------------------------------------
const list = () => studioStore.get().magnets || [];
export const listMagnets = () => list();
export const getMagnet = (slug) => list().find((x) => x.slug === slug) || null;

export function saveMagnet(raw, profile, { slug, status } = {}) {
  const m = normalizeMagnet(raw);
  const problems = validateMagnet(m, profile);
  const existing = slug ? getMagnet(slug) : null;
  const finalSlug = existing?.slug || slugOf(raw.slug || m.title) || uid();
  const taken = !existing && list().some((x) => x.slug === finalSlug);
  const entry = {
    ...m, slug: taken ? `${finalSlug}-${uid().slice(0, 4)}` : finalSlug, id: existing?.id || uid(),
    createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    gate: { status: problems.length ? 'blocked' : 'passed', problems, checkedAt: new Date().toISOString() },
    // Any edit sends it back to draft: the owner approves what goes live.
    status: status || 'draft', approvedAt: null,
  };
  studioStore.update((s) => ({ ...s, magnets: [entry, ...(s.magnets || []).filter((x) => x.slug !== entry.slug)] }));
  return entry;
}

export function approveMagnet(slug, profile, { approved = true, override = false } = {}) {
  const m = getMagnet(slug);
  if (!m) throw Object.assign(new Error('unknown magnet'), { status: 404 });
  const problems = validateMagnet(m, profile);
  if (approved && problems.length && !override) throw Object.assign(new Error('blocked by the quality gate'), { status: 409, problems });
  const next = { ...m, gate: { status: problems.length ? 'blocked' : 'passed', problems, checkedAt: new Date().toISOString() }, status: approved ? 'approved' : 'draft', approvedAt: approved ? new Date().toISOString() : null, ...(approved && problems.length ? { override: true } : {}) };
  studioStore.update((s) => ({ ...s, magnets: (s.magnets || []).map((x) => (x.slug === slug ? next : x)) }));
  return next;
}

export function deleteMagnet(slug) {
  studioStore.update((s) => ({ ...s, magnets: (s.magnets || []).filter((x) => x.slug !== slug) }));
}

// ---- generation ---------------------------------------------------------------------
export function draftPrompt({ kind, topic, audience, kbClaims }) {
  const shape = kind === 'calculator'
    ? '{"kind": "calculator", "title": "", "intro": "", "inputs": [{"id": "", "label": "", "unit": "", "min": 0, "max": 0, "default": 0}], "constants": [{"id": "", "label": "", "value": 0, "source": "the exact checked fact it comes from"}], "outputs": [{"id": "", "label": "", "formula": "uses input and constant ids with + - * / ( )", "format": "number|currency|percent|hours"}], "results": [{"key": "", "title": "", "body": "", "cta": "", "maxValue": 0}]}'
    : '{"kind": "quiz", "title": "", "intro": "", "questions": [{"id": "", "text": "", "options": [{"id": "", "label": "", "scores": {"<result key>": 0}}]}], "results": [{"key": "", "title": "", "body": "", "cta": ""}]}';
  return `Draft an interactive ${kind} lead magnet for this brand.
TOPIC: ${topic}
${audience ? `AUDIENCE: ${audience}\n` : ''}
Rules: useful on its own, honest, specific to the brand's real work. Every number, price, rate, date, credential or claim must come from the CHECKED FACTS below, copied exactly; never invent one. ${kind === 'calculator' ? 'Every rate or multiplier in a formula must be a named constant whose value appears in a checked fact; the only bare numbers allowed in a formula are 1, 2, 7, 12, 24, 52, 60, 100, 365 and 1000. Results are bands on the FIRST output: every result except the last has a maxValue, in ascending order.' : 'Quiz: 4 to 7 questions, 3 or 4 options each, 3 or 4 results; every option scores 0 to 3 points toward one or more result keys, and every result must be reachable.'} Result bodies explain what the result means and the next useful step, and the cta invites a brief call or the full guide. No income or outcome promises, no dashes, never criticize or compare against anyone or anything in the travel industry, no hype words. Never put a double quote inside a value.

CHECKED FACTS:
${kbClaims.length ? kbClaims.map((c) => `- ${c}`).join('\n') : '- (none on file: write without any numbers or claims)'}

Respond with ONLY JSON in this shape: ${shape}`;
}

export async function draftMagnet({ profile, kind, topic, audience, ask }) {
  const kbClaims = getKnowledgeBase(profile).filter((e) => e.status !== 'unverified').map((e) => e.claim.slice(0, 240)).slice(0, 60);
  const prompt = draftPrompt({ kind, topic, audience, kbClaims });
  let raw = await ask(prompt);
  let m = normalizeMagnet({ ...raw, kind });
  let problems = validateMagnet(m, profile);
  if (problems.length) {
    try {
      raw = await ask(`${prompt}\n\nYOUR PREVIOUS DRAFT WAS REJECTED. Fix every item and return the full JSON again:\n${problems.slice(0, 15).map((x) => `- ${x}`).join('\n')}`);
    } catch { /* keep the first draft, blocked */ }
  }
  return saveMagnet({ ...raw, kind }, profile);
}

// ---- embed ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A self-contained block for the brand's own site (Lovable or any page). No
// external scripts, no cookies. It posts to /api/leads/capture, which only
// accepts requests from the brand's own website origin.
export function embedHtml(m, { endpoint, captureId, accent = '#00566b' }) {
  const data = JSON.stringify({
    kind: m.kind, slug: m.slug, results: m.results.map(({ key, title, body, cta, maxValue }) => ({ key, title, body, cta, maxValue })),
    questions: m.questions, inputs: m.inputs, constants: m.constants, outputs: m.outputs,
  }).replace(/</g, '\\u003c');
  const id = `cs-magnet-${m.slug}`;
  return `<!-- ContentStudio interactive lead magnet: ${esc(m.title)} -->
<section id="${id}" style="max-width:620px;margin:0 auto;font-family:inherit;line-height:1.5">
  <h2>${esc(m.title)}</h2>
  <p>${esc(m.intro)}</p>
  <form data-step="answers"></form>
  <div data-step="result" hidden></div>
</section>
<script>
(function () {
  var M = ${data};
  var root = document.getElementById(${JSON.stringify(id)});
  var form = root.querySelector('[data-step=answers]');
  var out = root.querySelector('[data-step=result]');
  var ACC = ${JSON.stringify(accent)};
  function el(t, a, kids) { var n = document.createElement(t); for (var k in a || {}) { if (k === 'text') n.textContent = a[k]; else n.setAttribute(k, a[k]); } (kids || []).forEach(function (c) { n.appendChild(c); }); return n; }
  function compile(expr) {
    var t = String(expr).match(/\\d+(?:\\.\\d+)?|[a-z_][a-z0-9_]*|[-+*\\/()]/g) || [], i = 0;
    function prim(env) { var x = t[i++]; if (x === '(') { var v = sum(env); i++; return v; } if (x === '-') return -prim(env); if (/^\\d/.test(x)) return Number(x); return Number(env[x]) || 0; }
    function prod(env) { var v = prim(env); while (t[i] === '*' || t[i] === '/') { var op = t[i++], r = prim(env); v = op === '*' ? v * r : (r === 0 ? 0 : v / r); } return v; }
    function sum(env) { var v = prod(env); while (t[i] === '+' || t[i] === '-') { var op = t[i++], r = prod(env); v = op === '+' ? v + r : v - r; } return v; }
    return function (env) { i = 0; return sum(env); };
  }
  function fmt(v, f) { if (f === 'currency') return '$' + Math.round(v).toLocaleString(); if (f === 'percent') return Math.round(v) + '%'; if (f === 'hours') return (Math.round(v * 10) / 10) + ' hours'; return (Math.round(v * 10) / 10).toLocaleString(); }
  if (M.kind === 'quiz') {
    M.questions.forEach(function (q) {
      var fs = el('fieldset', { style: 'border:0;padding:0;margin:0 0 16px' }, [el('legend', { text: q.text, style: 'font-weight:600;margin-bottom:6px' })]);
      q.options.forEach(function (o) { var r = el('input', { type: 'radio', name: q.id, value: o.id, required: '' }); fs.appendChild(el('label', { style: 'display:block;margin:4px 0' }, [r, document.createTextNode(' ' + o.label)])); });
      form.appendChild(fs);
    });
  } else {
    M.inputs.forEach(function (x) { form.appendChild(el('label', { style: 'display:block;margin:0 0 12px' }, [document.createTextNode(x.label + (x.unit ? ' (' + x.unit + ')' : '')), el('br'), el('input', { type: 'number', name: x.id, min: x.min, max: x.max, value: x.default, required: '', style: 'padding:8px;width:100%;max-width:240px' })])); });
  }
  form.appendChild(el('button', { type: 'submit', text: M.kind === 'quiz' ? 'See my result' : 'Calculate', style: 'background:' + ACC + ';color:#fff;border:0;border-radius:6px;padding:10px 18px;cursor:pointer' }));
  var payload = {};
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(form), key, lines = [];
    if (M.kind === 'quiz') {
      var answers = {}, totals = {}; M.results.forEach(function (r) { totals[r.key] = 0; });
      M.questions.forEach(function (q) { var v = fd.get(q.id); answers[q.id] = v; q.options.forEach(function (o) { if (o.id === v) for (var k in o.scores) totals[k] = (totals[k] || 0) + o.scores[k]; }); });
      key = M.results.reduce(function (b, r) { return totals[r.key] > totals[b.key] ? r : b; }, M.results[0]).key;
      payload = { answers: answers };
    } else {
      var env = {}, inputs = {};
      M.inputs.forEach(function (x) { var v = Math.min(x.max, Math.max(x.min, Number(fd.get(x.id)) || 0)); env[x.id] = v; inputs[x.id] = v; });
      (M.constants || []).forEach(function (c) { env[c.id] = c.value; });
      var first = null;
      M.outputs.forEach(function (o) { var v = compile(o.formula)(env); if (first === null) first = v; lines.push(o.label + ': ' + fmt(v, o.format)); });
      var bands = M.results.slice().sort(function (a, b) { return (a.maxValue == null ? Infinity : a.maxValue) - (b.maxValue == null ? Infinity : b.maxValue); });
      key = (bands.find(function (r) { return first <= (r.maxValue == null ? Infinity : r.maxValue); }) || bands[bands.length - 1]).key;
      payload = { inputs: inputs };
    }
    var res = M.results.find(function (r) { return r.key === key; });
    out.innerHTML = '';
    out.appendChild(el('h3', { text: res.title }));
    lines.forEach(function (l) { out.appendChild(el('p', { text: l, style: 'font-weight:600;margin:4px 0' })); });
    out.appendChild(el('p', { text: res.body }));
    var mail = el('form', { style: 'margin-top:14px' });
    mail.appendChild(el('label', { style: 'display:block' }, [document.createTextNode('First name'), el('br'), el('input', { name: 'firstName', autocomplete: 'given-name', style: 'padding:8px;width:100%;max-width:300px' })]));
    mail.appendChild(el('label', { style: 'display:block;margin-top:8px' }, [document.createTextNode('Email'), el('br'), el('input', { name: 'email', type: 'email', required: '', autocomplete: 'email', style: 'padding:8px;width:100%;max-width:300px' })]));
    mail.appendChild(el('input', { name: 'hp', tabindex: '-1', autocomplete: 'off', style: 'position:absolute;left:-9999px', 'aria-hidden': 'true' }));
    mail.appendChild(el('label', { style: 'display:block;margin-top:8px' }, [el('input', { type: 'checkbox', name: 'consent', required: '' }), document.createTextNode(' ' + ${JSON.stringify(m.consentText)})]));
    mail.appendChild(el('button', { type: 'submit', text: 'Email me my full result', style: 'margin-top:10px;background:' + ACC + ';color:#fff;border:0;border-radius:6px;padding:10px 18px;cursor:pointer' }));
    var note = el('p', { role: 'status' });
    mail.appendChild(note);
    mail.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var f = new FormData(mail), q = new URLSearchParams(location.search);
      var body = Object.assign({ captureId: ${JSON.stringify(captureId)}, magnet: M.slug, email: f.get('email'), firstName: f.get('firstName'), hp: f.get('hp'), emailConsent: !!f.get('consent'), page: location.href, referrer: (document.referrer ? new URL(document.referrer).hostname : ''), utm_source: q.get('utm_source') || '', utm_medium: q.get('utm_medium') || '', utm_campaign: q.get('utm_campaign') || '', utm_content: q.get('utm_content') || '' }, payload);
      fetch(${JSON.stringify(endpoint)} + '?id=' + encodeURIComponent(${JSON.stringify(captureId)}), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { note.textContent = r.ok ? 'Sent. Check your inbox.' : (j.error || 'Something went wrong.'); }); })
        .catch(function () { note.textContent = 'Something went wrong. Please try again.'; });
    });
    out.appendChild(mail);
    out.hidden = false;
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
})();
</script>`;
}

// ---- result email -------------------------------------------------------------------
export function resultEmail({ m, lead, submission, brand, person, unsubUrl, downloadUrl, siteHost = '', accent = '#00566b' }) {
  const r = m.results.find((x) => x.key === submission.resultKey) || m.results[0];
  const lines = (submission.outputs || []).map((o) => `<li>${esc(o.label)}: <strong>${esc(o.format === 'currency' ? `$${Math.round(o.value).toLocaleString()}` : o.format === 'percent' ? `${Math.round(o.value)}%` : o.format === 'hours' ? `${o.value} hours` : String(o.value))}</strong></li>`).join('');
  const html = `<div style="font-family:Georgia,'Times New Roman',serif;max-width:540px;margin:0 auto;padding:28px 22px;color:#0d1216;line-height:1.55;font-size:16px">
  <p>Hi ${esc(lead.firstName || 'there')},</p>
  <p>Here is your result from <strong>${esc(m.title)}</strong>.</p>
  <h2 style="font-weight:400;margin:18px 0 8px">${esc(r.title)}</h2>
  ${lines ? `<ul>${lines}</ul>` : ''}
  <p>${esc(r.body)}</p>
  ${r.cta ? `<p>${esc(r.cta)}</p>` : ''}
  ${downloadUrl ? `<p><a href="${esc(downloadUrl)}" style="color:${esc(accent)}">Download the guide that goes with this result</a></p>` : ''}
  <p>Warmly,<br>${esc(person)}</p>
  <hr style="border:none;border-top:1px solid #d2cdc5;margin:30px 0 14px">
  <p style="font-family:-apple-system,Segoe UI,sans-serif;font-size:12px;color:#777;margin:0">You asked for this result${siteHost ? ` at ${esc(siteHost)}` : ''}. ${esc(brand)}. <a href="${esc(unsubUrl)}" style="color:#777">Unsubscribe</a></p></div>`;
  return { subject: `Your result: ${r.title}`, html };
}
