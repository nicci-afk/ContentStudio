// Reel to YouTube Short: upload a finished reel (made in Edits, CapCut, or
// anywhere), get the exact YouTube upload file, cover, captions, and the
// metadata written for AI visibility, then a copyable prompt for the Claude
// in Chrome extension that fills YouTube Studio and registers the live URL.
// Everything is per brand: the import is a package in the active workspace.

import { api, appState } from './api.js';
import { el, toast, spinner, copyBtn, download, emptyState, field, textInput, textArea, scoreBadge, crawlerAuditView } from './ui.js';

const fieldText = (v) => (v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));
const mb = (n) => `${Math.round((n || 0) / 1e5) / 10} MB`;

export async function renderShorts(root, params) {
  const container = el('div', { class: 'view' });
  root.replaceChildren(container);
  // The prompt's deep link names a workspace: switch this browser to it first
  // (per-browser, so it never affects anyone else).
  const ws = params?.get('ws');
  if (ws && ws !== appState.workspaces.activeId && appState.workspaces.items.some((w) => w.id === ws)) {
    appState.workspaces = await api.activateWorkspace(ws);
    await appState.reloadWorkspace();
  }
  const pkgId = params?.get('pkg');
  if (pkgId) return drawDetail(container, pkgId, params.get('live') || '');
  return drawHome(container);
}

// ---- home: new import + past imports ------------------------------------

