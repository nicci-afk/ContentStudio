import { api, appState } from './api.js';
import { el, field, textInput, textArea, toast, spinner, copyBtn, copyText, download, scoreBadge, emptyState } from './ui.js';

const fieldText = (v) => (v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));

export function renderCreate(root, params = null) {
  const openPackageId = params?.get?.('pkg') || sessionStorage.getItem('cs-last-pkg') || null;
  const container = el('div', { class: 'view' });
  const profile = appState.profile;
  const form = { topic: '', angle: '', ctaUrl: '', pillarId: profile.pillars?.[0]?.id || null, seriesId: null, platforms: new Set(appState.platforms.map((p) => p.id)), mediaIds: new Set(), autoMedia: true };
  let media = [];

  const formCard = el('div', { class: 'card form-card' });
  const listWrap = el('div', {});
  const detailWrap = el('div', {});

  const drawForm = () => {
    formCard.replaceChildren(
      el('h2', {}, 'New content package'),
      field('Topic', textInput({
        placeholder: 'e.g. Is an Antarctica cruise worth the money?',
        value: form.topic, oninput: (e) => { form.topic = e.target.value; },
      }), 'Phrase it the way your audience would ask an AI assistant — that phrasing becomes your ranking target.'),
      field('Angle (optional)', textInput({
        placeholder: 'e.g. Contrarian: the cheapest cabin is the wrong buy',
        value: form.angle, oninput: (e) => { form.angle = e.target.value; },
      })),
      field('CTA link (optional)', textInput({
        placeholder: 'https://your-apply-or-booking-page.com',
        value: form.ctaUrl, oninput: (e) => { form.ctaUrl = e.target.value; },
      }), 'Every platform gets its own tracked version (utm_source per platform) so you can see exactly which channel converts.'),
      el('div', { class: 'row gap wrap' },
        field('Pillar', el('select', { class: 'input select', onchange: (e) => { form.pillarId = e.target.value || null; } },
          el('option', { value: '' }, '— none —'),
          (profile.pillars || []).map((p) => {
            const o = el('option', { value: p.id }, p.name);
            if (p.id === form.pillarId) o.selected = true;
            return o;
          }))),
        field('Series', el('select', { class: 'input select', onchange: (e) => { form.seriesId = e.target.value || null; } },
          el('option', { value: '' }, '— standalone —'),
          (profile.series || []).map((s) => el('option', { value: s.id }, s.name))))),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Platforms'),
        el('div', { class: 'chip-row' }, appState.platforms.map((p) => {
          const chip = el('button', {
            class: `chip chip-toggle ${form.platforms.has(p.id) ? 'on' : ''}`,
            onclick: () => {
              form.platforms.has(p.id) ? form.platforms.delete(p.id) : form.platforms.add(p.id);
              chip.classList.toggle('on');
            },
          }, p.label);
          return chip;
        }))),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, `Media (${media.length} in library)`),
        media.length
          ? el('div', {},
              el('button', {
                class: `chip chip-toggle ${form.autoMedia ? 'on' : ''}`,
                onclick: (e) => {
                  form.autoMedia = !form.autoMedia;
                  e.target.classList.toggle('on');
                  drawForm();
                },
              }, '✦ Let AI pick from my library (recommended)'),
              form.autoMedia
                ? el('p', { class: 'muted', style: 'margin:8px 0 0' },
                    'The engine scans your analyzed library and selects the assets with the strongest visibility metadata and story fit for this topic — you\'ll see each pick and why in the finished package.')
                : el('div', { class: 'mini-media-row', style: 'margin-top:8px' }, media.slice(0, 60).map((m) => {
                    const img = el('img', {
                      class: `mini-thumb ${form.mediaIds.has(m.id) ? 'on' : ''}`, src: `/api/media/${m.id}/thumb`, alt: m.alt || m.name, title: m.caption || m.name,
                      onclick: () => { form.mediaIds.has(m.id) ? form.mediaIds.delete(m.id) : form.mediaIds.add(m.id); img.classList.toggle('on'); },
                    });
                    return img;
                  })))
          : el('span', { class: 'muted' }, 'Import photos/videos in the Library and they appear here for b-roll and carousel matching.')),
      el('button', {
        class: 'btn btn-primary btn-lg', onclick: async () => {
          if (!form.topic.trim()) return toast('Give the package a topic', 'err');
          if (!form.platforms.size) return toast('Pick at least one platform', 'err');
          await runGeneration();
        },
      }, '✦ Generate package'),
    );
  };

  const runGeneration = async () => {
    const progress = el('div', {});
    formCard.append(progress);
    progress.replaceChildren(spinner('Queueing generation…'));
    try {
      const { jobId } = await api.generate({
        topic: form.topic.trim(), angle: form.angle.trim() || null,
        ctaUrl: form.ctaUrl.trim() || null,
        pillarId: form.pillarId, seriesId: form.seriesId,
        platforms: [...form.platforms],
        mediaIds: form.autoMedia ? [] : [...form.mediaIds],
        autoMedia: form.autoMedia,
      });
      while (true) {
        await new Promise((r) => setTimeout(r, 1800));
        const job = await api.job(jobId);
        if (job.status === 'done') {
          progress.remove();
          toast('Package ready');
          await drawList();
          openDetail(job.package.id);
          return;
        }
        if (job.status === 'error') throw new Error(job.error || 'generation failed');
        const p = job.progress || {};
        progress.replaceChildren(spinner(`Writing ${p.done || 0}/${p.total || '…'} assets — ${p.platform ? p.platform.replace(/_/g, ' ') : 'starting'}`));
      }
    } catch (err) {
      progress.remove();
      toast(err.message, 'err');
    }
  };

  const drawList = async () => {
    const { items } = await api.packages();
    listWrap.replaceChildren(
      el('div', { class: 'card' },
        el('h2', {}, 'Packages'),
        items.length
          ? el('div', { class: 'pkg-list' }, items.map((p) => el('button', { class: 'pkg-row', onclick: () => openDetail(p.id) },
              el('span', { class: 'pkg-topic' }, p.topic),
              el('span', { class: 'muted' }, `${p.platforms.length} platforms · ${new Date(p.createdAt).toLocaleDateString()}${p.mode === 'template' ? ' · template mode' : ''}`),
              scoreBadge(p.score, p.grade))))
          : emptyState('No packages yet', 'Generate your first package above — every platform, every asset, one topic.')));
  };

  const openDetail = async (id) => {
    let pkg;
    try {
      ({ package: pkg } = await api.pkg(id));
    } catch {
      sessionStorage.removeItem('cs-last-pkg');
      return;
    }
    sessionStorage.setItem('cs-last-pkg', pkg.id);
    history.replaceState(null, '', `#/create?pkg=${pkg.id}`);
    detailWrap.replaceChildren(renderPackage(pkg, async () => {
      await api.deletePackage(pkg.id);
      sessionStorage.removeItem('cs-last-pkg');
      history.replaceState(null, '', '#/create');
      detailWrap.replaceChildren();
      await drawList();
    }));
    detailWrap.scrollIntoView({ behavior: 'smooth' });
  };

  container.append(
    el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, 'Create'),
        el('p', { class: 'sub' }, 'One topic in — a complete, platform-native, AI-visible content package out.'))),
    formCard, listWrap, detailWrap,
  );

  api.media().then(({ items }) => { media = items; drawForm(); });
  drawForm();
  drawList().then(() => { if (openPackageId) openDetail(openPackageId); });
  root.replaceChildren(container);
}

