// Editor: Claude plans a cut from your own library, you change any row, and the
// studio renders it. Also holds templates (a pattern's structure, never its
// footage) and trend watch (public short-form metadata, never anyone's media).
// Everything is per brand.

import { api, appState } from './api.js';
import { el, toast, spinner, copyBtn, emptyState, field, textInput, textArea, download } from './ui.js';

const mb = (n) => `${Math.round((n || 0) / 1e5) / 10} MB`;
const TRANSITIONS = ['cut', 'fade', 'dissolve', 'slideleft', 'slideright', 'slideup', 'fadeblack'];
const TEXT_STYLES = ['hook', 'caption', 'label', 'cta'];
const POSITIONS = ['top', 'middle', 'bottom', 'lower-third'];
const ANIMATE = ['pop', 'fade', 'none'];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export async function renderEditor(root, params) {
  const container = el('div', { class: 'view' });
  root.replaceChildren(container);
  const id = params?.get('edit');
  if (id) return drawProject(container, id, params.get('tpl') || '');
  return drawHome(container, params?.get('tab') || 'projects');
}

const select = (options, value, onchange, label = (x) => x) => {
  const s = el('select', { class: 'input select', style: 'width:auto', onchange: (e) => onchange(e.target.value) },
    options.map((o) => el('option', { value: o }, label(o))));
  s.value = String(value);
  return s;
};
const numInput = (value, onchange, step = 0.1, w = 70) => el('input', {
  class: 'input', type: 'number', step, style: `width:${w}px`, value, onchange: (e) => onchange(Number(e.target.value)),
});

// ---- home: projects, templates, trend watch ---------------------------------------------

async function drawHome(container, tab) {
  const body = el('div', {});
  const tabs = [['projects', 'Projects'], ['templates', 'Templates'], ['trends', 'Trend watch']];
  const head = el('div', { class: 'view-head' },
    el('div', {},
      el('h1', {}, 'Editor'),
      el('p', { class: 'sub' }, 'Claude plans a vertical cut from your own photos and videos, you adjust any part, and the studio renders it. Post the result natively, add the trending sound in the app, or send it straight down the YouTube Short pipeline.')));
  const tabRow = el('div', { class: 'tab-row' }, tabs.map(([k, label]) => el('button', { class: `tab ${tab === k ? 'active' : ''}`, onclick: () => { location.hash = `#/editor?tab=${k}`; } }, label)));
  container.replaceChildren(head, tabRow, body);
  body.append(spinner('Loading…'));
  try {
    if (tab === 'templates') await drawTemplates(body);
    else if (tab === 'trends') await drawTrends(body);
    else await drawProjects(body);
  } catch (err) { body.replaceChildren(el('p', { class: 'warn' }, err.message)); }
}

async function drawProjects(body) {
  const { items } = await api.edits();
  const title = textInput({ placeholder: 'Name this edit (for example: Akumal sunrise)', style: 'flex:1;min-width:220px' });
  body.replaceChildren(
    el('div', { class: 'card' },
      el('h2', {}, 'New edit'),
      el('div', { class: 'row gap' }, title, el('button', {
        class: 'btn btn-primary', onclick: async () => {
          try { const { edit } = await api.createEdit({ title: title.value || 'New edit' }); location.hash = `#/editor?edit=${edit.id}`; } catch (err) { toast(err.message, 'err'); }
        },
      }, '✂ Start'))),
    el('div', { class: 'card' },
      el('h2', {}, 'Your edits'),
      items.length ? el('div', { class: 'pkg-list' }, items.map((e) => el('button', { class: 'pkg-row', onclick: () => { location.hash = `#/editor?edit=${e.id}`; } },
        el('span', { class: 'pkg-topic' }, e.title),
        el('span', { class: 'muted' }, `${e.status} · ${e.clips} clips · ${Math.round(e.seconds)}s`),
        el('span', { class: 'muted' }, new Date(e.updatedAt).toLocaleDateString()))))
        : emptyState('No edits yet', 'Start one above, or use a template or a trend idea.')));
}