async function drawHome(container) {
  container.append(spinner('Loading…'));
  const [{ items }, trips, related] = await Promise.all([
    api.packages(),
    api.trips().catch(() => ({ items: [] })),
    api.shortsRelated().catch(() => ({ items: [] })),
  ]);
  const past = items.filter((p) => p.kind === 'short');
  const brand = appState.profile?.business?.name || 'this brand';

  const f = { file: null, audio: 'keep', fit: 'blur', normalize: true, transcribe: true, hosted: false, aiContent: false, keepSource: false, tripId: 'none', related: '' };
  const status = el('div', {});
  const picked = el('p', { class: 'muted', style: 'margin:6px 0 0' }, 'No video chosen yet.');
  const fileInput = el('input', {
    type: 'file', accept: 'video/*,.mov,.mp4,.m4v', class: 'input',
    onchange: (e) => {
      f.file = e.target.files[0] || null;
      picked.textContent = f.file ? `${f.file.name} · ${mb(f.file.size)}` : 'No video chosen yet.';
    },
  });
  const caption = textArea({ rows: 3, placeholder: 'Paste the caption you used on Instagram or Facebook (optional). Its facts and voice help; it is not copied.' });
  const notes = textArea({ rows: 2, placeholder: 'Anything the video cannot show: the place, who is in it, what happened (optional).' });
  const filmed = el('input', { type: 'date', class: 'input' });
  const tripSel = el('select', { class: 'input select', onchange: (e) => { f.tripId = e.target.value; } },
    el('option', { value: 'none' }, 'No trip (use only what is in the video and my notes)'),
    (trips.items || []).filter((t) => t.useInContent !== false).map((t) => el('option', { value: t.id }, `${t.name} (${t.start.slice(5)} to ${t.end.slice(5)})`)));
  const relatedSel = el('select', { class: 'input select', onchange: (e) => { f.related = e.target.value; } },
    el('option', { value: '' }, 'None'),
    (related.items || []).map((r, i) => el('option', { value: String(i) }, `${r.label} (${r.platformId.replace(/_/g, ' ')})`)));

  const chip = (label, on, onclick) => el('button', { class: `chip chip-toggle ${on ? 'on' : ''}`, onclick }, label);
  const choiceRow = (get, set, options) => {
    const row = el('div', { class: 'chip-row' });
    const draw = () => row.replaceChildren(...options.map(([val, label]) => chip(label, get() === val, () => { set(val); draw(); })));
    draw();
    return row;
  };
  const toggleRow = (key, label, hint) => {
    const row = el('div', {});
    const draw = () => row.replaceChildren(el('button', { class: `chip chip-toggle ${f[key] ? 'on' : ''}`, onclick: () => { f[key] = !f[key]; draw(); } }, `${f[key] ? '✓ ' : ''}${label}`),
      hint ? el('span', { class: 'muted', style: 'margin-left:8px' }, hint) : null);
    draw();
    return row;
  };

  const go = el('button', {
    class: 'btn btn-primary btn-lg', onclick: async () => {
      if (!f.file) return toast('Choose the reel first', 'err');
      go.disabled = true;
      const bar = el('div', { class: 'bar' }, el('span', { style: 'width:0%' }));
      const label = el('p', { class: 'muted', style: 'margin:0' }, 'Uploading…');
      status.replaceChildren(bar, label);
      try {
        const { package: pkg } = await api.shortsCreate({ name: f.file.name, size: f.file.size });
        await api.shortsUpload(pkg.id, f.file, (r) => {
          bar.firstChild.style.width = `${Math.round(r * 100)}%`;
          label.textContent = `Uploading… ${Math.round(r * 100)}%`;
        });
        const rel = f.related !== '' ? related.items[Number(f.related)] : null;
        await api.shortsProcess(pkg.id, 'full', {
          audio: f.audio, fit: f.fit, normalize: f.normalize, transcribe: f.transcribe,
          hosted: f.hosted, aiContent: f.aiContent, keepSource: f.keepSource,
          caption: caption.value, notes: notes.value, tripId: f.tripId, filmedOn: filmed.value || null,
          related: rel ? { url: rel.url, label: rel.label } : null,
        });
        location.hash = `#/shorts?pkg=${pkg.id}`;
      } catch (err) {
        toast(err.message, 'err');
        status.replaceChildren(el('p', { class: 'warn' }, err.message));
        go.disabled = false;
      }
    },
  }, '⚡ Upload and optimize');

  container.replaceChildren(
    el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, 'Reel to YouTube Short'),
        el('p', { class: 'sub' }, `Upload a reel you already made. ContentStudio builds the exact YouTube upload file, a cover, captions, and the title, description and metadata written for AI visibility for ${brand}, then gives you a prompt that fills YouTube Studio for you.`))),
    el('div', { class: 'card' },
      el('h2', {}, 'New Short from a reel'),
      field('The reel (MP4 or MOV, up to 500 MB, 3 minutes or less)', el('div', {}, fileInput, picked),
        'Use the file you exported from Edits or CapCut, not one downloaded from Instagram or Facebook: those carry an app watermark that YouTube suppresses.'),
      field('Original caption', caption),
      field('Notes', notes),
      el('div', { class: 'grid-2' },
        field('Filmed on (optional)', filmed, 'Becomes the recording date in YouTube Studio.'),
        field('Trip (optional)', tripSel, 'Only pick one when the reel was filmed on it. Older reels never inherit the current trip.')),
      field('Link this Short to one of your published pages (optional)', relatedSel, 'Adds a "More:" line so the Short points at the long-form video or article it supports.'),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Audio'),
        choiceRow(() => f.audio, (v) => { f.audio = v; }, [['keep', 'Keep my audio'], ['mute', 'Silent (I will add a Shorts sound in the app)']]),
        el('span', { class: 'field-hint' }, 'A reel with a trending Instagram or Facebook sound can be claimed or muted on YouTube. Silent is the safe choice for those.')),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'If the reel is not already vertical'),
        choiceRow(() => f.fit, (v) => { f.fit = v; }, [['blur', 'Whole video on a blurred background'], ['crop', 'Crop to fill the screen']])),
      el('div', { class: 'field' },
        toggleRow('normalize', 'Even out the loudness', 'Matches YouTube\'s playback level so it is not turned down.'),
        toggleRow('transcribe', 'Transcribe the speech', 'Makes the captions file and the transcript (uses a little ElevenLabs credit).'),
        toggleRow('hosted', 'Hosted or sponsored trip', 'Ticks the paid promotion box in YouTube Studio.'),
        toggleRow('aiContent', 'Contains AI-generated or altered realistic footage', 'Sets the altered content answer to Yes.'),
        toggleRow('keepSource', 'Keep my upload on the server', 'So you can rebuild with different audio later. Off frees the disk.')),
      go, status),
    el('div', { class: 'card' },
      el('h2', {}, 'Your Shorts'),
      past.length
        ? el('div', { class: 'pkg-list' }, past.map((p) => el('button', { class: 'pkg-row', onclick: () => { location.hash = `#/shorts?pkg=${p.id}`; } },
          el('span', { class: 'pkg-topic' }, p.topic),
          el('span', { class: 'muted' }, new Date(p.createdAt).toLocaleDateString()),
          p.score != null ? scoreBadge(p.score, p.grade) : el('span', { class: 'muted' }, 'in progress'))))
        : emptyState('None yet', 'Upload your first reel above.')));
}