// ---- package viewer ------------------------------------------------------

function renderPackage(pkg, onDelete) {
  const specs = Object.fromEntries(appState.platforms.map((p) => [p.id, p]));
  const tabs = [
    ...Object.keys(pkg.platforms || {}).map((id) => ({ id, label: specs[id]?.label || id })),
    { id: '_visibility', label: `Visibility ${pkg.visibility ? `· ${pkg.visibility.score}` : ''}` },
    { id: '_metadata', label: 'AI Metadata' },
  ];
  let active = tabs[0]?.id;
  const body = el('div', { class: 'pkg-body' });
  const tabRow = el('div', { class: 'tab-row' });

  const drawTabs = () => {
    tabRow.replaceChildren(...tabs.map((t) => el('button', {
      class: `tab ${t.id === active ? 'active' : ''}`,
      onclick: () => { active = t.id; drawTabs(); drawBody(); },
    }, t.label)));
  };

  const drawBody = () => {
    body.replaceChildren();
    if (active === '_visibility') return body.append(visibilityTab(pkg));
    if (active === '_metadata') return body.append(metadataTab(pkg));
    const spec = specs[active];
    const asset = pkg.platforms[active];
    if (!asset) return;
    if (asset.error) body.append(el('p', { class: 'warn' }, `Fell back to template for this platform: ${asset.error}`));
    body.append(el('p', { class: 'algo-note' }, spec?.algo || ''));
    if (pkg.links?.[active]) {
      body.append(el('div', { class: 'asset-field' },
        el('div', { class: 'row spread' },
          el('span', { class: 'field-label' }, 'Tracked CTA link (replace [LINK] with this)'),
          copyBtn(pkg.links[active])),
        el('pre', { class: 'asset-value code' }, pkg.links[active])));
    }
    for (const f of spec?.fields || Object.keys(asset.fields).map((k) => ({ key: k, label: k }))) {
      const value = fieldText(asset.fields[f.key]);
      if (!value) continue;
      const pre = el('pre', { class: 'asset-value' }, value);
      const fieldBox = el('div', { class: 'asset-field' },
        el('div', { class: 'row spread' },
          el('span', { class: 'field-label' }, f.label),
          el('div', { class: 'row gap' },
            el('span', { class: 'muted char-count' }, `${value.length} chars`),
            el('button', {
              class: 'btn btn-ghost btn-xs', onclick: () => {
                const ta = el('textarea', { class: 'input textarea asset-edit', rows: Math.min(18, Math.max(4, value.split('\n').length + 1)) });
                ta.value = fieldText(pkg.platforms[active].fields[f.key]);
                const save = el('button', {
                  class: 'btn btn-primary btn-xs', onclick: async () => {
                    try {
                      const { package: updated } = await api.editPackageField(pkg.id, active, f.key, ta.value);
                      Object.assign(pkg, updated);
                      toast('Saved — rescored');
                      drawTabs();
                      drawBody();
                    } catch (err) { toast(err.message, 'err'); }
                  },
                }, 'Save');
                const cancel = el('button', { class: 'btn btn-ghost btn-xs', onclick: () => { drawBody(); } }, 'Cancel');
                pre.replaceWith(el('div', {}, ta, el('div', { class: 'row gap', style: 'margin-top:8px' }, save, cancel)));
              },
            }, '✎ Edit'),
            copyBtn(() => fieldText(pkg.platforms[active].fields[f.key])))),
        pre);
      body.append(fieldBox);
    }
    const script = fieldText(asset.fields.script || asset.fields.article || asset.fields.post);
    if (script.length > 100) {
      body.append(el('div', { class: 'row gap' },
        el('button', {
          class: 'btn btn-ghost btn-xs',
          onclick: () => { sessionStorage.setItem('cs-script', script); location.hash = '#/voice-studio'; },
        }, '🎙 Narrate in Voice Studio'),
        el('button', {
          class: 'btn btn-ghost btn-xs',
          onclick: () => { sessionStorage.setItem('cs-script', script); location.hash = '#/avatar-studio'; },
        }, '🧑‍💻 Film with Avatar')));
    }
    if (spec?.group === 'video') body.append(producePanel(pkg, active, () => { drawTabs(); drawBody(); }));
  };

  drawTabs();
  drawBody();

  return el('div', { class: 'card pkg-detail' },
    el('div', { class: 'row spread' },
      el('div', {},
        el('h2', {}, pkg.topic),
        el('p', { class: 'muted' }, `${new Date(pkg.createdAt).toLocaleString()}${pkg.mode === 'template' ? ' · template mode (add Claude key for full AI writing)' : ''}`)),
      el('div', { class: 'row gap' },
        pkg.visibility ? scoreBadge(pkg.visibility.score, pkg.visibility.grade) : null,
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`package-${pkg.id}.md`, packageMarkdown(pkg), 'text/markdown') }, '⬇ Publish kit (.md)'),
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`website-kit-${pkg.id}.md`, websiteKit(pkg), 'text/markdown') }, '⬇ Website kit (Lovable)'),
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`package-${pkg.id}.json`, JSON.stringify(pkg, null, 2), 'application/json') }, '⬇ JSON'),
        el('button', { class: 'btn btn-danger btn-xs', onclick: onDelete }, 'Delete'))),
    pkg.quotable ? el('blockquote', { class: 'sample' }, `“${pkg.quotable}”`) : null,
    tabRow, body);
}

