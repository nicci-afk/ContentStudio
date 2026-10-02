import { api, appState } from './api.js';
import { el, toast, spinner, emptyState } from './ui.js';

const uid = () => Math.random().toString(36).slice(2, 10);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not scheduled');

// Content Plan: per-business autopilot drafting. The studio drafts into the
// approval queue; the creator reviews, approves, and posts from Publish Run.
export function renderPlan(root) {
  const container = el('div', { class: 'view' }, spinner('Loading the plan…'));
  root.replaceChildren(container);

  let plan = null;
  let meta = { factLabels: [], maxPerRun: 3, dailyCap: 6, running: false };
  let queue = null;
  let busy = false;

  const select = (options, current, onchange, cls = 'input select') => {
    const s = el('select', { class: cls, onchange: (e) => onchange(e.target.value) },
      options.map(([value, label]) => {
        const o = el('option', { value }, label);
        if (String(value) === String(current)) o.selected = true;
        return o;
      }));
    return s;
  };

  const save = async (quiet) => {
    const res = await api.savePlan(plan);
    plan = res.plan;
    appState.state.profile.contentPlan = plan;
    if (!quiet) toast('Plan saved');
  };

  const loadQueue = async () => {
    queue = await api.planQueue();
    drawQueue();
  };

  const runNow = async (itemId) => {
    if (busy) return;
    busy = true;
    try {
      await save(true);
      const start = await api.runPlan(itemId);
      if (!start.ran) { toast(start.reason || 'Nothing to run', 'err'); return; }
      toast('Drafting started. This can take a few minutes.');
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const job = await api.planRunStatus(start.jobId);
        if (job.status === 'running') continue;
        if (job.status === 'error') throw new Error(job.error);
        const r = job.result || {};
        if (!r.ran) toast(r.reason || 'Nothing drafted', 'err');
        else if (r.errors?.length) toast(`Drafting failed: ${r.errors[0].error}`, 'err');
        else toast(r.drafted.length ? `${r.drafted.length} draft${r.drafted.length === 1 ? '' : 's'} added to the queue` : (r.skipped[0]?.reason || r.reason || 'Nothing to draft'));
        break;
      }
      const fresh = await api.plan();
      plan = fresh.plan;
      appState.state.profile.contentPlan = plan;
      draw();
      await loadQueue();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      busy = false;
    }
  };

  // ---- cards -------------------------------------------------------------

  const enableCard = () => el('div', { class: 'card' },
    el('h2', {}, 'Autopilot drafting'),
    el('p', { class: 'intro' },
      `Off by default. When on, the studio drafts the next queued topic of each due item into your approval queue, at most ${meta.maxPerRun} per run and ${meta.dailyCap} per day for this business. Each draft is a full generation (one Claude call per platform plus the answer layer), so it uses real tokens. It never approves and never posts anything: you review every draft, approve it, and post from Publish Run yourself.`),
    el('label', { class: 'row gap', style: 'cursor:pointer' },
      el('input', {
        type: 'checkbox', ...(plan.enabled ? { checked: '' } : {}),
        onchange: async (e) => { plan.enabled = e.target.checked; await save(); draw(); },
      }),
      el('strong', {}, plan.enabled ? 'Drafting is ON for this business' : 'Drafting is off'),
    ),
    !appState.health?.providers?.anthropic ? el('p', { class: 'muted' }, 'No Claude key is configured on the server, so nothing can be drafted yet.') : null);

  const factsCard = () => {
    const rows = plan.facts.map((f, i) => el('div', { class: 'plan-fields' },
      el('input', { class: 'input', style: 'flex:3 1 220px', placeholder: 'A fact the studio may assert', value: f.text, oninput: (e) => { f.text = e.target.value; } }),
      select(meta.factLabels.map((l) => [l, l]), f.label, (v) => { f.label = v; }),
      el('input', { class: 'input', placeholder: 'Source (link, file, name)', value: f.source, oninput: (e) => { f.source = e.target.value; } }),
      el('button', { class: 'btn btn-danger btn-xs', onclick: () => { plan.facts.splice(i, 1); draw(); } }, 'Remove')));
    return el('div', { class: 'card' },
      el('h2', {}, 'Approved facts'),
      el('p', { class: 'intro' }, 'When this list has anything in it, drafts may assert only these facts about the destination or the business. Anything else is left out or named as missing. Leave it empty to keep generation exactly as it is today.'),
      ...rows,
      el('div', { class: 'row gap' },
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { plan.facts.push({ id: uid(), text: '', source: '', label: meta.factLabels[2] }); draw(); } }, '＋ Add a fact'),
        el('button', { class: 'btn btn-primary btn-xs', onclick: () => save().then(draw) }, 'Save facts')));
  };

  const itemCard = (item) => {
    const cad = item.cadence;
    const platformChips = el('div', { class: 'chip-row' }, appState.platforms.map((p) => {
      const chip = el('button', {
        class: `chip chip-toggle ${item.platformIds.includes(p.id) ? 'on' : ''}`, type: 'button',
        onclick: () => {
          item.platformIds = item.platformIds.includes(p.id) ? item.platformIds.filter((x) => x !== p.id) : [...item.platformIds, p.id];
          chip.classList.toggle('on');
        },
      }, p.label);
      return chip;
    }));
    const topicRows = item.topics.map((t, i) => el('div', { class: 'plan-topic' },
      el('input', { class: 'input', placeholder: 'Topic', value: t.topic, disabled: t.status === 'drafted' ? '' : null, oninput: (e) => { t.topic = e.target.value; } }),
      el('input', { class: 'input', placeholder: 'Angle (optional)', value: t.angle || '', oninput: (e) => { t.angle = e.target.value; } }),
      el('span', { class: 'plan-status' }, t.status),
      t.packageId ? el('a', { class: 'btn btn-ghost btn-xs', href: `#/create?pkg=${t.packageId}` }, 'Open draft') : null,
      t.status === 'queued'
        ? el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { t.status = 'skipped'; draw(); } }, 'Skip')
        : t.status === 'skipped' ? el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { t.status = 'queued'; draw(); } }, 'Re-queue') : null,
      el('button', { class: 'btn btn-danger btn-xs', onclick: () => { item.topics.splice(i, 1); draw(); } }, 'Remove')));
    const queued = item.topics.filter((t) => t.status === 'queued').length;
    return el('div', { class: 'plan-item' },
      el('div', { class: 'plan-fields' },
        el('input', { class: 'input', style: 'flex:2 1 200px', placeholder: 'Item name (e.g. Weekly LinkedIn article)', value: item.title, oninput: (e) => { item.title = e.target.value; } }),
        select([['weekly', 'Weekly'], ['daily', 'Daily'], ['manual', 'Manual only']], cad.type, (v) => {
          item.cadence = v === 'manual' ? { type: v } : { type: v, hour: cad.hour ?? 9, ...(v === 'weekly' ? { weekday: cad.weekday ?? 1 } : {}) };
          draw();
        }),
        cad.type === 'weekly' ? select(WEEKDAYS.map((d, i) => [i, d]), cad.weekday ?? 1, (v) => { cad.weekday = Number(v); }) : null,
        cad.type !== 'manual' ? select(Array.from({ length: 24 }, (_, h) => [h, `${String(h).padStart(2, '0')}:00 UTC`]), cad.hour ?? 9, (v) => { cad.hour = Number(v); }) : null,
        select(Array.from({ length: meta.maxPerRun }, (_, n) => [n + 1, `${n + 1} per run`]), item.maxPerRun, (v) => { item.maxPerRun = Number(v); })),
      el('span', { class: 'field-label' }, 'Platforms for this item'),
      platformChips,
      el('span', { class: 'field-label' }, `Topic queue (${queued} queued)`),
      ...topicRows,
      el('div', { class: 'row gap' },
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { item.topics.push({ id: uid(), topic: '', status: 'queued' }); draw(); } }, '＋ Add a topic'),
        el('button', { class: 'btn btn-primary btn-xs', onclick: () => save().then(draw) }, 'Save'),
        el('button', {
          class: 'btn btn-ghost btn-xs', disabled: !plan.enabled ? '' : null,
          title: plan.enabled ? 'Draft the next queued topic now' : 'Switch drafting on first',
          onclick: () => runNow(item.id),
        }, 'Run now'),
        el('button', { class: 'btn btn-danger btn-xs', onclick: () => { plan.items = plan.items.filter((x) => x.id !== item.id); draw(); } }, 'Delete item')),
      el('p', { class: 'muted' },
        `Last run: ${item.lastRunAt ? when(item.lastRunAt) : 'never'} · Next due: ${cad.type === 'manual' ? 'manual only' : when(item.nextDueAt)}`),
      item.lastError ? el('p', { class: 'plan-blocker' }, `Last run failed: ${item.lastError}`) : null);
  };

  const itemsCard = () => el('div', { class: 'card' },
    el('h2', {}, 'Plan items'),
    el('p', { class: 'intro' }, 'An item is a platform set on a rhythm with a queue of topics. Times are server time (UTC).'),
    plan.items.length ? plan.items.map(itemCard) : emptyState('No items yet', 'Add one to give the plan something to draft.'),
    el('div', { class: 'row gap' },
      el('button', {
        class: 'btn btn-ghost btn-xs',
        onclick: () => {
          plan.items.push({ id: uid(), title: '', platformIds: [], cadence: { type: 'weekly', weekday: 1, hour: 9 }, maxPerRun: 1, topics: [] });
          draw();
        },
      }, '＋ Add an item'),
      el('button', { class: 'btn btn-primary btn-xs', onclick: () => save().then(draw) }, 'Save plan')));

  const queueBox = el('div', { class: 'card' });
  function drawQueue() {
    const q = queue;
    const row = (d, extra) => el('div', { class: 'plan-queue-row' },
      el('div', { class: 'row spread' },
        el('strong', {}, d.topic),
        el('span', { class: 'muted' }, `${d.itemTitle || 'plan item'} · score ${d.score ?? 'n/a'}`)),
      el('p', { class: 'muted' }, d.platformIds.join(', ')),
      ...(d.blockers || []).map((b) => el('p', { class: 'plan-blocker' }, `Blocker${b.platformId ? ` (${b.platformId})` : ''}: ${b.message}`)),
      ...(d.warnings || []).map((w) => el('p', { class: 'plan-warning' }, `Heads up: ${w.message}`)),
      el('div', { class: 'row gap' }, extra));
    queueBox.replaceChildren(...[
      el('h2', {}, 'Queue'),
      !q ? spinner('Loading the queue…') : [
        el('span', { class: 'field-label' }, `Drafts awaiting your approval (${q.drafts.length})`),
        q.drafts.length ? q.drafts.map((d) => row(d, [
          el('span', { class: 'plan-status' }, d.ready ? 'ready to review' : 'blocked'),
          el('a', { class: 'btn btn-primary btn-xs', href: `#/create?pkg=${d.packageId}` }, 'Review and approve'),
        ])) : el('p', { class: 'muted' }, 'Nothing waiting.'),
        el('span', { class: 'field-label', style: 'display:block;margin-top:14px' }, `Approved, not yet published (${q.approved.length})`),
        q.approved.length ? q.approved.map((d) => row(d, [
          el('a', { class: 'btn btn-primary btn-xs', href: d.publishLink }, 'Open Publish Run'),
        ])) : el('p', { class: 'muted' }, 'Nothing approved and waiting.'),
        el('span', { class: 'field-label', style: 'display:block;margin-top:14px' }, 'Due soon'),
        q.dueSoon.length ? q.dueSoon.map((d) => el('p', { class: 'muted' },
          `${d.title}: ${d.overdue ? 'due now' : when(d.nextDueAt)} · ${d.queued} topic${d.queued === 1 ? '' : 's'} queued`))
          : el('p', { class: 'muted' }, 'Nothing due in the next 48 hours.'),
      ]].flat(Infinity).filter(Boolean));
  }

  function draw() {
    container.replaceChildren(
      el('div', { class: 'view-head' },
        el('div', {},
          el('h1', {}, 'Content Plan'),
          el('p', { class: 'sub' }, `Drafts for ${appState.profile.business?.name || 'this business'} land here for your review. You approve and post; the studio never does.`))),
      enableCard(), factsCard(), itemsCard(), queueBox);
    drawQueue();
  }

  api.plan().then((res) => {
    plan = res.plan;
    meta = res;
    appState.state.profile.contentPlan = plan;
    draw();
    loadQueue().catch((err) => toast(err.message, 'err'));
  }).catch((err) => container.replaceChildren(emptyState('Could not load the plan', err.message)));
}
