// Visibility Ledger: a fixed set of buyer questions per workspace, checked on
// a schedule (and on demand) to see whether an AI answer names the brand and
// cites its own domains. It records only facts about the brand's own
// visibility: named yes or no, which of its own pages were cited, and the
// sources an answer read. It never stores or characterizes anyone else.
import crypto from 'node:crypto';
import { claudeSearch, claudeJson } from './providers.js';

const MAX_QUESTIONS = 25;
const MAX_RUNS = 200;
const STALE_RUN_MS = 30 * 60 * 1000;
export const MONTH_MS = 30 * 24 * 3600 * 1000;
export const ENGINES = {
  claude_web: 'Claude with web search',
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  copilot: 'Bing Copilot',
  google_ai: 'Google AI Overview',
  other: 'Other assistant',
};

const id = () => crypto.randomBytes(6).toString('hex');
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const DASHES = /[–—]/g;

export function cleanQuestion(q) {
  return clip(q, 200).replace(DASHES, ',');
}

// Brand names the answer should mention: the business, the person, and any
// extra terms the owner added. Domains are every site the brand owns.
export function brandTerms(profile, settings = {}) {
  const b = profile?.business || {};
  const terms = [b.name, b.person?.name, ...(settings.terms || [])].map((t) => clip(t, 80)).filter((t) => t.length > 2);
  return [...new Set(terms.map((t) => t.toLowerCase()))];
}

const hostOf = (u) => {
  try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};

