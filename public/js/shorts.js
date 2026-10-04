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
  const yt = params?.get('yt');
  if (yt) { toast(yt, yt.startsWith('Connected') ? 'ok' : 'err'); history.replaceState(null, '', '#/shorts'); }
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

  const f = { file: null, audio: 'keep', fit: 'blur', normalize: true, transcribe: true, hosted: false, commission: false, aiContent: false, keepSource: false, tripId: 'none', related: '' };
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
  const hostedBy = textInput({ placeholder: 'Hosted by (optional, for example the property or company name)' });
  const scheduleAt = el('input', { type: 'datetime-local', class: 'input' });
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
          hosted: f.hosted, hostedBy: hostedBy.value, commission: f.commission, scheduleAt: scheduleAt.value || null, aiContent: f.aiContent, keepSource: f.keepSource,
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
      field('Schedule it (optional)', scheduleAt, 'The posting prompt sets this date and time instead of publishing right away.'),
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
        toggleRow('hosted', 'Hosted or sponsored trip', 'Ticks the paid promotion box and adds a disclosure line.'),
        hostedBy,
        toggleRow('commission', 'My link can earn a commission', 'Adds a plain commission line to the description.'),
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
        : emptyState('None yet', 'Upload your first reel above.')),
    insightsCard());
}

// ---- channel connection, results across Shorts, insights, channel audit -----

function insightsCard() {
  const box = el('div', { class: 'card' }, el('h2', {}, 'Results and what is working'), spinner('Loading…'));
  const draw = async () => {
    let ov; let st;
    try { [ov, st] = await Promise.all([api.measureOverview(), api.youtubeStatus()]); } catch (err) { box.replaceChildren(el('h2', {}, 'Results and what is working'), el('p', { class: 'warn' }, err.message)); return; }
    const kids = [el('h2', {}, 'Results and what is working')];
    if (!ov.connected) {
      kids.push(el('p', { class: 'muted' }, 'Connect this business\'s YouTube channel and the studio reads what each Short actually did at 48 hours, 7 days and 28 days: views, how long people watch, where they leave, and where they came from. Each brand connects its own channel and learns only from its own results.'));
      if (st.config.oauth) {
        kids.push(el('a', { class: 'btn btn-primary btn-xs', href: '/api/youtube/connect' }, 'Connect YouTube (read only)'));
      } else {
        kids.push(el('p', { class: 'warn' }, 'The server needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first. Create an OAuth client of type Web application in Google Cloud, enable the YouTube Data API and YouTube Analytics API, and add this redirect URI:'),
          el('pre', { class: 'asset-value code' }, st.redirectUri),
          st.config.apiKey ? el('p', { class: 'muted' }, 'A YOUTUBE_API_KEY is set, so public view and like counts already work.') : el('p', { class: 'muted' }, 'With only a YOUTUBE_API_KEY (no OAuth) you still get public view, like and comment counts and trend watch.'));
      }
    } else {
      kids.push(el('div', { class: 'row spread' },
        el('p', { class: 'muted', style: 'margin:0' }, `Connected: ${ov.channel?.title || 'channel'}${ov.channel?.subscribers != null ? ` · ${ov.channel.subscribers} subscribers` : ''}`),
        el('div', { class: 'row gap' },
          el('button', { class: 'btn btn-ghost btn-xs', onclick: async (e) => { e.target.disabled = true; try { const a = await api.channelAudit(); auditBox.replaceChildren(...auditView(a)); } catch (err) { toast(err.message, 'err'); } e.target.disabled = false; } }, 'Audit the channel'),
          el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { if (confirm('Disconnect YouTube for this business?')) { await api.youtubeDisconnect(); draw(); } } }, 'Disconnect'))));
    }
    const auditBox = el('div', {});
    kids.push(auditBox);
    if (ov.videos.length) {
      kids.push(el('div', { class: 'asset-field' },
        el('span', { class: 'field-label' }, 'Live videos'),
        el('div', { class: 'pkg-list' }, ov.videos.map((v) => el('button', { class: 'pkg-row', onclick: () => { location.hash = v.kind === 'short' ? `#/shorts?pkg=${v.id}` : `#/create?pkg=${v.id}`; } },
          el('span', { class: 'pkg-topic' }, v.topic),
          el('span', { class: 'muted' }, v.latest ? `${v.latest.views} views${v.latest.avp != null ? ` · ${Math.round(v.latest.avp)}% viewed` : ''} · ${v.latest.ageHours != null ? `${Math.round(v.latest.ageHours / 24)}d old` : 'checked'}` : 'not measured yet'))))));
    }
    const L = ov.learning;
    if (L.measured >= 3) {
      kids.push(el('div', { class: 'row spread' },
        el('p', { class: 'muted', style: 'margin:0' }, `${L.measured} Shorts measured${L.bestHour ? ` · best posting hour so far: ${L.bestHour.hour}:00 Central (median ${L.bestHour.medianViews} views over ${L.bestHour.n})` : ''}.`),
        el('button', { class: 'btn btn-ghost btn-xs', onclick: async (e) => { e.target.disabled = true; try { await api.measureInsights(); draw(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; } } }, ov.insights ? '↻ Refresh the insights' : '✦ Explain what is working')));
    } else if (ov.connected) {
      kids.push(el('p', { class: 'muted' }, 'Insights unlock after 3 measured Shorts. Results arrive 48 hours after each one is registered, and the copy for new Shorts starts learning from them at 4.'));
    }
    if (ov.insights) {
      kids.push(el('div', { class: 'asset-field' },
        el('span', { class: 'field-label' }, `Findings (from ${ov.insights.basedOn} Shorts)`),
        el('ul', { class: 'plain-list' }, ov.insights.findings.map((x) => el('li', {}, x))),
        el('span', { class: 'field-label' }, 'Do next'),
        el('ul', { class: 'plain-list' }, ov.insights.doNext.map((x) => el('li', {}, x)))));
    }
    box.replaceChildren(...kids);
  };
  draw();
  return box;
}

