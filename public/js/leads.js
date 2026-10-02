import { api } from './api.js';
import { el, toast, copyText, spinner } from './ui.js';

const TIER_COLOR = { A: '#1f9d55', B: '#c7891a', C: '#8a8f98' };
const badge = (tier) => el('span', {
  style: `display:inline-block;min-width:22px;text-align:center;padding:2px 8px;border-radius:999px;font-weight:700;font-size:12px;color:#fff;background:${TIER_COLOR[tier] || '#8a8f98'}`,
  title: 'Triage score. It orders your follow-up and never rejects anyone.',
}, tier || '?');

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

export async function renderLeads(root) {
  root.replaceChildren(el('div', { class: 'view' }, spinner()));
  let data;
  try { data = await api.leads(); } catch (err) {
    root.replaceChildren(el('div', { class: 'view' }, el('p', { class: 'muted' }, `Could not load leads: ${err.message}`)));
    return;
  }
  const state = { tier: '', status: '', stage: '' };
  const view = el('div', { class: 'view' });
  const listHost = el('div', {});

  const s = data.summary;
  const stat = (label, value) => el('div', { class: 'card', style: 'flex:1;min-width:110px;text-align:center' },
    el('div', { style: 'font-size:28px;font-weight:700' }, String(value ?? 0)), el('div', { class: 'muted' }, label));

  const drawList = () => {
    const rows = data.items
      .filter((l) => !state.tier || l.score?.tier === state.tier)
      .filter((l) => !state.status || l.status === state.status)
      .filter((l) => !state.stage || l.stage === state.stage);
    if (!rows.length) {
      listHost.replaceChildren(el('p', { class: 'muted' }, data.items.length
        ? 'No leads match those filters.'
        : 'No leads yet. Connect your Google Form below, and each application will appear here.'));
      return;
    }
    listHost.replaceChildren(el('div', { style: 'overflow-x:auto' }, el('table', { class: 'table', style: 'width:100%;border-collapse:collapse' },
      el('thead', {}, el('tr', {}, ['Date', 'Lead', 'Tier', 'Status', 'Source', 'Experience', 'Sells', ''].map((h) => el('th', { style: 'text-align:left;padding:6px 8px' }, h)))),
      el('tbody', {}, rows.map((l) => {
        const name = `${l.firstName} ${l.lastName}`.trim() || l.email;
        const status = el('select', {
          class: 'input select', style: 'min-width:110px',
          onchange: async (e) => { await api.leadUpdate(l.id, { status: e.target.value }); l.status = e.target.value; toast('Status saved'); },
        }, data.statuses.map((x) => { const o = el('option', { value: x }, x); if (x === l.status) o.selected = true; return o; }));
        return el('tr', { style: 'border-top:1px solid var(--line, #2a2f3a)' },
          el('td', { style: 'padding:8px;white-space:nowrap' }, fmt(l.createdAt), l.test ? el('div', { class: 'muted' }, 'test') : null),
          el('td', { style: 'padding:8px' },
            el('div', { style: 'font-weight:600' }, name),
            el('a', { href: `mailto:${l.email}`, style: 'color:#9db4ff' }, l.email),
            l.phone ? el('div', { class: 'muted' }, l.phone) : null,
            l.cityState ? el('div', { class: 'muted' }, l.cityState) : null),
          el('td', { style: 'padding:8px', title: (l.score?.reasons || []).join('\n') }, badge(l.score?.tier)),
          el('td', { style: 'padding:8px' }, status),
          el('td', { style: 'padding:8px' },
            el('div', { style: 'font-weight:600' }, l.stage === 'application' ? 'Applied' : 'Resource'),
            (l.resources || []).length ? el('div', { class: 'muted' }, l.resources.join(', ')) : null,
            l.channel ? el('div', { class: 'muted' }, l.channel) : null,
            (l.sequence?.sent || []).length ? el('div', { class: 'muted' }, `${l.sequence.sent.length} follow-up${l.sequence.sent.length > 1 ? 's' : ''} sent`) : null,
            l.unsubscribed ? el('div', { class: 'muted' }, 'unsubscribed') : null),
          el('td', { style: 'padding:8px' }, l.yearsAdvisor),
          el('td', { style: 'padding:8px;max-width:220px' }, (l.niche || []).join(', ')),
          el('td', { style: 'padding:8px;white-space:nowrap' },
            el('button', {
              class: 'btn btn-ghost btn-xs', title: l.notes || 'Add a note',
              onclick: async () => {
                const note = prompt('Note for this lead:', l.notes || '');
                if (note === null) return;
                await api.leadUpdate(l.id, { notes: note }); l.notes = note; toast('Note saved'); drawList();
              },
            }, l.notes ? '✎ note' : '＋ note'),
            ' ',
            el('button', {
              class: 'btn btn-ghost btn-xs', title: 'Delete this lead (use for deletion requests)',
              onclick: async () => {
                if (!confirm(`Permanently delete ${name}?`)) return;
                await api.leadDelete(l.id);
                data.items = data.items.filter((x) => x.id !== l.id);
                toast('Lead deleted'); drawList();
              },
            }, '🗑')));
      })))));
  };

  const filter = (label, key, options) => el('select', {
    class: 'input select', style: 'width:auto;min-width:160px', onchange: (e) => { state[key] = e.target.value; drawList(); },
  }, el('option', { value: '' }, label), options.map((o) => el('option', { value: o }, o)));

  // ---- setup card ----
  const emailInput = el('input', { class: 'input', type: 'email', placeholder: 'you@example.com', value: data.settings.notifyEmail || '' });
  const scriptHost = el('div', {});
  const capi = data.settings.capi;
  const setup = el('div', { class: 'card' },
    el('h2', {}, 'Connect your application Form'),
    el('p', { class: 'muted' }, 'Every application is also sent here, scored A, B or C, and emailed to you. Your Google Sheet and dashboard stay exactly as they are. Only a short list of fields is sent. Allergy, dietary and accessibility answers and the long written answers never leave your Sheet.'),
    el('div', { class: 'row gap' },
      el('label', { style: 'flex:1' }, 'Email new leads to', emailInput),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try { await api.leadSettings({ notifyEmail: emailInput.value }); toast('Saved'); } catch (err) { toast(err.message, 'err'); }
        },
      }, 'Save')),
    el('div', { style: 'margin-top:12px' },
      el('button', {
        class: 'btn btn-ghost',
        onclick: async () => {
          const { appsScript } = await api.leadSetup();
          const box = el('textarea', { class: 'input', style: 'width:100%;height:260px;font-family:monospace;font-size:12px', readonly: true }, appsScript);
          scriptHost.replaceChildren(
            el('ol', { class: 'muted' },
              el('li', {}, 'Open the Google Sheet that receives your Form responses.'),
              el('li', {}, 'Extensions, then Apps Script. Delete any starter code and paste the script below. Save.'),
              el('li', {}, 'Run testBridge once and approve the permissions. You should get a [TEST] email within a minute, and a test row appears here.'),
              el('li', {}, 'Open Triggers (clock icon), Add Trigger, choose onFormSubmit, From spreadsheet, On form submit. Save.')),
            box,
            el('button', { class: 'btn btn-ghost btn-xs', onclick: () => copyText(appsScript, 'Script copied') }, 'Copy script'),
            el('p', { class: 'muted' }, 'This script holds a secret key. Keep it inside your Sheet and do not share it.'));
        },
      }, 'Get the bridge script'),
      scriptHost),
    el('h3', { style: 'margin-top:18px' }, 'Free resources'),
    el('p', { class: 'muted' }, (data.settings.resources || []).length
      ? `Ready to deliver: ${data.settings.resources.map((r) => r.title).join('; ')}. A visitor signs up on your site, gets the file by email with a private link, and is recorded here with their consent. Every email carries a one-click unsubscribe.`
      : 'No resources are set up for this business yet.'),
    el('h3', { style: 'margin-top:18px' }, 'Meta events'),
    el('p', { class: 'muted' },
      capi.tokenSet ? `Server connection is on for pixel ${capi.pixelId || '(none on the profile)'}${capi.testMode ? ' (test mode)' : ''}. A Lead event (free resource) or SubmitApplication event (application) goes to Meta only for people who gave advertising consent, with a hashed email and nothing else.`
        : 'Not connected. When you add a Meta access token on the server, a Lead event will be sent for consenting applicants only. Until then nothing is sent to Meta.'),
    el('p', { class: 'muted' }, 'To make this work, add one optional checkbox question to your Form: "I agree to be contacted about this business and to my information being used to measure our advertising." Without it, no Meta event is ever sent.'));

  const seq = data.settings.sequence || { enabled: false, steps: [] };
  const seqToggle = el('input', { type: 'checkbox', checked: seq.enabled ? true : null, onchange: async (e) => {
    const on = e.target.checked;
    if (on && !confirm('Turn on follow-up emails? Everyone who signed up for a free resource will receive the emails below on this schedule, only between 9am and 6pm Central. Anyone who unsubscribes, applies, or is marked applied, won or lost stops receiving them.')) { e.target.checked = false; return; }
    try { await api.leadSettings({ sequenceEnabled: on }); toast(on ? 'Follow-up emails are on' : 'Follow-up emails are off'); } catch (err) { e.target.checked = !on; toast(err.message, 'err'); }
  } });
  const sequenceCard = el('div', { class: 'card' },
    el('h2', {}, 'Follow-up emails'),
    el('p', { class: 'muted' }, 'A short series sent after someone downloads a free resource. It is OFF until you turn it on. Preview any email to your notification address first. Each email carries your address and a one click unsubscribe.'),
    el('label', { style: 'display:flex;gap:10px;align-items:center;margin:8px 0 12px' }, seqToggle, el('strong', {}, 'Send follow-up emails')),
    seq.steps.length ? el('table', { style: 'width:100%;border-collapse:collapse' }, el('tbody', {}, seq.steps.map((st) => el('tr', { style: 'border-top:1px solid var(--line, #2a2f3a)' },
      el('td', { style: 'padding:8px;white-space:nowrap' }, `Day ${st.day}`),
      el('td', { style: 'padding:8px' }, st.subject),
      el('td', { style: 'padding:8px;text-align:right' }, el('button', { class: 'btn btn-ghost btn-xs', onclick: async (e) => {
        e.target.disabled = true;
        try { await api.leadSequenceTest(st.day); toast('Preview sent to your notification email'); } catch (err) { toast(err.message, 'err'); }
        e.target.disabled = false;
      } }, 'Send me a preview')))))) : el('p', { class: 'muted' }, 'No follow-up emails are set up for this business.'));

  view.append(
    el('div', { class: 'hero' }, el('h1', {}, 'Leads'), el('p', { class: 'sub' }, 'Applications and sign-ups for this business, scored so you can reach the strongest first.')),
    el('div', { class: 'row gap', style: 'flex-wrap:wrap' },
      stat('Total', s.total), stat('Applied', s.byStage?.application), stat('Resource', s.byStage?.resource), stat('A', s.byTier?.A), stat('B', s.byTier?.B), stat('C', s.byTier?.C), stat('New', s.byStatus?.new)),
    el('div', { class: 'card' },
      el('div', { class: 'row gap', style: 'margin-bottom:10px' }, filter('All tiers', 'tier', ['A', 'B', 'C']), filter('All statuses', 'status', data.statuses), filter('All sources', 'stage', ['resource', 'application'])),
      listHost),
    sequenceCard,
    setup);
  root.replaceChildren(view);
  drawList();
}