// -- templates

async function drawTemplates(body) {
  const { items } = await api.templates();
  const mine = items.filter((t) => !t.readOnly);
  const starters = items.filter((t) => t.readOnly);
  const row = (t) => el('div', { class: 'asset-field' },
    el('div', { class: 'row spread' },
      el('span', { class: 'field-label' }, `${t.name}${t.source === 'reference' ? ' · read from a reference reel' : t.source === 'notes' ? ' · from your notes' : ''}`),
      el('div', { class: 'row gap' },
        el('button', {
          class: 'btn btn-primary btn-xs', onclick: async () => {
            try { const { edit } = await api.createEdit({ title: t.name }); location.hash = `#/editor?edit=${edit.id}&tpl=${t.id}`; } catch (err) { toast(err.message, 'err'); }
          },
        }, 'Use this'),
        t.readOnly ? null : el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { if (confirm('Delete this template?')) { await api.deleteTemplate(t.id); drawHome(body.parentNode, 'templates'); } } }, 'Delete'))),
    el('p', { class: 'muted', style: 'margin:2px 0 6px' }, `${t.structure.summary || ''} ${t.structure.durationSec ? `About ${Math.round(t.structure.durationSec)}s, ${t.structure.cutCount} shots, cuts every ${t.structure.avgCutSeconds}s.` : ''}`),
    el('div', { class: 'chip-row' }, t.structure.beats.map((b) => el('span', { class: 'chip' }, `${b.role} ${b.seconds}s`))),
    t.structure.hookPattern ? el('p', { class: 'muted', style: 'margin:4px 0 0' }, `Hook: ${t.structure.hookPattern}`) : null);

  const file = el('input', { type: 'file', accept: 'video/*', class: 'input' });
  const name = textInput({ placeholder: 'Name for this pattern (optional)' });
  const status = el('div', {});
  const notes = textArea({ rows: 3, placeholder: 'Or describe a pattern in your own words: for example "fast hook with a question, three quick scenic cuts, answer on the last shot".' });
  const noteName = textInput({ placeholder: 'Name for this pattern' });
  body.replaceChildren(
    el('div', { class: 'card' },
      el('h2', {}, 'Add a pattern'),
      el('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Upload a reel you want to learn the shape of (a screen recording is fine). The studio reads only its structure: how it opens, how many shots, how long each runs, how text appears, the kind of sound. The video is deleted right after. Its footage, voice, wording and music are never reused: your edit is built from your own footage and your own true words.'),
      field('A reference reel', file),
      name,
      el('button', {
        class: 'btn btn-primary btn-xs', style: 'margin-top:8px', onclick: async (e) => {
          const f = file.files[0];
          if (!f) return toast('Choose a video first', 'err');
          e.target.disabled = true;
          const bar = el('div', { class: 'bar' }, el('span', { style: 'width:0%' }));
          status.replaceChildren(bar, el('p', { class: 'muted' }, 'Uploading, then reading the structure…'));
          try {
            await api.uploadFile(`/api/templates/analyze?name=${encodeURIComponent(name.value)}`, f, (r) => { bar.firstChild.style.width = `${Math.round(r * 100)}%`; });
            toast('Pattern saved');
            drawHome(body.parentNode, 'templates');
          } catch (err) { toast(err.message, 'err'); status.replaceChildren(el('p', { class: 'warn' }, err.message)); e.target.disabled = false; }
        },
      }, '✦ Read the structure'),
      status,
      el('div', { style: 'margin-top:14px' }, noteName, notes,
        el('button', {
          class: 'btn btn-ghost btn-xs', style: 'margin-top:8px', onclick: async (e) => {
            if (!notes.value.trim()) return toast('Describe the pattern first', 'err');
            e.target.disabled = true;
            try { await api.saveTemplate({ name: noteName.value || 'My pattern', notes: notes.value }); toast('Pattern saved'); drawHome(body.parentNode, 'templates'); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
          },
        }, '✦ Turn my description into a template'))),
    el('div', { class: 'card' }, el('h2', {}, 'Your patterns'), mine.length ? mine.map(row) : el('p', { class: 'muted' }, 'None yet. Add one above.')),
    el('div', { class: 'card' }, el('h2', {}, 'Starter patterns'), starters.map(row)));
}

