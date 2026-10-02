import { api } from './api.js';
import { el, toast, spinner } from './ui.js';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'none yet');

export async function renderLedger(root) {
  root.replaceChildren(el('div', { class: 'view' }, spinner()));
  let data;
  try { data = await api.ledger(); } catch (err) {
    root.replaceChildren(el('div', { class: 'view' }, el('p', { class: 'muted' }, `Could not load the ledger: ${err.message}`)));
    return;
  }
  const view = el('div', { class: 'view' });
  let poll = null;
  const redraw = (next) => { data = next; draw(); };

  const stat = (label, value, sub) => el('div', { class: 'card', style: 'flex:1;min-width:150px;text-align:center' },
    el('div', { style: 'font-size:26px;font-weight:700' }, value), el('div', { class: 'muted' }, label), sub ? el('div', { class: 'muted', style: 'font-size:12px' }, sub) : null);

  function draw() {
    const engines = Object.entries(data.byEngine);
    const statRow = el('div', { class: 'row gap', style: 'flex-wrap:wrap' },
      engines.length ? engines.map(([, e]) => stat(e.label, pct(e.mentioned, e.answered), `named in ${e.mentioned} of ${e.answered}, own page cited in ${e.cited}`))
        : el('p', { class: 'muted' }, 'No checks yet. Add your questions below, then run the first check.'));

    // ---- question editor
    const ta = el('textarea', { class: 'input textarea', rows: 8, style: 'width:100%', placeholder: 'One question per line, written the way a real client would ask an assistant.' }, data.questions.map((q) => q.text).join('\n'));
    const suggestBtn = el('button', { class: 'btn btn-ghost', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const { questions } = await api.ledgerSuggest();
        const have = new Set(ta.value.split('\n').map((x) => x.trim().toLowerCase()));
        ta.value = [ta.value.trim(), ...questions.filter((q) => !have.has(q.toLowerCase()))].filter(Boolean).join('\n');
        toast('Suggestions added. Edit them, then save.');
      } catch (err) { toast(err.message, 'err'); }
      e.target.disabled = false;
    } }, 'Suggest questions from my profile');
    const saveBtn = el('button', { class: 'btn', onclick: async () => {
      try { redraw(await api.ledgerQuestions(ta.value.split('\n'))); toast('Questions saved'); } catch (err) { toast(err.message, 'err'); }
    } }, 'Save questions');

    // ---- run controls
    const runBtn = el('button', { class: 'btn', disabled: data.running || !data.questions.length || !data.aiConfigured ? true : null, onclick: async (e) => {
      e.target.disabled = true;
      try { await api.ledgerRun(); toast('Check started. Results appear as each answer arrives.'); watch(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
    } }, data.running ? 'Check running...' : 'Run a check now');
    const enable = el('input', { type: 'checkbox', checked: data.settings.enabled ? true : null, onchange: async (e) => {
      try { await api.ledgerSettings({ enabled: e.target.checked }); toast(e.target.checked ? 'Monthly check is on' : 'Monthly check is off'); } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
    } });

    // ---- results table
    const engineKeys = [...new Set(data.questions.flatMap((q) => Object.keys(q.latest)))];
    const cell = (r) => {
      if (!r) return el('td', { style: 'padding:6px 8px;color:#8a8f98' }, 'not checked');
      if (!r.answered) return el('td', { style: 'padding:6px 8px;color:#b4533a', title: r.error || '' }, 'Check failed', el('div', { class: 'muted', style: 'font-size:11px' }, (r.error || '').slice(0, 60)));
      const tag = r.mentioned ? (r.cited ? 'Named and cited' : 'Named') : (r.cited ? 'Cited, not named' : 'Not named');
      const color = r.mentioned ? '#1f9d55' : r.cited ? '#c7891a' : '#8a8f98';
      return el('td', { style: 'padding:6px 8px', title: r.excerpt || '' }, el('span', { style: `font-weight:600;color:${color}` }, tag), el('div', { class: 'muted', style: 'font-size:11px' }, fmtDate(r.at) + (r.manual ? ' (pasted)' : '')));
    };
    const table = data.questions.length && engineKeys.length
      ? el('div', { style: 'overflow-x:auto' }, el('table', { style: 'width:100%;border-collapse:collapse' },
        el('thead', {}, el('tr', {}, [el('th', { style: 'text-align:left;padding:6px 8px' }, 'Question'), ...engineKeys.map((k) => el('th', { style: 'text-align:left;padding:6px 8px' }, data.engines[k] || k))])),
        el('tbody', {}, data.questions.map((q) => el('tr', { style: 'border-top:1px solid var(--line, #2a2f3a)' }, el('td', { style: 'padding:6px 8px;max-width:340px' }, q.text), ...engineKeys.map((k) => cell(q.latest[k])))))))
      : el('p', { class: 'muted' }, 'Results will appear here after the first check.');

    // ---- manual entry
    const qSel = el('select', { class: 'input select' }, data.questions.map((q) => el('option', { value: q.id }, q.text.slice(0, 80))));
    const eSel = el('select', { class: 'input select' }, Object.entries(data.engines).filter(([k]) => k !== 'claude_web').map(([k, v]) => el('option', { value: k }, v)));
    const ans = el('textarea', { class: 'input textarea', rows: 5, style: 'width:100%', placeholder: 'Paste the assistant\'s answer here.' });
    const src = el('textarea', { class: 'input textarea', rows: 2, style: 'width:100%', placeholder: 'Optional: paste any source links the assistant showed, one per line.' });
    const manualBtn = el('button', { class: 'btn', onclick: async (e) => {
      e.target.disabled = true;
      try { redraw(await api.ledgerManual({ questionId: qSel.value, engine: eSel.value, answer: ans.value, sources: src.value })); toast('Recorded'); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
    } }, 'Record this answer');

    // ---- own names and domains
    const terms = el('input', { class: 'input', type: 'text', style: 'width:100%', value: data.settings.terms.join(', '), placeholder: 'Extra names to look for, comma separated' });
    const domains = el('input', { class: 'input', type: 'text', style: 'width:100%', value: data.settings.domains.join(', '), placeholder: 'Extra domains you own, comma separated' });
    const saveSettings = el('button', { class: 'btn btn-ghost', onclick: async () => {
      try { redraw(await api.ledgerSettings({ terms: terms.value, domains: domains.value })); toast('Saved'); } catch (err) { toast(err.message, 'err'); }
    } }, 'Save names and domains');

    const history = data.history.length ? el('table', { style: 'width:100%;border-collapse:collapse' }, el('tbody', {}, data.history.map((h) => el('tr', { style: 'border-top:1px solid var(--line, #2a2f3a)' },
      el('td', { style: 'padding:6px 8px;white-space:nowrap' }, fmtDate(h.at)),
      el('td', { style: 'padding:6px 8px' }, data.engines[h.engine] || h.engine, h.manual ? ' (pasted)' : ''),
      el('td', { style: 'padding:6px 8px' }, `named ${h.mentioned} of ${h.asked}, own page cited ${h.cited}${h.status && !['complete'].includes(h.status) ? `, ${h.status}` : ''}`),
      el('td', { style: 'padding:6px 8px;text-align:right' }, el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { if (confirm('Remove this entry?')) redraw(await api.ledgerDeleteRun(h.id)); } }, 'Remove')))))) : el('p', { class: 'muted' }, 'No history yet.');

    view.replaceChildren(
      el('div', { class: 'hero' }, el('h1', {}, 'Visibility'), el('p', { class: 'sub' }, 'A fixed set of the questions your clients ask, checked in AI assistants over time, so you can see whether you are being named and whether your own pages are cited.')),
      statRow,
      el('div', { class: 'card' },
        el('h2', {}, 'Your questions'),
        el('p', { class: 'muted' }, 'Keep this set stable so months can be compared. About 10 to 15 works well. Write each the way a real person would ask it, and mention no other business.'),
        ta, el('div', { class: 'row gap', style: 'margin-top:8px' }, saveBtn, suggestBtn)),
      el('div', { class: 'card' },
        el('h2', {}, 'Results'),
        el('div', { class: 'row gap', style: 'margin-bottom:10px;align-items:center;flex-wrap:wrap' }, runBtn,
          el('label', { style: 'display:flex;gap:8px;align-items:center' }, enable, 'Check automatically every month'),
          el('span', { class: 'muted' }, `Last check: ${fmtDate(data.settings.lastRunAt)}`)),
        !data.aiConfigured ? el('p', { class: 'muted' }, 'The server has no Claude key, so automatic checks are unavailable. You can still paste answers below.') : null,
        el('p', { class: 'muted' }, 'The automatic check asks Claude with web search, so it reflects one assistant. Ask the same questions in ChatGPT, Perplexity, Gemini and Bing Copilot yourself once a month and paste each answer below. Bing Webmaster Tools also reports AI citations for free.'),
        table),
      el('div', { class: 'card' },
        el('h2', {}, 'Record an answer from another assistant'),
        data.questions.length ? el('div', { class: 'col gap' }, qSel, eSel, ans, src, manualBtn) : el('p', { class: 'muted' }, 'Save your questions first.')),
      el('div', { class: 'card' },
        el('h2', {}, 'Names and domains to look for'),
        el('p', { class: 'muted' }, 'Your business name, your name, and the sites on your profile are used automatically. Add any others here.'),
        el('div', { class: 'col gap' }, terms, domains, saveSettings)),
      el('div', { class: 'card' }, el('h2', {}, 'History'), history));
  }

  function watch() {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!document.body.contains(view)) { clearInterval(poll); return; }
      try {
        const next = await api.ledger();
        const was = data.running;
        data = next; draw();
        if (!next.running) { clearInterval(poll); if (was) toast('Check finished'); }
      } catch { /* keep polling */ }
    }, 4000);
  }

  root.replaceChildren(view);
  draw();
  if (data.running) watch();
}