function producePanel(pkg, platformId, onPackageUpdated) {
  const panel = el('div', { class: 'produce-panel' });
  const defaultOrientation = platformId === 'youtube_long' ? 'landscape' : 'portrait';
  const savedDelivery = (() => { try { return localStorage.getItem('cs_delivery'); } catch { return null; } })();
  const scriptText = String(pkg.platforms?.[platformId]?.fields?.script || '');
  const hasOnCamera = /\[[^\]]*\b(?:talking[ -]?head|on[ -]?camera|to[ -]?camera|a[ -]?roll)\b[^\]]*\]|^\s*(?:TALKING[ -]?HEAD|ON[ -]?CAMERA|A[ -]?ROLL)\s*[:\-]/im.test(scriptText);
  // Short-form platforms carry a videoSpec (duration cap + fast cuts) and
  // default to the avatar carrying the whole video in one voice.
  const videoSpec = appState.platforms.find((p) => p.id === platformId)?.videoSpec || null;
  const state = { voiceId: null, useAvatar: false, avatarId: null, avatarKind: 'avatar', heygenVoiceId: null, avatarScope: videoSpec ? 'all' : (hasOnCamera ? 'sections' : 'open'), avatarStyle: 'cutout', orientation: defaultOrientation, delivery: savedDelivery || 'calm' };

  const voiceSelect = el('select', { class: 'input select', onchange: (e) => { state.voiceId = e.target.value || null; } },
    el('option', { value: '' }, 'No narration key — silent preview'));
  const avatarWrap = el('div', { class: 'row gap wrap', style: 'display:none' });
  const orientationSelect = el('select', { class: 'input select', onchange: (e) => { state.orientation = e.target.value; } },
    el('option', { value: 'portrait', selected: defaultOrientation === 'portrait' }, 'Portrait 9:16'),
    el('option', { value: 'landscape', selected: defaultOrientation === 'landscape' }, 'Landscape 16:9'));
  const deliverySelect = el('select', { class: 'input select', title: 'Narration delivery style', onchange: (e) => {
    state.delivery = e.target.value;
    try { localStorage.setItem('cs_delivery', state.delivery); } catch { /* remember is best-effort */ }
  } },
    el('option', { value: 'calm', selected: state.delivery === 'calm' }, 'Warm & calm delivery'),
    el('option', { value: 'balanced', selected: state.delivery === 'balanced' }, 'Balanced delivery'),
    el('option', { value: 'energetic', selected: state.delivery === 'energetic' }, 'Energetic delivery'));
  const result = el('div', {});
  const renderList = el('div', {});

  api.voices().then(({ voices }) => {
    const own = (v) => v.category === 'professional' || v.category === 'cloned';
    voiceSelect.replaceChildren(...voices.map((v) => el('option', { value: v.id }, `${v.name}${own(v) ? ' · your voice' : ''}`)));
    // The professional clone reads truest; an instant clone is the backup.
    state.voiceId = voices.find((v) => v.category === 'professional')?.id
      || voices.find((v) => v.category === 'cloned')?.id || voices[0]?.id || null;
    if (state.voiceId) voiceSelect.value = state.voiceId;
  }).catch(() => {});

  const avatarToggle = el('button', {
    class: 'chip chip-toggle',
    onclick: async (e) => {
      state.useAvatar = !state.useAvatar;
      e.target.classList.toggle('on');
      avatarWrap.style.display = state.useAvatar ? 'flex' : 'none';
      if (state.useAvatar && !avatarWrap.children.length) {
        try {
          const [{ avatars }, { voices }] = await Promise.all([api.avatars(), api.avatarVoices()]);
          if (!avatars.length) throw new Error('no avatars are visible in your HeyGen account yet; create one at heygen.com first');
          const pickAvatar = (id) => {
            state.avatarId = id;
            state.avatarKind = avatars.find((a) => a.id === id)?.kind || 'avatar';
          };
          const aSel = el('select', { class: 'input select', onchange: (ev) => pickAvatar(ev.target.value) },
            ...avatars.map((a) => el('option', { value: a.id },
              a.kind === 'talking_photo' ? `${a.name} (your photo avatar)` : a.name)));
          const vSel = el('select', { class: 'input select', onchange: (ev) => { state.heygenVoiceId = ev.target.value; } },
            ...voices.map((v) => el('option', { value: v.id }, `${v.name} (${v.language || '—'})`)));
          const scopeSel = el('select', { class: 'input select', title: 'Where your avatar appears in the video', onchange: (ev) => { state.avatarScope = ev.target.value; } },
            el('option', { value: 'all', selected: state.avatarScope === 'all' }, 'Avatar speaks the whole video (one voice)'),
            el('option', { value: 'sections', selected: state.avatarScope === 'sections' },
              hasOnCamera ? 'Avatar on every [ON CAMERA] section' : 'Avatar on on-camera sections (none marked in this script)'),
            el('option', { value: 'open', selected: state.avatarScope === 'open' }, 'Avatar on the open only'));
          const styleSel = el('select', { class: 'input select', title: 'How your avatar appears on screen', onchange: (ev) => { state.avatarStyle = ev.target.value; } },
            el('option', { value: 'cutout', selected: state.avatarStyle === 'cutout' }, 'Cut out over your footage (green screen look)'),
            el('option', { value: 'full', selected: state.avatarStyle === 'full' }, 'Full frame'));
          pickAvatar(avatars[0]?.id || null);
          state.heygenVoiceId = voices[0]?.id || null;
          avatarWrap.append(aSel, vSel, scopeSel, styleSel);
        } catch (err) {
          toast(`Avatar unavailable: ${err.message}`, 'err');
          state.useAvatar = false;
          e.target.classList.remove('on');
          avatarWrap.style.display = 'none';
        }
      }
    },
  }, '🧑‍💻 Use my avatar (HeyGen)');

  const drawRenders = async () => {
    try {
      const { items } = await api.packageRenders(pkg.id);
      const mine = items.filter((r) => r.platformId === platformId);
      renderList.replaceChildren(...mine.map((r) => {
        const state = r.status || 'done';
        if (state === 'running') {
          return el('div', { class: 'render-row' },
            el('span', { class: 'muted' }, `⏳ Rendering now — ${r.step || 'working'}… long-form with avatar can take 10-20 minutes. Safe to leave; it finishes on the server.`));
        }
        if (state !== 'done') {
          return el('div', { class: 'render-row' },
            el('span', { class: 'warn' }, `⚠ ${state}: ${r.error || 'render did not finish'}`));
        }
        return el('div', { class: 'render-row' },
          el('video', { controls: true, preload: 'metadata', class: 'video-player', src: `/api/render/${r.id}/video` }),
          el('div', { class: 'row gap' },
            (() => {
              const slug = (pkg.topic || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
              return [
                el('a', { class: 'btn btn-ghost btn-xs', href: `/api/render/${r.id}/video`, download: `${slug}-${r.platformId}.mp4` }, '⬇ MP4 (keyword filename)'),
                el('a', { class: 'btn btn-ghost btn-xs', href: `/api/render/${r.id}/srt`, download: `${slug}.srt` }, '⬇ Captions (.srt)'),
              ];
            })(),
            el('span', { class: 'muted' }, `${r.duration || '?'}s · ${r.orientation}${r.captions ? ' · captions burned' : ''}${r.timed ? ' · word-timed' : ''}${r.silent ? ' · silent preview' : ''}${r.avatarSections ? ` · avatar on camera ×${r.avatarSections}${r.avatarStyle === 'cutout' ? ' (cut out)' : ''}` : r.avatarScope === 'all' && r.avatar ? ` · avatar full video${r.avatarStyle === 'cutout' ? ' (cut out)' : ''}` : r.avatar ? ' · avatar open' : ''}${r.trimmedToFit ? ` · trimmed to the ${r.trimmedToFit}s platform cap` : ''}${r.delivery && r.delivery !== 'balanced' ? ` · ${r.delivery} delivery` : ''}${r.videoClips ? ` · ${r.videoClips} real clip${r.videoClips === 1 ? '' : 's'}${r.clipWindows > r.videoClips ? ` (${r.clipWindows} distinct windows)` : ''}` : ''}${r.chaptersApplied ? ` · ${r.chapters?.length || 0} chapters auto-filled` : r.chapters?.length ? ` · ${r.chapters.length} chapters` : ''}${r.mediaFallback ? ' · library media' : ''}`)));
      }));
    } catch { /* list is best-effort */ }
  };

  const produce = async () => {
    result.replaceChildren(spinner('Queueing render…'));
    try {
      const { renderId } = await api.render({
        packageId: pkg.id, platformId,
        voiceId: state.voiceId,
        orientation: state.orientation,
        delivery: state.delivery,
        avatar: state.useAvatar ? { avatarId: state.avatarId, avatarKind: state.avatarKind, voiceId: state.heygenVoiceId, scope: state.avatarScope, style: state.avatarStyle } : null,
      });
      while (true) {
        await new Promise((r) => setTimeout(r, 4000));
        const job = await api.renderStatus(renderId);
        if (job.status === 'done') {
          result.replaceChildren();
          if (job.chaptersApplied) {
            // The render wrote real chapter lines into the package fields;
            // reload so the chapters/description editors show the truth.
            try {
              const { package: updated } = await api.pkg(pkg.id);
              Object.assign(pkg, updated);
              toast('Video rendered · real chapters written into the package');
              onPackageUpdated?.();
              return;
            } catch { /* the render row still shows the chapters */ }
          }
          toast('Video rendered');
          await drawRenders();
          return;
        }
        if (job.status === 'error' || job.status === 'interrupted') throw new Error(job.error || 'render failed');
        result.replaceChildren(spinner(`Producing… ${job.step}`));
      }
    } catch (err) {
      result.replaceChildren();
      toast(/unknown render/i.test(err.message)
        ? 'The server restarted mid-render (an update deployed). Click Produce again.'
        : err.message, 'err');
      await drawRenders();
    }
  };

  const spokenWords = scriptText.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean).length;
  const estSeconds = Math.round(spokenWords / 2.4);
  panel.append(
    el('div', { class: 'row spread' },
      el('span', { class: 'field-label' }, '🎬 Auto-produce this video'),
      el('span', { class: 'muted' }, 'Your library imagery + your cloned voice, rendered to a finished MP4')),
    el('div', { class: 'row gap wrap' },
      voiceSelect, deliverySelect, orientationSelect, avatarToggle),
    avatarWrap,
    videoSpec
      ? el('p', { class: 'muted', style: 'margin:2px 0 6px' },
          `This script reads about ${estSeconds}s spoken · the sweet spot here is ${videoSpec.targetSeconds}s and the cap is ${videoSpec.maxSeconds}s (anything longer trims automatically). Tighten the script field first for the strongest cut.`)
      : null,
    el('button', { class: 'btn btn-primary', onclick: produce }, '🎬 Produce video'),
    result, renderList,
  );
  drawRenders();
  return panel;
}

