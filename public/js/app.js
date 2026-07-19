import { api, appState } from './api.js';
import { el, toast, spinner } from './ui.js';
import { renderInterview, renderVoice } from './interview.js';
import { renderLibrary } from './media.js';
import { renderStrategy } from './strategy.js';
import { renderCreate } from './create.js';
import { renderVoiceStudio, renderAvatarStudio } from './studios.js';

const ROUTES = [
  { path: 'dashboard', label: 'Dashboard', icon: '◈', render: renderDashboard },
  { path: 'interview', label: 'Story Interview', icon: '✦', render: renderInterview },
  { path: 'voice-dna', label: 'Voice DNA', icon: '𝔸', render: renderVoice },
  { path: 'library', label: 'Media Library', icon: '▣', render: renderLibrary },
  { path: 'strategy', label: 'Pillars & Series', icon: '≋', render: renderStrategy },
  { path: 'create', label: 'Create', icon: '⚡', render: renderCreate },
  { path: 'voice-studio', label: 'Voice Studio', icon: '🎙', render: renderVoiceStudio },
  { path: 'avatar-studio', label: 'Avatar Studio', icon: '🎬', render: renderAvatarStudio },
];

function currentPath() {
  return (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0];
}

function currentParams() {
  return new URLSearchParams(location.hash.split('?')[1] || '');
}

function workspaceSwitcher() {
  const ws = appState.workspaces || { items: [], activeId: null };
  const select = el('select', {
    class: 'input select ws-select',
    onchange: async (e) => {
      if (e.target.value === '__new__') {
        const name = prompt('Name the new business workspace (e.g. "Travel GHR" or "RE/MAX Alliance"):');
        if (!name) { e.target.value = ws.activeId; return; }
        appState.workspaces = await api.createWorkspace(name);
      } else {
        appState.workspaces = await api.activateWorkspace(e.target.value);
      }
      await appState.reloadWorkspace();
      toast(`Switched to ${appState.workspaces.items.find((w) => w.id === appState.workspaces.activeId)?.name || 'workspace'}`);
      route();
    },
  },
    ws.items.map((w) => {
      const o = el('option', { value: w.id }, w.name);
      if (w.id === ws.activeId) o.selected = true;
      return o;
    }),
    el('option', { value: '__new__' }, '＋ New business…'));
  return el('div', { class: 'ws-switcher', title: 'Each business gets its own profile, voice, library, and packages' }, select);
}

function renderNav() {
  const nav = document.getElementById('nav');
  const path = currentPath();
  const p = appState.health?.providers || {};
  nav.replaceChildren(
    el('div', { class: 'brand' },
      el('span', { class: 'brand-mark' }, '◆'),
      el('div', {},
        el('strong', {}, 'ContentStudio'),
        el('span', { class: 'brand-sub' }, 'AI Visibility Engine'))),
    workspaceSwitcher(),
    el('div', { class: 'nav-links' },
      ROUTES.map((r) => el('a', {
        class: `nav-link ${r.path === path ? 'active' : ''}`,
        href: `#/${r.path}`,
      }, el('span', { class: 'nav-icon' }, r.icon), el('span', { class: 'nav-label' }, r.label)))),
    el('div', { class: 'provider-dots' },
      dot('Claude', p.anthropic), dot('ElevenLabs', p.elevenlabs), dot('HeyGen', p.heygen)),
  );
}

const dot = (name, on) => el('span', { class: `pdot ${on ? 'on' : ''}`, title: `${name}: ${on ? 'connected' : 'no key'}` }, name);

function route() {
  const path = currentPath();
  const r = ROUTES.find((x) => x.path === path) || ROUTES[0];
  renderNav();
  r.render(document.getElementById('view'), currentParams());
  window.scrollTo(0, 0);
}