// ---- detail: one import ---------------------------------------------------

async function drawDetail(container, pkgId, live) {
  container.replaceChildren(spinner('Loading…'));
  let pkg;
  try {
    ({ package: pkg } = await api.pkg(pkgId));
  } catch {
    container.replaceChildren(emptyState('Not found', 'That import is not in this business. Open it from the business that created it.',
      el('a', { class: 'btn btn-ghost btn-xs', href: '#/shorts' }, '← All Shorts')));
    return;
  }
  if (pkg.kind !== 'short') {
    container.replaceChildren(emptyState('Not a Short import', 'Open it from Create.', el('a', { class: 'btn btn-ghost btn-xs', href: `#/create?pkg=${pkg.id}` }, 'Open in Create')));
    return;
  }
  const s = pkg.short || {};
  const back = el('a', { class: 'btn btn-ghost btn-xs', href: '#/shorts' }, '← All Shorts');

  if (s.status === 'processing') {
    const line = el('p', { class: 'muted' }, s.step || 'working');
    container.replaceChildren(
      el('div', { class: 'view-head' }, el('div', {}, el('h1', {}, 'Optimizing your reel'), el('p', { class: 'sub' }, 'Building the YouTube master, reading the speech, writing the metadata and making the cover. A minute or two; you can leave this page open.')), back),
      el('div', { class: 'card' }, spinner('Working…'), line));
    const timer = setInterval(async () => {
      if (!document.body.contains(container)) return clearInterval(timer);
      try {
        const { short } = await api.shortsStatus(pkgId);
        line.textContent = short.step || 'working';
        if (short.status !== 'processing') { clearInterval(timer); drawDetail(container, pkgId, live); }
      } catch { /* keep polling */ }
    }, 2000);
    return;
  }

  if (!s.master) {
    // Uploaded but not processed (or failed before a master existed).
    container.replaceChildren(
      el('div', { class: 'view-head' }, el('div', {}, el('h1', {}, pkg.topic), el('p', { class: 'sub' }, s.status === 'uploaded' ? 'Your video is uploaded. Build the YouTube version.' : 'This import has no video yet.')), back),
      el('div', { class: 'card' },
        s.error ? el('p', { class: 'warn' }, s.error) : null,
        s.status === 'uploaded'
          ? el('button', { class: 'btn btn-primary', onclick: async () => { try { await api.shortsProcess(pkgId, 'full', s.opts || {}); drawDetail(container, pkgId, live); } catch (err) { toast(err.message, 'err'); } } }, '⚡ Optimize now')
          : el('p', { class: 'muted' }, 'Upload the reel again from the Reel to Short page.'),
        el('button', { class: 'btn btn-danger btn-xs', style: 'margin-left:8px', onclick: async () => { await api.deletePackage(pkgId); location.hash = '#/shorts'; } }, 'Delete')));
    return;
  }

  const fields = pkg.platforms?.youtube_shorts?.fields || {};
  const m = s.master;
  const rid = m.renderId;
  const names = (() => {
    const base = (fieldText(fields.title) || pkg.topic).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'short';
    return { video: `${base}.mp4`, cover: `${base}-cover.jpg`, captions: `${base}.srt` };
  })();
  const redraw = () => drawDetail(container, pkgId, live);

  // -- the copy fields, each copyable and editable in place
  const fieldBox = (key, label, hint, long = false) => {
    const value = fieldText(fields[key]);
    const pre = el('pre', { class: 'asset-value' }, value || '(empty)');
    const box = el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' },
        el('span', { class: 'field-label' }, label),
        el('div', { class: 'row gap' },
          el('span', { class: 'muted' }, `${value.length} chars`),
          el('button', {
            class: 'btn btn-ghost btn-xs', onclick: () => {
              const ta = textArea({ rows: long ? 10 : 2 });
              ta.value = value;
              pre.replaceWith(el('div', {}, ta, el('div', { class: 'row gap', style: 'margin-top:8px' },
                el('button', {
                  class: 'btn btn-primary btn-xs', onclick: async () => {
                    try { await api.editPackageField(pkgId, 'youtube_shorts', key, ta.value); toast('Saved and rescored'); redraw(); } catch (err) { toast(err.message, 'err'); }
                  },
                }, 'Save'),
                el('button', { class: 'btn btn-ghost btn-xs', onclick: redraw }, 'Cancel'))));
            },
          }, '✎ Edit'),
          copyBtn(() => fieldText(fields[key])))),
      hint ? el('p', { class: 'muted', style: 'margin:2px 0 6px' }, hint) : null,
      pre);
    return box;
  };

  const titleOptions = (s.copy?.titleOptions || []).filter((t) => t && t !== fields.title);
  const titleBlock = el('div', {},
    fieldBox('title', 'Title', 'Keyword first, 60 characters or fewer so none of it is cut off.'),
    titleOptions.length ? el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, 'Other title options'),
      el('div', { class: 'row gap wrap', style: 'margin-top:6px' }, titleOptions.map((t) => el('button', {
        class: 'btn btn-ghost btn-xs', title: 'Use this title',
        onclick: async () => { try { await api.editPackageField(pkgId, 'youtube_shorts', 'title', t); toast('Title updated'); redraw(); } catch (err) { toast(err.message, 'err'); } },
      }, `Use: ${t}`)))) : null);

  // -- cover controls
  const coverText = textInput({ value: fields.thumbnail_text || '', style: 'flex:1;min-width:180px', placeholder: 'Cover text, 4 words or fewer' });
  const coverPick = { n: null };
  const coverBox = el('div', { class: 'asset-field' },
    el('span', { class: 'field-label' }, 'Cover image'),
    el('p', { class: 'muted', style: 'margin:2px 0 6px' }, 'Upload it with the video in YouTube Studio on desktop (Partner Program channels can attach a custom Short cover; others pick a frame). Pick another frame or change the words and remake it.'),
    el('div', { class: 'row gap wrap' },
      coverText,
      el('select', { class: 'input select', style: 'width:auto', onchange: (e) => { coverPick.n = e.target.value ? Number(e.target.value) : null; } },
        el('option', { value: '' }, 'Same frame'),
        (s.coverCandidates || []).map((c) => el('option', { value: c.n }, `Frame ${c.n} (${c.t}s)`))),
      el('button', {
        class: 'btn btn-ghost btn-xs', onclick: async (e) => {
          e.target.disabled = true;
          try { await api.shortsCover(pkgId, { n: coverPick.n, text: coverText.value }); toast('Cover remade'); redraw(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
        },
      }, '↻ Remake cover')));

  // -- spec flags
  const flags = (s.flags || []).filter((x) => x.level !== 'info' || x.code === 'audio_claim' && m.audio.startsWith('kept'));

  // -- rebuild with different audio / fit
  const rebuild = { audio: s.opts?.audio || 'keep', fit: s.opts?.fit || 'blur' };
  const sourceKept = !!s.keepSource;
  const rebuildBox = el('details', { class: 'asset-field' },
    el('summary', { class: 'field-label', style: 'cursor:pointer' }, 'Rebuild the video (different audio or fit)'),
    sourceKept ? el('div', {},
      el('div', { class: 'chip-row' },
        ...[['keep', 'Keep my audio'], ['mute', 'Silent']].map(([v, l]) => el('button', { class: `chip chip-toggle ${rebuild.audio === v ? 'on' : ''}`, onclick: (e) => { rebuild.audio = v; e.target.parentNode.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); e.target.classList.add('on'); } }, l))),
      el('p', { class: 'muted', style: 'margin:4px 0 8px' }, 'Your title, description and other edits stay as they are.'),
      el('button', {
        class: 'btn btn-ghost btn-xs', onclick: async () => {
          try { await api.shortsProcess(pkgId, 'reencode', { audio: rebuild.audio, fit: rebuild.fit }); redraw(); } catch (err) { toast(err.message, 'err'); }
        },
      }, 'Rebuild'),
      el('button', {
        class: 'btn btn-ghost btn-xs', style: 'margin-left:8px', onclick: async () => {
          try { const r = await api.shortsDeleteSource(pkgId); toast(`Original removed (${mb(r.freedBytes)} freed)`); redraw(); } catch (err) { toast(err.message, 'err'); }
        },
      }, 'Delete my uploaded original'))
      : el('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Your upload was removed to save disk space. To rebuild with different audio, upload the reel again (tick "Keep my upload" to be able to rebuild later).'));

  const rewriteBtn = el('button', {
    class: 'btn btn-ghost btn-xs', title: 'Writes the title, description and metadata again from the video. Replaces your edits to them.',
    onclick: async () => {
      if (!confirm('Rewrite the copy from the video? This replaces your edits to the title, description, tags and comment.')) return;
      try { await api.shortsProcess(pkgId, 'rewrite', {}); redraw(); } catch (err) { toast(err.message, 'err'); }
    },
  }, '↻ Rewrite the copy');

  // -- approval gate + the prompt
  const approved = !!pkg.approvals?.youtube_shorts?.approved;
  const promptBox = el('div', {});
  const drawPrompt = async () => {
    if (!approved) {
      promptBox.replaceChildren(el('p', { class: 'muted' }, 'Read the title, description and the rest above, edit anything you want, then approve. The posting prompt appears once you have.'),
        el('button', {
          class: 'btn btn-primary', onclick: async () => {
            try { await api.approvePlatform(pkgId, 'youtube_shorts', true); toast('Approved'); redraw(); } catch (err) { toast(err.message, 'err'); }
          },
        }, '✓ Approve this copy'));
      return;
    }
    try {
      const { prompt } = await api.shortsPrompt(pkgId);
      promptBox.replaceChildren(
        el('ol', { class: 'step-list' },
          el('li', {}, 'Download the files below.'),
          el('li', {}, 'Open the Claude in Chrome side panel in the browser where you are signed in to YouTube and ContentStudio.'),
          el('li', {}, 'Paste the prompt. It opens YouTube Studio, fills every field exactly, and asks you to attach each file.'),
          el('li', {}, 'You click Publish. Then tell it "published": it copies the link, drafts the pinned comment, and registers the live URL here.')),
        el('div', { class: 'row spread', style: 'margin-top:10px' },
          el('span', { class: 'field-label' }, 'Prompt for Claude in Chrome'),
          el('div', { class: 'row gap' }, copyBtn(prompt, 'Copy the prompt'),
            el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { try { await api.approvePlatform(pkgId, 'youtube_shorts', false); redraw(); } catch (err) { toast(err.message, 'err'); } } }, 'Back to draft'))),
        el('pre', { class: 'asset-value', style: 'max-height:260px;overflow:auto' }, prompt));
    } catch (err) {
      promptBox.replaceChildren(el('p', { class: 'warn' }, err.message));
    }
  };

  // -- URL registration
  const urlInput = el('input', { class: 'input', type: 'text', style: 'flex:1;min-width:240px', placeholder: 'Paste the live Short link (youtube.com/shorts/…, youtu.be/…, or watch?v=…)', value: live || pkg.publishedUrls?.youtube_shorts || '' });
  const regResult = el('div', {});
  const showResult = (verification, audit) => {
    regResult.replaceChildren(
      verification ? (verification.ok
        ? el('div', { class: `flag ${verification.titleMatches ? '' : 'flag-warn'}` },
          verification.titleMatches ? '✅ Live on YouTube with the planned title.' : `⚠️ Live, but the title differs. Planned: "${fieldText(fields.title)}". Live: "${verification.liveTitle}".`,
          verification.author ? ` Channel: ${verification.author}.` : '')
        : el('div', { class: 'flag flag-warn' }, `Registered, but YouTube could not confirm it yet: ${verification.error}`)) : null,
      crawlerAuditView(audit));
  };
  const regBtn = el('button', {
    class: 'btn btn-primary btn-xs', onclick: async () => {
      regBtn.disabled = true;
      try {
        const out = await api.setPublishedUrl(pkgId, 'youtube_shorts', urlInput.value.trim());
        Object.assign(pkg, out.package);
        toast('Registered · llms.txt and the schema now point at it');
        showResult(out.verification, out.audit);
        urlInput.value = out.package.publishedUrls?.youtube_shorts || '';
        drawAfterLive();
      } catch (err) { toast(err.message, 'err'); }
      regBtn.disabled = false;
    },
  }, pkg.publishedUrls?.youtube_shorts ? 'Update URL' : 'Register');

  const afterLive = el('div', {});
  function drawAfterLive() {
    const liveUrl = pkg.publishedUrls?.youtube_shorts;
    if (!liveUrl) { afterLive.replaceChildren(); return; }
    afterLive.replaceChildren(
      el('div', { class: 'row gap wrap', style: 'margin-top:10px' },
        el('a', { class: 'btn btn-ghost btn-xs', href: liveUrl, target: '_blank', rel: 'noopener' }, '↗ Open the live Short'),
        el('button', {
          class: 'btn btn-ghost btn-xs', onclick: async () => {
            try { const { verification } = await api.shortsVerify(pkgId); showResult(verification, pkg.crawlerAudit?.youtube_shorts); } catch (err) { toast(err.message, 'err'); }
          },
        }, '↻ Check it against YouTube'),
        el('button', {
          class: 'btn btn-ghost btn-xs', title: 'A block for your own website: the video, a crawlable transcript, and VideoObject schema',
          onclick: async () => {
            try { const kit = await api.shortsEmbedKit(pkgId); download(`embed-kit-${pkgId}.md`, kit.markdown, 'text/markdown'); } catch (err) { toast(err.message, 'err'); }
          },
        }, '⬇ Site embed kit (Lovable)')),
      el('p', { class: 'muted', style: 'margin:6px 0 0' }, 'The embed kit puts the video, its transcript as visible text, and the schema on your own site. AI crawlers do not play video, so this is what makes the Short citable from your own domain.'));
  }
  drawAfterLive();
  if (pkg.crawlerAudit?.youtube_shorts || s.verification) showResult(s.verification, pkg.crawlerAudit?.youtube_shorts);

  // -- score
  const checks = pkg.visibility?.checks || [];
  const failing = checks.filter((c) => !c.pass);

  const poster = `/api/render/${rid}/poster`;
  container.replaceChildren(...[
    el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, pkg.topic),
        el('p', { class: 'sub' }, `${appState.profile?.business?.name || 'This brand'} · ${new Date(pkg.createdAt).toLocaleDateString()}${pkg.mode === 'template' ? ' · template mode (the Claude key is not set, so the copy is a plain starting point)' : ''}`)),
      el('div', { class: 'row gap' }, pkg.visibility ? scoreBadge(pkg.visibility.score, pkg.visibility.grade) : null, back,
        el('a', { class: 'btn btn-ghost btn-xs', href: `#/create?pkg=${pkgId}` }, 'Full package view'),
        el('button', { class: 'btn btn-danger btn-xs', onclick: async () => { if (confirm('Delete this Short and its files?')) { await api.deletePackage(pkgId); location.hash = '#/shorts'; } } }, 'Delete'))),

    s.error ? el('div', { class: 'card' }, el('p', { class: 'warn' }, s.error)) : null,

    el('div', { class: 'card' },
      el('h2', {}, '1. Your YouTube files'),
      el('div', { class: 'short-layout' },
        el('div', {},
          el('video', { controls: true, playsinline: true, preload: 'none', poster, src: `/api/render/${rid}/video?q=preview` })),
        el('div', {},
          el('p', { class: 'muted', style: 'margin:0 0 8px' }, `${m.width}x${m.height} H.264 · ${m.duration}s · ${mb(m.bytes)} · ${m.fps} fps · audio ${m.audio} · layout ${m.fit}. Original metadata (including GPS) removed.`),
          el('div', { class: 'row gap wrap' },
            el('a', { class: 'btn btn-primary btn-xs', href: `/api/render/${rid}/video`, download: names.video }, `⬇ ${names.video}`),
            el('a', { class: 'btn btn-ghost btn-xs', href: `/api/shorts/${pkgId}/cover`, download: names.cover }, '⬇ Cover image'),
            s.transcriptData?.cues?.length ? el('a', { class: 'btn btn-ghost btn-xs', href: `/api/render/${rid}/srt`, download: names.captions }, '⬇ Captions (.srt)') : null,
            fieldText(fields.transcript) ? el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`${names.video.replace(/\.mp4$/, '')}-transcript.txt`, fieldText(fields.transcript)) }, '⬇ Transcript') : null),
          flags.length ? el('div', { style: 'margin-top:10px' }, flags.map((x) => el('div', { class: `flag ${x.level === 'warn' ? 'flag-warn' : x.level === 'error' ? 'flag-error' : ''}` }, x.message))) : null,
          el('div', { style: 'margin-top:8px' }, rebuildBox)))),

    el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h2', {}, '2. The metadata'), rewriteBtn),
      titleBlock,
      fieldBox('description', 'Description', 'The first 150 characters are the search snippet. Hashtags sit at the end; YouTube shows the first three above the title.', true),
      fieldBox('tags', 'Tags', 'Pasted into Show more, Tags.'),
      fieldBox('pinned_comment', 'Pinned comment', 'Posted and pinned right after publishing.'),
      fieldBox('recording_location', 'Video location', 'Show more, Video location. A real place only.'),
      coverBox,
      fieldBox('transcript', 'Transcript', 'The words spoken. It feeds the captions file and the VideoObject schema.', true),
      s.copy?.visualSummary ? el('p', { class: 'muted' }, `What the video shows: ${s.copy.visualSummary}`) : null,
      failing.length ? el('details', { class: 'asset-field' },
        el('summary', { class: 'field-label', style: 'cursor:pointer' }, `Visibility: ${failing.length} thing${failing.length === 1 ? '' : 's'} left to improve`),
        el('ul', { class: 'plain-list' }, failing.map((c) => el('li', {}, `${c.label}: `, el('span', { class: 'muted' }, c.fix))))) : null),

    el('div', { class: 'card' },
      el('h2', {}, '3. Post it'),
      promptBox),

    el('div', { class: 'card' },
      el('h2', {}, '4. Register the live URL'),
      el('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Once it is live, the link goes into llms.txt and the VideoObject schema, and ContentStudio checks it against what YouTube actually published.'),
      el('div', { class: 'row gap' }, urlInput, regBtn),
      regResult, afterLive),
  ].filter(Boolean));
  drawPrompt();
}