function visibilityTab(pkg) {
  const v = pkg.visibility;
  if (!v) return el('p', {}, 'Not scored.');
  return el('div', {},
    el('div', { class: 'score-hero' },
      el('div', { class: 'score-num' }, String(v.score)),
      el('div', {},
        el('strong', {}, v.grade),
        el('p', { class: 'muted' }, 'E-E-A-T-V rubric: experience, expertise, authority, trust + AI-answer readiness.'))),
    el('div', { class: 'check-list' }, v.checks.map((c) => el('div', { class: `check ${c.pass ? 'pass' : 'fail'}` },
      el('span', { class: 'check-mark' }, c.pass ? '✓' : '✗'),
      el('div', {},
        el('span', {}, c.label),
        c.fix ? el('p', { class: 'fix' }, c.fix) : null)))));
}

function metadataTab(pkg) {
  const jsonldText = Object.entries(pkg.jsonld || {})
    .map(([k, v]) => `<!-- ${k} -->\n<script type="application/ld+json">\n${JSON.stringify(v, null, 2)}\n</script>`)
    .join('\n\n');
  return el('div', {},
    pkg.definition ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Your definition (own the answer)'), copyBtn(pkg.definition)),
      el('blockquote', { class: 'sample' }, pkg.definition)) : null,
    (pkg.citeLines || []).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Attribution-ready claim lines'), copyBtn(pkg.citeLines.join('\n'))),
      el('ul', { class: 'plain-list' }, pkg.citeLines.map((c) => el('li', {}, c)))) : null,
    (pkg.queryMap || []).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Query map (phrasings this package should win)'), copyBtn(pkg.queryMap.join('\n'))),
      el('div', { class: 'chip-row' }, pkg.queryMap.map((q) => el('span', { class: 'chip' }, q)))) : null,
    (pkg.mediaIds || []).length ? el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, `Media in this package${pkg.mediaSelectionMode === 'ai' ? ' (AI-selected)' : ''}`),
      el('div', { class: 'mini-media-row' }, pkg.mediaIds.map((id) => el('div', { class: 'pick-cell' },
        el('img', { class: 'mini-thumb on', src: `/api/media/${id}/thumb`, alt: pkg.altTexts?.[id] || 'selected media' }),
        pkg.mediaSelection?.[id] ? el('span', { class: 'muted pick-reason' }, pkg.mediaSelection[id]) : null)))) : null,
    Object.keys(pkg.links || {}).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Tracked CTA links (one per platform)'), copyBtn(Object.entries(pkg.links).map(([k, v]) => `${k}: ${v}`).join('\n'))),
      el('ul', { class: 'plain-list' }, Object.entries(pkg.links).map(([k, v]) => el('li', {}, `${k} → ${v}`)))) : null,
    (pkg.faq || []).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'FAQ (AI-answer layer)'), copyBtn(pkg.faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n'))),
      pkg.faq.map((f) => el('div', { class: 'faq-pair' }, el('strong', {}, f.q), el('p', {}, f.a)))) : null,
    pkg.keywords?.length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Keywords & retrieval phrases'), copyBtn(pkg.keywords.join(', '))),
      el('div', { class: 'chip-row' }, pkg.keywords.map((k) => el('span', { class: 'chip' }, k)))) : null,
    pkg.entities?.length ? el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, 'Entities to reinforce'),
      el('div', { class: 'chip-row' }, pkg.entities.map((k) => el('span', { class: 'chip chip-entity' }, k)))) : null,
    Object.keys(pkg.altTexts || {}).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Alt text for attached media'), copyBtn(Object.values(pkg.altTexts).join('\n'))),
      el('ul', { class: 'plain-list' }, Object.entries(pkg.altTexts).map(([id, alt]) => el('li', {}, alt)))) : null,
    jsonldText ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' },
        el('span', { class: 'field-label' }, 'Schema.org JSON-LD (paste into your site <head>)'),
        el('div', { class: 'row gap' },
          copyBtn(jsonldText, 'Copy'),
          el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`jsonld-${pkg.id}.html`, jsonldText, 'text/html') }, '⬇'))),
      el('pre', { class: 'asset-value code' }, jsonldText)) : null,
    el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, 'llms.txt'),
      el('p', { class: 'muted' }, 'Your studio serves a live llms.txt for AI crawlers — publish its contents at yourdomain.com/llms.txt.'),
      el('a', { class: 'btn btn-ghost btn-xs', href: '/llms.txt', target: '_blank' }, 'Open /llms.txt')));
}