// -- trend watch

async function drawTrends(body) {
  const st = await api.trends();
  const t = st.trends || {};
  const queries = textArea({ rows: 3 });
  queries.value = st.queries.join('\n');
  const auto = { on: !!st.settings?.trendAuto };
  const autoBtn = el('button', { class: `chip chip-toggle ${auto.on ? 'on' : ''}`, onclick: () => { auto.on = !auto.on; autoBtn.classList.toggle('on'); } }, 'Refresh weekly on its own');
  body.replaceChildren(
    el('div', { class: 'card' },
      el('h2', {}, 'Trend watch'),
      el('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Reads public YouTube Shorts in your niche from the last two weeks (titles, lengths, how fast views are growing, hashtags) and finds the patterns. It stores only that public information, never anyone\'s video, and every idea is an original one for you to film from your own trips. Instagram and TikTok do not offer a public trend feed, so for those, add a pattern from a reel you like on the Templates tab.'),
      st.canFetch ? null : el('p', { class: 'warn' }, 'Set YOUTUBE_API_KEY on the server (or connect YouTube on the Reel to Short page) to turn this on.'),
      field('What to watch (one search per line)', queries, 'Starts from your niche, place and pillars.'),
      el('div', { class: 'row gap wrap' }, autoBtn,
        el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { try { await api.trendSettings({ queries: queries.value, auto: auto.on }); toast('Saved'); } catch (err) { toast(err.message, 'err'); } } }, 'Save'),
        el('button', {
          class: 'btn btn-primary btn-xs', onclick: async (e) => {
            e.target.disabled = true;
            try { await api.trendSettings({ queries: queries.value, auto: auto.on }); await api.refreshTrends(); toast('Trends refreshed'); drawHome(body.parentNode, 'trends'); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
          },
        }, '↻ Refresh now')),
      t.at ? el('p', { class: 'muted' }, `Last refreshed ${new Date(t.at).toLocaleString()}`) : null),
    t.patterns ? el('div', { class: 'card' },
      el('h2', {}, 'What is working'),
      t.patterns.lengthSweetSpot ? el('p', {}, t.patterns.lengthSweetSpot) : null,
      el('span', { class: 'field-label' }, 'Title shapes'),
      el('ul', { class: 'plain-list' }, t.patterns.titleFormulas.map((f) => el('li', {}, `${f.pattern}`, el('span', { class: 'muted' }, ` · for example: ${f.example}`)))),
      el('span', { class: 'field-label' }, 'Topics'),
      el('div', { class: 'chip-row' }, t.patterns.topics.map((x) => el('span', { class: 'chip' }, x))),
      el('span', { class: 'field-label' }, 'Hashtags'),
      el('div', { class: 'chip-row' }, t.patterns.hashtags.map((x) => el('span', { class: 'chip' }, x)))) : null,
    t.patterns?.ideas?.length ? el('div', { class: 'card' },
      el('h2', {}, 'Ideas you could film from your own trips'),
      t.patterns.ideas.map((i) => el('div', { class: 'asset-field' },
        el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, i.title),
          el('button', {
            class: 'btn btn-primary btn-xs', onclick: async () => {
              try { const { edit } = await api.createEdit({ title: i.title, brief: { topic: i.title, notes: `Hook idea: ${i.hook}` } }); location.hash = `#/editor?edit=${edit.id}`; } catch (err) { toast(err.message, 'err'); }
            },
          }, 'Plan an edit')),
        el('p', { class: 'muted', style: 'margin:2px 0 0' }, `${i.why} · hook: ${i.hook}`)))) : null,
    t.videos?.length ? el('div', { class: 'card' },
      el('h2', {}, 'Fastest growing public Shorts (for reference only)'),
      el('div', { class: 'pkg-list' }, t.videos.slice(0, 12).map((v) => el('a', { class: 'pkg-row', href: v.url, target: '_blank', rel: 'noopener' },
        el('span', { class: 'pkg-topic' }, v.title),
        el('span', { class: 'muted' }, `${v.viewsPerDay} views a day · ${v.durationSec}s`))))) : null);
}