export function ownHosts(profile, settings = {}) {
  const b = profile?.business || {};
  const urls = [...Object.values(b.links || {}), ...(b.person?.sameAs || []), ...(settings.domains || [])];
  return [...new Set(urls.map((u) => hostOf(String(u).trim())).filter(Boolean))];
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pure analysis of one answer: is the brand named, and are its own pages among the sources?
export function analyzeAnswer({ text = '', sources = [] }, terms = [], hosts = []) {
  const hay = String(text).toLowerCase();
  const matchedTerms = terms.filter((t) => new RegExp(`(^|[^a-z0-9])${escRe(t)}([^a-z0-9]|$)`).test(hay));
  const citedUrls = sources.filter((s) => {
    const h = hostOf(s.url);
    return h && hosts.some((o) => h === o || h.endsWith(`.${o}`));
  });
  return {
    mentioned: matchedTerms.length > 0,
    matchedTerms,
    cited: citedUrls.length > 0,
    citedUrls: citedUrls.map((s) => s.url).slice(0, 5),
    sourceCount: sources.length,
  };
}

const trimSources = (sources) => sources.slice(0, 12).map((s) => ({ url: clip(s.url, 300), title: clip(s.title, 120), cited: !!s.cited }));

export function newQuestions(existing, texts) {
  const byText = new Map(existing.map((q) => [q.text.toLowerCase(), q]));
  const out = [];
  for (const t of texts) {
    const text = cleanQuestion(t);
    if (!text || out.some((q) => q.text.toLowerCase() === text.toLowerCase())) continue;
    out.push(byText.get(text.toLowerCase()) || { id: id(), text, addedAt: new Date().toISOString() });
  }
  return out.slice(0, MAX_QUESTIONS);
}

// Latest result per question per engine, so a monthly run replaces the previous status.
export function summarize(data, now = Date.now()) {
  const runs = (data.runs || []).map((r) => (r.status === 'running' && now - Date.parse(r.at) > STALE_RUN_MS ? { ...r, status: 'interrupted' } : r));
  const latest = {};
  for (const r of runs.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    for (const res of r.results || []) {
      const slot = (latest[res.questionId] ||= {});
      // A failed check never replaces an earlier real answer, but is shown when there is none.
      if (!res.answered && slot[r.engine]?.answered) continue;
      slot[r.engine] = { ...res, at: r.at, runId: r.id, manual: !!r.manual };
    }
  }
  const byEngine = {};
  for (const q of data.questions || []) {
    for (const [engine, res] of Object.entries(latest[q.id] || {})) {
      if (!res.answered) continue;
      const e = (byEngine[engine] ||= { label: ENGINES[engine] || engine, answered: 0, mentioned: 0, cited: 0 });
      e.answered += 1;
      if (res.mentioned) e.mentioned += 1;
      if (res.cited) e.cited += 1;
    }
  }
  const history = runs
    .filter((r) => r.status !== 'running')
    .map((r) => ({
      id: r.id, at: r.at, engine: r.engine, manual: !!r.manual, status: r.status,
      asked: (r.results || []).filter((x) => x.answered).length,
      mentioned: (r.results || []).filter((x) => x.mentioned).length,
      cited: (r.results || []).filter((x) => x.cited).length,
    }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    questions: (data.questions || []).map((q) => ({ ...q, latest: latest[q.id] || {} })),
    byEngine, history, runs,
  };
}

// Run every question through Claude with web search, saving after each one so
// the page can show progress. Failures are recorded on the result, never hidden.
export async function runClaudeCheck(store, profile, { search = claudeSearch } = {}) {
  const data = store.get();
  if (!data.questions?.length) throw new Error('add at least one question first');
  const terms = brandTerms(profile, data.settings);
  const hosts = ownHosts(profile, data.settings);
  const run = { id: id(), at: new Date().toISOString(), engine: 'claude_web', status: 'running', results: [], terms, hosts };
  store.update((d) => ({ ...d, runs: [run, ...(d.runs || [])].slice(0, MAX_RUNS) }));
  const patch = (fn) => store.update((d) => ({ ...d, runs: d.runs.map((r) => (r.id === run.id ? fn(r) : r)) }));
  let failures = 0;
  for (const q of data.questions) {
    let result;
    try {
      const out = await search({ question: q.text });
      const a = analyzeAnswer(out, terms, hosts);
      result = { questionId: q.id, answered: true, ...a, excerpt: clip(out.text, 700), sources: trimSources(out.sources) };
    } catch (err) {
      failures += 1;
      result = { questionId: q.id, answered: false, error: clip(err.message, 240) };
    }
    patch((r) => ({ ...r, results: [...r.results, result] }));
  }
  const finished = new Date().toISOString();
  patch((r) => ({ ...r, status: failures === data.questions.length ? 'failed' : failures ? 'partial' : 'complete', finishedAt: finished }));
  store.update((d) => ({ ...d, settings: { ...(d.settings || {}), lastRunAt: finished } }));
  return store.get().runs.find((r) => r.id === run.id);
}

// A pasted answer from another assistant (ChatGPT, Perplexity, Gemini...).
export function recordManual(store, profile, { questionId, engine, answer, sources }) {
  const data = store.get();
  if (!data.questions.some((q) => q.id === questionId)) throw new Error('unknown question');
  if (!ENGINES[engine]) throw new Error('unknown assistant');
  const text = String(answer || '').slice(0, 6000);
  if (text.trim().length < 20) throw new Error('paste the assistant\'s answer');
  const srcList = String(sources || '').split(/\s+/).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20).map((url) => ({ url, title: '', cited: true }));
  const a = analyzeAnswer({ text, sources: srcList }, brandTerms(profile, data.settings), ownHosts(profile, data.settings));
  const run = {
    id: id(), at: new Date().toISOString(), engine, manual: true, status: 'complete',
    results: [{ questionId, answered: true, ...a, excerpt: clip(text, 700), sources: trimSources(srcList) }],
  };
  store.update((d) => ({ ...d, runs: [run, ...(d.runs || [])].slice(0, MAX_RUNS) }));
  return run;
}

const SUGGEST_SYSTEM = `You write the fixed set of buyer questions a business will track in AI assistants over time.
Rules: questions a real prospective customer or client would type into an assistant, in plain language. Mix: 3 that name the business or person directly, 4 about the problem the business solves, 3 location or niche specific. No question may mention, compare, or criticize any other business, agency, supplier, website, or platform. Never use the words listed in neverMention. Never use em dashes or en dashes. Each question under 140 characters.
Return JSON only: {"questions": ["...", "..."]}`;

export async function suggestQuestions(profile) {
  const b = profile?.business || {};
  const ctx = {
    name: b.name, person: b.person?.name, industry: b.industry, niche: b.niche, location: b.location,
    audience: b.audience, offers: b.offers, neverMention: b.neverMention || [],
  };
  const out = await claudeJson({
    system: SUGGEST_SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(ctx) }],
    maxTokens: 900, tier: 'light', usageBucket: 'ledger-suggest',
  });
  const banned = (b.neverMention || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  return (out.questions || [])
    .map(cleanQuestion)
    .filter((q) => q && !banned.some((w) => new RegExp(`\\b${escRe(w)}\\b`, 'i').test(q)))
    .slice(0, 12);
}