export function websiteKit(pkg, profile) {
  const li = pkg.platforms?.linkedin?.fields || {};
  const yt = pkg.platforms?.youtube_long?.fields || {};
  const title = fieldText(li.article_title) || pkg.topic;
  const slug = pkg.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const metaDesc = (pkg.faq?.[0]?.a || fieldText(li.article)).replace(/[#*\n]+/g, ' ').trim().slice(0, 155);
  const jsonld = Object.values(pkg.jsonld || {})
    .map((v) => `<script type="application/ld+json">\n${JSON.stringify(v, null, 2)}\n</script>`)
    .join('\n');
  const altList = Object.values(pkg.altTexts || {});
  return `# Website Kit — paste this whole prompt into Lovable

Add a new article page to my site at /${slug}

Page requirements:
- Meta title: "${title}" (trim to 60 chars if longer)
- Meta description: "${metaDesc}"
- Render the article below preserving its heading hierarchy exactly (the # line is the page H1, ## lines are H2 sections, ### are H3). Readable column width, generous spacing.
${fieldText(yt.title) ? `- Embed my YouTube video "${fieldText(yt.title)}" [FILL: paste YouTube URL after upload] above the article body.\n` : ''}- Keep the FAQ section as an accordion or clearly separated Q&A block.
- Insert the JSON-LD below into the page <head> exactly as provided — do not modify it.
- End the page with one CTA button: [FILL: CTA label + URL].
- Add the page to the sitemap and link it from the articles/blog index.
${altList.length ? `- Article images use these alt texts (match to the images I upload): ${altList.map((a) => `"${a}"`).join('; ')}\n` : ''}
---

ARTICLE (markdown — paste as page content):

${fieldText(li.article) || '[FILL: generate the LinkedIn article in this package first — it doubles as the site article]'}

---

JSON-LD for the page <head>:

\`\`\`html
${jsonld || '<!-- rescore the package to build schema -->'}
\`\`\`
`;
}

function packageMarkdown(pkg) {
  const specs = Object.fromEntries(appState.platforms.map((p) => [p.id, p]));
  const lines = [`# ${pkg.topic}`, '', `Generated ${pkg.createdAt} · Visibility ${pkg.visibility?.score ?? '–'} (${pkg.visibility?.grade ?? ''})`, ''];
  if (pkg.quotable) lines.push(`> ${pkg.quotable}`, '');
  for (const [id, asset] of Object.entries(pkg.platforms || {})) {
    lines.push(`## ${specs[id]?.label || id}`, '');
    for (const [key, value] of Object.entries(asset.fields || {})) {
      const label = specs[id]?.fields?.find((f) => f.key === key)?.label || key;
      lines.push(`### ${label}`, '', fieldText(value), '');
    }
  }
  if (pkg.faq?.length) {
    lines.push('## FAQ (AI-answer layer)', '');
    for (const f of pkg.faq) lines.push(`**${f.q}**`, '', f.a, '');
  }
  if (pkg.keywords?.length) lines.push('## Keywords', '', pkg.keywords.join(', '), '');
  if (Object.keys(pkg.altTexts || {}).length) lines.push('## Alt text', '', ...Object.values(pkg.altTexts).map((a) => `- ${a}`), '');
  if (pkg.jsonld) lines.push('## JSON-LD', '', '```html', ...Object.values(pkg.jsonld).map((v) => `<script type="application/ld+json">\n${JSON.stringify(v, null, 2)}\n</script>`), '```', '');
  return lines.join('\n');
}