const auditView = (a) => [
  el('p', { class: 'muted', style: 'margin:8px 0 4px' }, `Channel audit: ${a.channel.title}`),
  el('ul', { class: 'plain-list' }, a.checks.map((c) => el('li', {}, `${c.pass ? '✓' : '✗'} ${c.label}`, c.fix ? el('span', { class: 'muted' }, ` · ${c.fix}`) : null))),
];

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
    if (!approved || !s.consent?.faces) {
      const c1 = el('input', { type: 'checkbox' });
      const c2 = el('input', { type: 'checkbox' });
      const go = el('button', {
        class: 'btn btn-primary', onclick: async () => {
          if (!c1.checked || !c2.checked) return toast('Tick both statements first', 'err');
          try {
            await api.shortsConsent(pkgId);
            if (!approved) await api.approvePlatform(pkgId, 'youtube_shorts', true);
            toast('Approved'); redraw();
          } catch (err) { toast(err.message, 'err'); }
        },
      }, '✓ Confirm and approve this copy');
      promptBox.replaceChildren(
        el('p', { class: 'muted' }, 'Read the title, description and the rest above, edit anything you want, then confirm and approve. The posting prompt appears once you have.'),
        el('label', { class: 'row gap', style: 'margin:6px 0;align-items:flex-start' }, c1, el('span', {}, 'Anyone recognizable in this video (clients, minors, other guests) has agreed to appear, or I have chosen to keep the video as it is.')),
        el('label', { class: 'row gap', style: 'margin:6px 0 10px;align-items:flex-start' }, c2, el('span', {}, 'The footage, voice and any music are mine or licensed to me for YouTube. Nothing in it belongs to a supplier or another creator without permission.')),
        go);
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
    s.duplicateOf ? el('div', { class: 'card' }, el('p', { class: 'warn', style: 'margin:0' }, `This looks like the same video as "${s.duplicateOf.topic}" (identical file). Posting it twice can read as repetitive: open that one instead unless this is deliberate. `), el('a', { class: 'btn btn-ghost btn-xs', style: 'margin-top:8px', href: `#/shorts?pkg=${s.duplicateOf.id}` }, 'Open the first one')) : null,

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

    resultsCard(pkg, redraw),
    afterPostingCard(pkg, redraw),
  ].filter(Boolean));
  drawPrompt();
}