function renderDashboard(root) {
  const profile = appState.profile;
  const p = appState.health?.providers || {};
  const steps = [
    { done: !!profile.interview?.brief, label: 'Run the Story Interview', hint: 'Your goals, proof, and audience truth become the Story Brief.', href: '#/interview' },
    { done: !!(profile.voiceDna?.summary?.voiceSummary), label: 'Upload your MD profile files', hint: 'The studio fingerprints your voice so nothing sounds like AI.', href: '#/voice-dna' },
    { done: false, label: 'Import photos & videos', hint: 'From your iPhone photo library — analyzed, tagged, alt-texted.', href: '#/library', mediaStep: true },
    { done: !!(profile.pillars?.length), label: 'Design pillars & series', hint: 'The architecture algorithms and audiences learn to expect.', href: '#/strategy' },
    { done: false, label: 'Generate your first package', hint: '12 platform-native assets from one topic.', href: '#/create', pkgStep: true },
  ];

  const container = el('div', { class: 'view' },
    el('div', { class: 'hero' },
      el('h1', {}, profile.business?.name ? `Welcome back, ${profile.business.person?.name?.split(' ')[0] || profile.business.name}.` : 'Build content AI engines recommend.'),
      el('p', { class: 'sub' },
        'ContentStudio designs storytelling that exceeds E-E-A-T and wins the new surface: being the answer AI assistants give. Interview → Voice DNA → Library → Architecture → 12-platform packages with full metadata.'),
      !profile.business?.name ? el('div', { class: 'row gap' },
        el('a', { class: 'btn btn-primary btn-lg', href: '#/interview' }, 'Start the interview'),
        el('button', {
          class: 'btn btn-ghost', onclick: async () => {
            await api.loadDemo();
            appState.state = await api.state();
            toast('Demo profile loaded — explore, then run your own interview');
            route();
          },
        }, 'Load demo profile')) : null),
    el('div', { class: 'card' },
      el('h2', {}, 'Setup path'),
      el('div', { class: 'steps-list' }, steps.map((s) => el('a', { class: `setup-step ${s.done ? 'done' : ''}`, href: s.href },
        el('span', { class: 'check-mark' }, s.done ? '✓' : '○'),
        el('div', {}, el('strong', {}, s.label), el('p', { class: 'muted' }, s.hint)))))),
    el('div', { class: 'grid-2' },
      el('div', { class: 'card' },
        el('h2', {}, 'Provider status'),
        el('p', { class: 'intro' }, 'Keys live in the server .env — never in the browser.'),
        providerRow('Claude (generation, vision, strategy)', p.anthropic, p.model),
        providerRow('ElevenLabs (voice cloning + narration)', p.elevenlabs),
        providerRow('HeyGen (photoreal avatar video)', p.heygen)),
      el('div', { class: 'card' },
        el('h2', {}, 'Your API'),
        el('p', { class: 'intro' }, 'This studio is a standalone service. Anything you can click, another tool can call:'),
        el('pre', { class: 'asset-value code' },
`POST /api/generate        {topic, platforms[], mediaIds[]}
GET  /api/packages        list packages + scores
POST /api/media/:id/analyze   AI alt text + keywords
POST /api/voice/tts       narration mp3
POST /api/avatar/generate avatar video
GET  /llms.txt            live AI-crawler manifest`),
        el('p', { class: 'muted' }, 'Full reference in README.md.'))));

  api.media().then(({ items }) => {
    if (items.length) {
      const stepEl = container.querySelectorAll('.setup-step')[2];
      stepEl?.classList.add('done');
      stepEl?.querySelector('.check-mark')?.replaceChildren('✓');
    }
  });
  api.packages().then(({ items }) => {
    if (items.length) {
      const stepEl = container.querySelectorAll('.setup-step')[4];
      stepEl?.classList.add('done');
      stepEl?.querySelector('.check-mark')?.replaceChildren('✓');
    }
  });

  root.replaceChildren(container);
}

const providerRow = (label, on, extra) => el('div', { class: 'provider-row' },
  el('span', { class: `pdot ${on ? 'on' : ''}` }, on ? '●' : '○'),
  el('span', {}, label),
  el('span', { class: 'muted' }, on ? (extra || 'connected') : 'add key in .env'));

async function boot() {
  const view = document.getElementById('view');
  view.replaceChildren(spinner('Waking the studio…'));
  try {
    await appState.boot();
  } catch (err) {
    view.replaceChildren(el('div', { class: 'empty' },
      el('h3', {}, 'Cannot reach the studio API'),
      el('p', {}, `Start the server with "npm start" and reload. (${err.message})`)));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

boot();