// ---- a project ---------------------------------------------------------------------------------

async function drawProject(container, id, tplParam) {
  container.replaceChildren(spinner('Loading…'));
  let edit; let media; let templates;
  try {
    [{ edit }, { items: media }, { items: templates }] = await Promise.all([api.edit(id), api.media(), api.templates()]);
  } catch {
    container.replaceChildren(emptyState('Not found', 'That edit is not in this business.', el('a', { class: 'btn btn-ghost btn-xs', href: '#/editor' }, '← All edits')));
    return;
  }
  const usable = media.filter((m) => m.analyzed || m.alt || m.caption);
  const byId = Object.fromEntries(media.map((m) => [m.id, m]));
  const state = {
    edl: structuredClone(edit.edl), title: edit.title,
    brief: { topic: edit.brief?.topic || '', seconds: edit.brief?.seconds || 30, style: edit.brief?.style || '', notes: edit.brief?.notes || '', mediaIds: edit.brief?.mediaIds || [] },
    templateId: tplParam || edit.templateId || '',
  };
  const redraw = () => drawProject(container, id, '');
  const back = el('a', { class: 'btn btn-ghost btn-xs', href: '#/editor' }, '← All edits');

  // a poll while rendering
  if (edit.status === 'rendering') {
    const line = el('p', { class: 'muted' }, edit.step || 'working');
    container.replaceChildren(el('div', { class: 'view-head' }, el('div', {}, el('h1', {}, edit.title), el('p', { class: 'sub' }, 'Rendering. You can leave this page open.')), back), el('div', { class: 'card' }, spinner('Rendering…'), line));
    const timer = setInterval(async () => {
      if (!document.body.contains(container)) return clearInterval(timer);
      try {
        const { edit: e } = await api.edit(id);
        line.textContent = e.step || 'working';
        if (e.status !== 'rendering') { clearInterval(timer); redraw(); }
      } catch { /* keep polling */ }
    }, 2000);
    return;
  }

  const collect = () => ({ ...state.edl });
  const save = async (quiet) => {
    const out = await api.saveEdit(id, { edl: collect(), title: state.title });
    state.edl = structuredClone(out.edit.edl);
    if (!quiet) toast('Saved');
    return out.edit;
  };

  // -- plan card
  const topic = textInput({ value: state.brief.topic, placeholder: 'What is this video about? (for example: sunrise in Akumal)', oninput: (e) => { state.brief.topic = e.target.value; } });
  const secs = select(['15', '20', '30', '45', '60'], String(state.brief.seconds), (v) => { state.brief.seconds = Number(v); }, (v) => `${v} seconds`);
  const style = textInput({ value: state.brief.style, placeholder: 'Style (optional): calm, quick, story-led…', oninput: (e) => { state.brief.style = e.target.value; } });
  const notes = textArea({ rows: 2, placeholder: 'Facts the footage cannot show (optional)', oninput: (e) => { state.brief.notes = e.target.value; } });
  notes.value = state.brief.notes;
  const tpl = el('select', { class: 'input select', onchange: (e) => { state.templateId = e.target.value; } },
    el('option', { value: '' }, 'No template: let Claude choose the shape'),
    templates.map((t) => el('option', { value: t.id }, `${t.name}${t.readOnly ? ' (starter)' : ''}`)));
  tpl.value = state.templateId;
  const picker = { auto: !state.brief.mediaIds.length };
  const mediaBox = el('div', {});
  const drawMediaPick = () => {
    mediaBox.replaceChildren(
      el('div', { class: 'chip-row' },
        el('button', { class: `chip chip-toggle ${picker.auto ? 'on' : ''}`, onclick: () => { picker.auto = true; state.brief.mediaIds = []; drawMediaPick(); } }, '✦ Let Claude choose from my library'),
        el('button', { class: `chip chip-toggle ${picker.auto ? '' : 'on'}`, onclick: () => { picker.auto = false; drawMediaPick(); } }, 'I will pick the clips')),
      picker.auto ? null : el('div', { class: 'mini-media-row' }, usable.slice(0, 80).map((m) => {
        const img = el('img', {
          class: `mini-thumb ${state.brief.mediaIds.includes(m.id) ? 'on' : ''}`, src: `/api/media/${m.id}/thumb`, alt: m.alt || m.name, title: `${m.kind}: ${m.caption || m.name}`,
          onclick: () => { const a = state.brief.mediaIds; const i = a.indexOf(m.id); if (i >= 0) a.splice(i, 1); else a.push(m.id); img.classList.toggle('on'); },
        });
        return img;
      })));
  };
  drawMediaPick();
  const planStatus = el('div', {});
  const planBtn = el('button', {
    class: 'btn btn-primary', onclick: async () => {
      planBtn.disabled = true;
      planStatus.replaceChildren(spinner('Claude is planning the cut…'));
      try {
        await api.planEdit(id, { brief: { ...state.brief, mediaIds: picker.auto ? [] : state.brief.mediaIds }, templateId: state.templateId || null });
        toast('Plan ready');
        redraw();
      } catch (err) { planStatus.replaceChildren(el('p', { class: 'warn' }, err.message)); planBtn.disabled = false; }
    },
  }, edit.edl.clips.length ? '✦ Plan it again' : '✦ Plan the edit');

  // -- timeline
  const tl = el('div', {});
  const thumbOf = (src) => (src.type === 'media' ? `/api/media/${src.id}/thumb` : null);
  const labelOf = (src) => (src.type === 'media' ? (byId[src.id]?.caption || byId[src.id]?.alt || byId[src.id]?.name || src.id) : (edit.assets.find((a) => a.id === src.id)?.name || 'uploaded clip'));
  const drawTimeline = () => {
    const clips = state.edl.clips;
    tl.replaceChildren(
      ...clips.map((c, i) => {
        const sub = (children) => el('div', { class: 'row gap wrap', style: 'margin-top:6px;align-items:center' }, children);
        return el('div', { class: 'asset-field' },
          el('div', { class: 'row gap', style: 'align-items:center' },
            thumbOf(c.src) ? el('img', { src: thumbOf(c.src), style: 'width:44px;height:78px;object-fit:cover;border-radius:6px' }) : el('span', { class: 'chip' }, 'clip'),
            el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 'field-label' }, `${i + 1}. ${String(labelOf(c.src)).slice(0, 70)}`),
              el('div', { class: 'muted' }, `${((c.out - c.in) / c.speed).toFixed(1)}s on screen`)),
            el('button', { class: 'btn btn-ghost btn-xs', disabled: i === 0, onclick: () => { [clips[i - 1], clips[i]] = [clips[i], clips[i - 1]]; drawTimeline(); } }, '↑'),
            el('button', { class: 'btn btn-ghost btn-xs', disabled: i === clips.length - 1, onclick: () => { [clips[i + 1], clips[i]] = [clips[i], clips[i + 1]]; drawTimeline(); } }, '↓'),
            el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { clips.splice(i, 1); drawTimeline(); } }, '✕')),
          sub([
            el('span', { class: 'muted' }, 'from'), numInput(c.in, (v) => { c.in = v; }), el('span', { class: 'muted' }, 'to'), numInput(c.out, (v) => { c.out = v; }),
            el('span', { class: 'muted' }, 'speed'), select(SPEEDS.map(String), String(c.speed), (v) => { c.speed = Number(v); }, (v) => `${v}x`),
            el('span', { class: 'muted' }, 'fit'), select(['blur', 'crop', 'contain'], c.fit, (v) => { c.fit = v; }),
          ]),
          sub([
            el('label', { class: 'row gap' }, el('input', { type: 'checkbox', checked: !!c.zoom, onchange: (e) => { c.zoom = e.target.checked ? { from: 1, to: 1.1 } : null; } }), 'slow push in'),
            el('label', { class: 'row gap' }, el('input', { type: 'checkbox', checked: c.audio === 'keep', onchange: (e) => { c.audio = e.target.checked ? 'keep' : 'mute'; } }), 'keep its sound'),
            i ? el('span', { class: 'muted' }, 'into this clip:') : null,
            i ? select(TRANSITIONS, c.transition.type, (v) => { c.transition.type = v; }) : null,
            i ? numInput(c.transition.seconds, (v) => { c.transition.seconds = v; }, 0.1, 64) : null,
          ]));
      }),
      el('div', { class: 'row gap wrap', style: 'margin-top:8px' },
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { picker.open = !picker.open; drawAdd(); } }, '＋ Add a clip'),
        el('span', { class: 'muted' }, clips.length ? `${edit.edl.seconds ? `${edit.edl.seconds}s as last saved` : ''}` : 'No clips yet: plan the edit above or add clips by hand.')),
      addBox);
  };
  const addBox = el('div', {});
  const drawAdd = () => {
    if (!picker.open) { addBox.replaceChildren(); return; }
    const assets = (edit.assets || []).filter((a) => a.kind !== 'audio');
    addBox.replaceChildren(el('div', { class: 'mini-media-row' },
      usable.slice(0, 120).map((m) => el('img', {
        class: 'mini-thumb', src: `/api/media/${m.id}/thumb`, title: `${m.kind}: ${m.caption || m.name}`,
        onclick: () => { state.edl.clips.push({ id: `c${Date.now()}`, src: { type: 'media', id: m.id }, in: 0, out: m.kind === 'video' ? 3 : 2.5, speed: 1, fit: 'blur', zoom: m.kind === 'image' ? { from: 1, to: 1.1 } : null, audio: 'mute', transition: { type: 'cut', seconds: 0.4 } }); drawTimeline(); },
      })),
      assets.map((a) => el('button', { class: 'chip chip-toggle', onclick: () => { state.edl.clips.push({ id: `c${Date.now()}`, src: { type: 'asset', id: a.id }, in: 0, out: Math.min(3, a.duration || 3), speed: 1, fit: 'blur', zoom: null, audio: 'keep', transition: { type: 'cut', seconds: 0.4 } }); drawTimeline(); } }, `uploaded: ${a.name}`))));
  };
  drawTimeline();

  // -- text
  const textBox = el('div', {});
  const drawText = () => {
    const texts = state.edl.texts;
    textBox.replaceChildren(
      ...texts.map((t, i) => el('div', { class: 'asset-field' },
        el('div', { class: 'row gap wrap', style: 'align-items:center' },
          textInput({ value: t.text, style: 'flex:1;min-width:200px', oninput: (e) => { t.text = e.target.value; } }),
          el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { texts.splice(i, 1); drawText(); } }, '✕')),
        el('div', { class: 'row gap wrap', style: 'margin-top:6px;align-items:center' },
          el('span', { class: 'muted' }, 'from'), numInput(t.start, (v) => { t.start = v; }), el('span', { class: 'muted' }, 'to'), numInput(t.end, (v) => { t.end = v; }),
          select(TEXT_STYLES, t.style, (v) => { t.style = v; }), select(POSITIONS, t.position, (v) => { t.position = v; }), select(ANIMATE, t.animate, (v) => { t.animate = v; })))),
      el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { state.edl.texts.push({ id: `t${Date.now()}`, text: '', start: 0, end: 3, style: 'caption', position: 'bottom', animate: 'pop' }); drawText(); } }, '＋ Add text'),
      el('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Text near the bottom and right edge is moved clear of where YouTube covers the picture. Keep lines to 7 words or fewer.'));
  };
  drawText();

  // -- sound
  const audioBox = el('div', {});
  const drawAudio = () => {
    const a = state.edl.audio;
    const musicAssets = (edit.assets || []).filter((x) => x.kind !== 'image');
    const m = a.music;
    const up = el('input', { type: 'file', accept: 'audio/*,video/*,image/*', class: 'input' });
    const status = el('div', {});
    audioBox.replaceChildren(
      el('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Use only audio you own or are licensed to use. Trending sounds from Instagram and TikTok cannot be used here: add those inside the app when you post.'),
      field('Upload your own music, voiceover or extra clips', up),
      el('button', {
        class: 'btn btn-ghost btn-xs', onclick: async (e) => {
          const f = up.files[0];
          if (!f) return toast('Choose a file first', 'err');
          e.target.disabled = true;
          const bar = el('div', { class: 'bar' }, el('span', { style: 'width:0%' }));
          status.replaceChildren(bar);
          try { await save(true); await api.uploadFile(`/api/edits/${id}/assets?name=${encodeURIComponent(f.name)}`, f, (r) => { bar.firstChild.style.width = `${Math.round(r * 100)}%`; }); toast('Uploaded'); redraw(); } catch (err) { toast(err.message, 'err'); status.replaceChildren(el('p', { class: 'warn' }, err.message)); e.target.disabled = false; }
        },
      }, 'Upload'),
      status,
      musicAssets.length ? el('div', { class: 'row gap wrap', style: 'margin-top:10px;align-items:center' },
        el('span', { class: 'muted' }, 'Music bed:'),
        (() => {
          const s = el('select', { class: 'input select', style: 'width:auto', onchange: (e) => { a.music = e.target.value ? { assetId: e.target.value, volume: m?.volume ?? 0.35, duck: m?.duck ?? true, startAt: m?.startAt ?? 0 } : null; drawAudio(); } },
            el('option', { value: '' }, 'None'), musicAssets.map((x) => el('option', { value: x.id }, `${x.name} (${x.duration}s)`)));
          s.value = m?.assetId || '';
          return s;
        })(),
        m ? [el('span', { class: 'muted' }, 'volume'), numInput(m.volume, (v) => { m.volume = v; }, 0.05, 70), el('span', { class: 'muted' }, 'start at'), numInput(m.startAt, (v) => { m.startAt = v; }, 1, 70),
          el('label', { class: 'row gap' }, el('input', { type: 'checkbox', checked: !!m.duck, onchange: (e) => { m.duck = e.target.checked; } }), 'lower it under speech'),
          el('button', {
            class: 'btn btn-ghost btn-xs', onclick: async (e) => {
              e.target.disabled = true;
              try { await save(true); const out = await api.editBeats(id, m.assetId, true); toast(`Cuts moved onto the beat (${out.bpm} BPM)`); redraw(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
            },
          }, '♪ Cut to the beat')] : null) : null,
      el('label', { class: 'row gap', style: 'margin-top:8px' }, el('input', { type: 'checkbox', checked: a.loudnorm !== false, onchange: (e) => { a.loudnorm = e.target.checked; } }), 'Even out the loudness'));
  };
  drawAudio();

  // -- render and results
  const rid = edit.renderId;
  const resultBox = el('div', {});
  if (edit.status === 'error') resultBox.append(el('p', { class: 'warn' }, edit.error || 'The last render failed.'));
  if (edit.status === 'done' && rid) {
    const social = edit.social;
    const socialBox = el('div', {});
    const drawSocial = (s) => {
      socialBox.replaceChildren(...[['instagram_reel', 'Instagram Reel'], ['facebook_reel', 'Facebook Reel'], ['tiktok', 'TikTok']].map(([k, label]) => {
        const f = s[k] || {};
        return el('div', { class: 'asset-field' },
          el('span', { class: 'field-label' }, label),
          ...Object.entries(f).filter(([, v]) => v).map(([key, v]) => el('div', { class: 'row spread' }, el('div', { style: 'flex:1' }, el('span', { class: 'muted' }, key.replace(/_/g, ' ')), el('pre', { class: 'asset-value' }, v)), copyBtn(v))));
      }), el('p', { class: 'muted' }, 'Post natively from the app (not a scheduler) for the most reach, and add a trending sound there. The audio note says what to search for.'));
    };
    if (social) drawSocial(social);
    resultBox.append(
      el('div', { class: 'short-layout' },
        el('div', {}, el('video', { controls: true, playsinline: true, preload: 'none', poster: `/api/render/${rid}/poster`, src: `/api/render/${rid}/video?q=preview` })),
        el('div', {},
          el('p', { class: 'muted', style: 'margin:0 0 8px' }, `${edit.renderedSeconds}s · 1080x1920 · rendered ${new Date(edit.renderedAt).toLocaleString()}`),
          el('div', { class: 'row gap wrap' },
            el('a', { class: 'btn btn-primary btn-xs', href: `/api/render/${rid}/video`, download: `${(state.title || 'edit').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp4` }, '⬇ MP4'),
            el('button', {
              class: 'btn btn-ghost btn-xs', title: 'Builds the YouTube master, captions, cover and metadata', onclick: async (e) => {
                e.target.disabled = true;
                try { const { packageId } = await api.editToShort(id); location.hash = `#/shorts?pkg=${packageId}`; } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
              },
            }, '▶ Send to YouTube Short'),
            el('button', {
              class: 'btn btn-ghost btn-xs', onclick: async (e) => {
                e.target.disabled = true;
                try { const out = await api.editSocial(id); drawSocial(out.edit.social); } catch (err) { toast(err.message, 'err'); }
                e.target.disabled = false;
              },
            }, '✦ Write Instagram, Facebook and TikTok captions'))),
      ),
      socialBox);
  }
  const renderBtn = el('button', {
    class: 'btn btn-primary', onclick: async () => {
      renderBtn.disabled = true;
      try { await save(true); await api.renderEdit(id); redraw(); } catch (err) { toast(err.message, 'err'); renderBtn.disabled = false; }
    },
  }, edit.status === 'done' ? '↻ Render again' : '🎬 Render');

  const titleInput = textInput({ value: state.title, style: 'font-size:22px;font-weight:600', onchange: (e) => { state.title = e.target.value; } });
  container.replaceChildren(
    el('div', { class: 'view-head' }, el('div', { style: 'flex:1' }, titleInput, el('p', { class: 'sub' }, `${edit.edl.clips.length} clips · ${edit.edl.seconds || 0}s`)),
      el('div', { class: 'row gap' }, back, el('button', { class: 'btn btn-danger btn-xs', onclick: async () => { if (confirm('Delete this edit and its files?')) { try { await api.deleteEdit(id); location.hash = '#/editor'; } catch (err) { toast(err.message, 'err'); } } } }, 'Delete'))),
    el('div', { class: 'card' },
      el('h2', {}, '1. Plan it'),
      el('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Claude picks and orders clips from your own library and writes the text, following a template if you choose one. Everything below stays editable.'),
      field('About', topic), el('div', { class: 'grid-2' }, field('Length', secs), field('Style', style)), field('Notes', notes),
      field('Template (a pattern, never someone\'s footage)', tpl), field('Footage', mediaBox),
      planBtn, planStatus,
      edit.planNotes ? el('p', { class: 'muted', style: 'margin:8px 0 0' }, `The idea: ${edit.planNotes}`) : null,
      edit.planIssues?.length ? el('p', { class: 'warn' }, `Check the text: ${edit.planIssues.join(' ')}`) : null),
    el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', {}, '2. Clips'), el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { try { await save(); redraw(); } catch (err) { toast(err.message, 'err'); } } }, 'Save changes')), tl),
    el('div', { class: 'card' }, el('h2', {}, '3. Text'), textBox),
    el('div', { class: 'card' }, el('h2', {}, '4. Sound'), audioBox),
    el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', {}, '5. Render'), renderBtn), resultBox));
}