// ---- results for one video ---------------------------------------------------

function sparkline(points) {
  const W = 300; const H = 70;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(H));
  const max = Math.max(1, ...points.map((p) => p.ratio));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(p.t * W).toFixed(1)},${(H - 4 - (p.ratio / max) * (H - 8)).toFixed(1)}`).join(' ');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#7c6cff'); path.setAttribute('stroke-width', '2');
  svg.append(path);
  return svg;
}

function resultsCard(pkg, redraw) {
  const live = pkg.publishedUrls?.youtube_shorts;
  const r = pkg.results || {};
  const snaps = (r.snapshots || []).slice().sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0));
  const latest = snaps[0];
  const kids = [el('h2', {}, '5. Results')];
  if (!live) {
    kids.push(el('p', { class: 'muted' }, 'Register the live URL above and results start arriving: public numbers right away, and the full picture (watch time, where viewers leave, traffic sources) at 48 hours, 7 days and 28 days once YouTube is connected.'));
    return el('div', { class: 'card' }, ...kids);
  }
  const check = el('button', {
    class: 'btn btn-ghost btn-xs', onclick: async (e) => {
      e.target.disabled = true;
      try { const out = await api.resultsCheck(pkg.id); Object.assign(pkg, out.package); toast('Results updated'); redraw(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
    },
  }, '↻ Check now');
  kids.push(el('div', { class: 'row spread' }, el('p', { class: 'muted', style: 'margin:0' }, latest ? `Last checked ${new Date(r.lastCheckedAt).toLocaleString()}` : 'Not measured yet.'), check));
  if (latest) {
    const stat = (label, value) => el('div', { style: 'min-width:110px' }, el('div', { class: 'muted' }, label), el('div', { style: 'font-size:20px;font-weight:600' }, value));
    kids.push(el('div', { class: 'row gap wrap', style: 'margin:10px 0' },
      stat('Views', String(latest.views)),
      latest.avp != null ? stat('Average viewed', `${Math.round(latest.avp)}%`) : null,
      latest.avd != null ? stat('Avg watch', `${Math.round(latest.avd)}s`) : null,
      latest.likes != null ? stat('Likes', String(latest.likes)) : null,
      latest.shares != null ? stat('Shares', String(latest.shares)) : null,
      latest.subs != null ? stat('Subscribers gained', String(latest.subs)) : null));
    if (latest.traffic?.length) {
      const total = latest.traffic.reduce((a, t) => a + t.views, 0) || 1;
      kids.push(el('p', { class: 'muted', style: 'margin:0 0 8px' }, `Where views came from: ${latest.traffic.map((t) => `${t.source.replace(/_/g, ' ').toLowerCase()} ${Math.round((t.views / total) * 100)}%`).join(', ')}`));
    }
    if (latest.retention?.length) {
      kids.push(el('div', { class: 'asset-field' }, el('span', { class: 'field-label' }, 'Who is still watching, second by second'), sparkline(latest.retention)));
    }
    for (const v of latest.findings?.verdicts || []) kids.push(el('div', { class: 'flag' }, v));
    if (latest.source === 'public') kids.push(el('p', { class: 'muted' }, 'Public numbers only. Connect YouTube (Reel to Short home page) for watch time, retention and traffic sources.'));
    if (latest.errors?.length) kids.push(el('p', { class: 'muted' }, `Some numbers were unavailable: ${latest.errors.join('; ')}`));
  }
  const pct = el('input', { class: 'input', type: 'number', min: 0, max: 100, style: 'width:110px', placeholder: 'Viewed %', value: r.manual?.viewedPct ?? '' });
  kids.push(el('div', { class: 'asset-field' },
    el('span', { class: 'field-label' }, 'Viewed vs swiped away (from YouTube Studio)'),
    el('p', { class: 'muted', style: 'margin:2px 0 6px' }, 'Studio, Analytics, Content, Shorts shows what share viewed instead of swiping past. Type the viewed percentage here: it is the strongest single sign the opening works (75 to 80 is healthy), and the studio learns from it.'),
    el('div', { class: 'row gap' }, pct, el('button', {
      class: 'btn btn-ghost btn-xs', onclick: async () => {
        try { const out = await api.resultsManual(pkg.id, { viewedPct: pct.value }); Object.assign(pkg, out.package); toast('Saved'); redraw(); } catch (err) { toast(err.message, 'err'); }
      },
    }, 'Save'))));
  return el('div', { class: 'card' }, ...kids);
}

// ---- translations and reply drafts ---------------------------------------------

const LANG_NAMES = { es: 'Spanish', fr: 'French', pt: 'Portuguese', de: 'German', it: 'Italian' };

function afterPostingCard(pkg, redraw) {
  const s = pkg.short || {};
  const kids = [el('h2', {}, '6. Reach further')];
  // translated captions
  if (s.transcriptData?.cues?.length) {
    const picked = new Set();
    const row = el('div', { class: 'chip-row' }, Object.entries(LANG_NAMES).map(([code, name]) => {
      const done = !!s.translations?.[code];
      const chip = el('button', { class: 'chip chip-toggle', onclick: () => { picked.has(code) ? picked.delete(code) : picked.add(code); chip.classList.toggle('on'); } }, done ? `${name} ✓` : name);
      return chip;
    }));
    kids.push(el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, 'Captions in other languages'),
      el('p', { class: 'muted', style: 'margin:2px 0 6px' }, 'Extra caption languages make the Short findable in more searches. Names and places stay as they are. Download each file and add it under Subtitles in YouTube Studio (the posting prompt covers it once they exist).'),
      row,
      el('div', { class: 'row gap wrap' },
        el('button', {
          class: 'btn btn-ghost btn-xs', onclick: async (e) => {
            if (!picked.size) return toast('Pick a language first', 'err');
            e.target.disabled = true;
            try { const out = await api.shortsTranslate(pkg.id, [...picked]); Object.assign(pkg, out.package); toast('Translated'); redraw(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
          },
        }, '✦ Translate'),
        ...Object.keys(s.translations || {}).map((l) => el('a', { class: 'btn btn-ghost btn-xs', href: `/api/shorts/${pkg.id}/captions/${l}` }, `⬇ ${LANG_NAMES[l]} captions`)))));
  }
  // reply drafts
  const box = textArea({ rows: 4, placeholder: 'Paste comments from your Short, one per line. Replies are drafted in your voice; you read and post each one yourself.' });
  const out = el('div', {});
  kids.push(el('div', { class: 'asset-field' },
    el('span', { class: 'field-label' }, 'Draft replies to comments'),
    el('p', { class: 'muted', style: 'margin:2px 0 6px' }, 'Replies in the first hour are an engagement signal. Drafts only: nothing is posted.'),
    box,
    el('button', {
      class: 'btn btn-ghost btn-xs', style: 'margin-top:6px', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const { replies } = await api.shortsReplies(pkg.id, box.value.split('\n'));
          out.replaceChildren(...replies.map((r) => el('div', { class: 'asset-field' },
            el('p', { class: 'muted', style: 'margin:0' }, `“${r.comment}”`),
            el('div', { class: 'row spread' }, el('pre', { class: 'asset-value', style: 'flex:1' }, r.reply), copyBtn(r.reply)))));
        } catch (err) { toast(err.message, 'err'); }
        e.target.disabled = false;
      },
    }, '✦ Draft replies'),
    out));
  return el('div', { class: 'card' }, ...kids);
}
