import { api, appState } from './api.js';
import { el, toast, spinner, emptyState, textInput } from './ui.js';

// ---- EXIF (JPEG): capture date + GPS so real-world context rides along ---

export function parseExif(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xffd8) return {};
    let offset = 2;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      const size = view.getUint16(offset + 2);
      if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
        return parseTiff(view, offset + 10);
      }
      if ((marker & 0xff00) !== 0xff00) break;
      offset += 2 + size;
    }
  } catch { /* unreadable EXIF is fine */ }
  return {};
}

function parseTiff(view, start) {
  const little = view.getUint16(start) === 0x4949;
  const u16 = (o) => view.getUint16(start + o, little);
  const u32 = (o) => view.getUint32(start + o, little);
  const out = {};

  const readIfd = (ifdOffset, handler) => {
    const count = u16(ifdOffset);
    for (let i = 0; i < count; i++) {
      const e = ifdOffset + 2 + i * 12;
      handler(u16(e), e);
    }
    return u32(ifdOffset + 2 + count * 12);
  };
  const ascii = (entry) => {
    const len = u32(entry + 4);
    const off = len > 4 ? u32(entry + 8) : entry + 8;
    let s = '';
    for (let i = 0; i < len - 1; i++) s += String.fromCharCode(view.getUint8(start + off + i));
    return s;
  };
  const rationals = (entry, n) => {
    const off = u32(entry + 8);
    const vals = [];
    for (let i = 0; i < n; i++) vals.push(u32(off + i * 8) / (u32(off + i * 8 + 4) || 1));
    return vals;
  };

  let exifPtr = 0; let gpsPtr = 0;
  readIfd(u32(4), (tag, entry) => {
    if (tag === 0x0132) out.date = ascii(entry);
    if (tag === 0x8769) exifPtr = u32(entry + 8);
    if (tag === 0x8825) gpsPtr = u32(entry + 8);
  });
  if (exifPtr) readIfd(exifPtr, (tag, entry) => {
    if (tag === 0x9003) out.date = ascii(entry);
  });
  if (gpsPtr) {
    let latRef = 'N'; let lonRef = 'E'; let lat; let lon;
    readIfd(gpsPtr, (tag, entry) => {
      if (tag === 1) latRef = ascii(entry) || 'N';
      if (tag === 2) lat = rationals(entry, 3);
      if (tag === 3) lonRef = ascii(entry) || 'E';
      if (tag === 4) lon = rationals(entry, 3);
    });
    if (lat && lon) {
      const toDec = (d) => d[0] + d[1] / 60 + d[2] / 3600;
      out.gps = {
        lat: +(toDec(lat) * (latRef === 'S' ? -1 : 1)).toFixed(5),
        lon: +(toDec(lon) * (lonRef === 'W' ? -1 : 1)).toFixed(5),
      };
    }
  }
  if (out.date) {
    const m = out.date.match(/(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
    if (m) out.takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
    delete out.date;
  }
  return out;
}

// HEIC/HEIF (the iPhone default) wraps EXIF differently than JPEG: locate the
// embedded "Exif\0\0" payload by byte scan, then parse the TIFF block as usual.
export function scanForExif(buffer) {
  const bytes = new Uint8Array(buffer);
  const limit = bytes.length - 8;
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69
      && bytes[i + 3] === 0x66 && bytes[i + 4] === 0 && bytes[i + 5] === 0) {
      try {
        const out = parseTiff(new DataView(buffer), i + 6);
        if (out.takenAt || out.gps) return out;
      } catch { /* keep scanning */ }
    }
  }
  return {};
}

async function extractImageExif(file) {
  try {
    const head = await file.slice(0, 2 * 1024 * 1024).arrayBuffer();
    if (file.type === 'image/jpeg' || /jpe?g$/i.test(file.name)) {
      const viaMarkers = parseExif(head);
      if (viaMarkers.takenAt || viaMarkers.gps) return viaMarkers;
    }
    return scanForExif(head);
  } catch {
    return {};
  }
}

// iPhone videos carry GPS as an ISO6709 string ("+38.6270-090.1994+…") in
// QuickTime metadata, near the start or end of the file.
async function extractVideoGps(file) {
  try {
    const chunks = [await file.slice(0, 2 * 1024 * 1024).arrayBuffer()];
    if (file.size > 2.5 * 1024 * 1024) {
      chunks.push(await file.slice(file.size - 512 * 1024).arrayBuffer());
    }
    const dec = new TextDecoder('latin1');
    for (const c of chunks) {
      const m = dec.decode(c).match(/([+-]\d{1,3}\.\d{3,8})([+-]\d{1,3}\.\d{3,8})/);
      if (m) return { lat: +(+m[1]).toFixed(5), lon: +(+m[2]).toFixed(5) };
    }
  } catch { /* no gps */ }
  return null;
}

// Bounded-concurrency pool: keeps N files in flight so decode, canvas work,
// uploads, and AI calls overlap instead of queueing single-file.
async function pool(items, limit, worker) {
  const queue = items.map((item, i) => [i, item]);
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const [i, item] = queue.shift();
      try {
        results[i] = await worker(item, i);
      } catch (err) {
        results[i] = { __error: err.message, __name: item.name || String(i) };
      }
    }
  }));
  return results;
}

// ---- thumbnail + analysis frame extraction -------------------------------

function drawScaled(source, w, h, max) {
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const canvasB64 = (canvas, q) => canvas.toDataURL('image/jpeg', q).split(',')[1];

async function imageFrames(file) {
  // Ask the browser to decode already-downscaled: a 48MP HEIC becomes a
  // ~1600px bitmap instead of a ~190MB full-resolution one.
  let bitmap = await createImageBitmap(file, { resizeWidth: 1600, resizeQuality: 'medium' }).catch(() => null);
  if (!bitmap) bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);
    return frames(img, img.naturalWidth, img.naturalHeight);
  }
  const result = frames(bitmap, bitmap.width, bitmap.height);
  bitmap.close?.();
  return result;
}

const placeholderThumb = (() => {
  let cached = null;
  return () => {
    if (!cached) {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1a2032'; ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#8b96b0'; ctx.font = '28px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('▶ video', 160, 128);
      cached = c.toDataURL('image/jpeg', 0.7).split(',')[1];
    }
    return cached;
  };
})();

function frames(source, w, h) {
  return {
    w, h,
    thumbB64: canvasB64(drawScaled(source, w, h, 360), 0.72),
    analysisB64: canvasB64(drawScaled(source, w, h, 800), 0.74),
    renderB64: canvasB64(drawScaled(source, w, h, 1920), 0.82),
  };
}

// A video that can't produce a frame must never wedge the import: after the
// timeout it resolves with a placeholder poster and the file still comes in
// with its date, GPS, and metadata intact.
function videoFrames(file, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = el('video', {
      muted: true, playsinline: true, preload: 'auto',
      style: 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;',
    });
    video.muted = true;
    document.body.append(video);
    let settled = false;
    const fallback = () => ({ w: null, h: null, thumbB64: placeholderThumb(), analysisB64: null, timedOut: true });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.remove();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish(fallback()), timeoutMs);
    video.onloadeddata = () => {
      try { video.currentTime = Math.min(0.6, (video.duration || 1) / 3); } catch { finish(fallback()); }
    };
    video.onseeked = () => {
      try {
        const result = frames(video, video.videoWidth, video.videoHeight);
        result.duration = Math.round(video.duration || 0);
        finish(result);
      } catch { finish(fallback()); }
    };
    video.onerror = () => finish(fallback());
    video.src = url;
    video.load();
    video.play().then(() => video.pause()).catch(() => { /* decode nudge only */ });
  });
}

// ---- import + analyze pipeline -------------------------------------------

async function importFiles(files, onStatus) {
  // Duplicate detection runs on the server: the library can hold tens of
  // thousands of items, far too many to download just to compare file names.
  const existing = [];
  for (let i = 0; i < files.length; i += 2000) {
    const { items } = await api.matchMedia(files.slice(i, i + 2000).map((f) => ({ name: f.name, size: f.size })));
    existing.push(...items);
  }
  const byKey = new Map(existing.map((i) => [`${i.name}|${i.size}`, i]));
  const fresh = [];
  const retrofits = [];
  let skipped = 0;
  for (const f of files) {
    const match = byKey.get(`${f.name}|${f.size}`);
    if (!match) fresh.push(f);
    // A video imported before full-footage uploads existed only has a
    // preview frame on the server. Re-importing the same file attaches the
    // real footage to the existing item instead of skipping it.
    else if (match.kind === 'video' && !match.hasOriginal && f.type.startsWith('video')) {
      retrofits.push({ name: f.name, file: f, item: match });
    } else skipped += 1;
  }

  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }

  const total = fresh.length + retrofits.length;
  let done = 0;
  let timedOut = 0;
  const tick = (note) => onStatus(
    `${note || 'Importing'} ${done}/${total}${skipped ? ` · ${skipped} already in library` : ''}…`);
  tick();

  const work = async (file) => {
    const isVideo = file.type.startsWith('video');
    const [exif, gps, f] = await Promise.all([
      isVideo ? {} : extractImageExif(file),
      isVideo ? extractVideoGps(file) : null,
      isVideo ? videoFrames(file) : imageFrames(file),
    ]);
    if (f.timedOut) timedOut += 1;
    const { item } = await api.addMedia({
      name: file.name, mime: file.type || 'application/octet-stream',
      kind: isVideo ? 'video' : 'image', size: file.size,
      w: f.w, h: f.h,
      takenAt: exif.takenAt || (file.lastModified ? new Date(file.lastModified).toISOString() : null),
      gps: exif.gps || gps || null,
      thumbB64: f.thumbB64, analysisB64: f.analysisB64, renderB64: f.renderB64 || null,
    });
    if (isVideo) {
      tick(`Uploading ${file.name} footage,`);
      try {
        await api.uploadMediaOriginal(item.id, file);
        item.hasOriginal = true;
      } catch (err) {
        toast(`${file.name}: kept the preview frame only (${err.message}); renders will show a still for this one`, 'err');
      }
    }
    done += 1;
    tick();
    return item;
  };

  const attachOriginal = async ({ name, file, item }) => {
    tick(`Uploading ${name} footage,`);
    await api.uploadMediaOriginal(item.id, file);
    item.hasOriginal = true;
    done += 1;
    tick();
    return item;
  };

  // Photos fan out; videos go single-file — parallel video decode is what
  // stalls phone browsers.
  const [imageResults, videoResults, retrofitResults] = await Promise.all([
    pool(fresh.filter((f) => !f.type.startsWith('video')), 3, work),
    pool(fresh.filter((f) => f.type.startsWith('video')), 1, work),
    pool(retrofits, 1, attachOriginal),
  ]);
  try { await wake?.release?.(); } catch { /* released with tab */ }

  const results = [...imageResults, ...videoResults, ...retrofitResults];
  for (const r of results) {
    if (r?.__error) toast(`${r.__name}: ${r.__error}`, 'err');
  }
  const attached = retrofitResults.filter((r) => r && !r.__error).length;
  if (attached) toast(`${attached} video(s) now carry their full footage; new renders will use real clips`);
  if (skipped) toast(`${skipped} file(s) already imported, skipped instantly`);
  if (timedOut) toast(`${timedOut} video(s) saved without a preview frame (kept date/GPS; this device couldn't decode them)`, 'err');
  return results.filter((r) => r && !r.__error);
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const dateRange = (a, b) => (!a ? '' : fmtDate(a).slice(0, 40) === fmtDate(b).slice(0, 40) ? fmtDate(a) : `${fmtDate(a)} to ${fmtDate(b)}`);
const PAGE = 200;

export function renderLibrary(root) {
  const container = el('div', { class: 'view' });
  const aiReady = appState.health?.providers?.anthropic;
  const view = { tab: 'all', q: '', kind: '', sort: 'taken', favorite: false, album: null, albumName: null };
  const data = { items: [], total: 0, held: 0, pending: 0, loading: false };

  const status = el('div', { class: 'import-status' });
  const summary = el('p', { class: 'sub lib-summary' });
  const body = el('div', {});
  const tabs = el('div', { class: 'tab-row' });

  // ---- analysis (server-side queue, newest captures first) -------------
  let pollTimer = null;
  const pollAnalysis = async () => {
    clearTimeout(pollTimer);
    try {
      const { state } = await api.mediaAnalysis();
      if (state.running) {
        status.replaceChildren(spinner(`Analyzing ${state.done}/${state.total}${state.held ? ` · ${state.held} held for review` : ''}${state.failed ? ` · ${state.failed} failed` : ''}…`));
        pollTimer = setTimeout(pollAnalysis, 2500);
        return;
      }
      if (status.firstChild) {
        status.replaceChildren();
        if (state.stopped) toast(`Analysis stopped: ${state.stopped}`, 'err');
        else toast(`Analysis finished: ${state.done} item(s)${state.held ? `, ${state.held} held for review` : ''}`);
        await loadFirstPage();
      }
    } catch { /* transient; the next action retries */ }
  };

  const analyzeAll = async () => {
    if (!aiReady) return toast('Analysis needs the Claude key on the server', 'err');
    try {
      const { estimate } = await api.startAnalysis({ dryRun: true });
      if (!estimate.items) return toast('Everything is already analyzed');
      const ok = window.confirm(`Analyze ${estimate.items.toLocaleString()} item(s), newest captures first?\n\nRough size: ${(estimate.approxInputTokens / 1e6).toFixed(1)}M input tokens and ${(estimate.approxOutputTokens / 1e6).toFixed(1)}M output tokens. It runs on the server, so you can close this page.`);
      if (!ok) return;
      await api.startAnalysis({});
      status.replaceChildren(spinner('Analyzing…'));
      pollAnalysis();
    } catch (err) { toast(err.message, 'err'); }
  };

  // ---- in-app import ------------------------------------------------------
  const fileInput = el('input', {
    class: 'hidden-input', type: 'file', multiple: true, accept: 'image/*,video/*', id: 'media-picker',
    onchange: async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const imported = await importFiles(files, (msg) => status.replaceChildren(spinner(msg)));
      status.replaceChildren();
      e.target.value = '';
      await loadFirstPage();
      toast(`${imported.length} asset(s) imported`);
      if (aiReady && imported.length) { try { await api.startAnalysis({}); status.replaceChildren(spinner('Analyzing…')); pollAnalysis(); } catch (err) { toast(err.message, 'err'); } }
    },
  });

  // ---- all items (paginated, filterable) --------------------------------
  const grid = el('div', { class: 'media-grid' });
  const more = el('div', { class: 'row gap', style: 'justify-content:center;margin:14px 0' });
  const loadPage = async (reset) => {
    if (data.loading) return;
    data.loading = true;
    try {
      const r = await api.media({
        limit: PAGE, offset: reset ? 0 : data.items.length, sort: view.sort, q: view.q,
        kind: view.kind, favorite: view.favorite, album: view.album,
      });
      data.items = reset ? r.items : [...data.items, ...r.items];
      Object.assign(data, { total: r.total, held: r.held, pending: r.pending });
    } finally { data.loading = false; }
    drawGridInto();
    drawSummary();
  };
  const loadFirstPage = () => loadPage(true);

  const drawSummary = () => {
    summary.replaceChildren(`${data.total.toLocaleString()} item${data.total === 1 ? '' : 's'}${view.q || view.kind || view.favorite || view.album ? ' match' : ''}${data.pending ? ` · ${data.pending.toLocaleString()} being screened` : ''}${data.held ? ` · ${data.held.toLocaleString()} held` : ''}. Your photos and videos, enriched with AI-visibility metadata and matched to content.`);
    const heldTab = tabs.querySelector('[data-tab="held"]');
    if (heldTab) heldTab.textContent = `Held${data.held ? ` (${data.held})` : ''}`;
  };

  const drawGridInto = () => {
    grid.replaceChildren();
    if (!data.items.length) {
      grid.append(emptyState(data.total === 0 && !view.q && !view.album && !view.kind && !view.favorite ? 'This library is empty' : 'Nothing matches',
        data.total === 0 && !view.q && !view.album && !view.kind && !view.favorite
          ? 'Import photos and videos here, or load your whole Photos library with the Photos sync tool (tools/photos-sync). Each asset is screened, then AI writes alt text, keywords, and story ideas.'
          : 'Try a different search or clear the filters.'));
    } else {
      for (const item of data.items) grid.append(mediaCard(item, () => loadFirstPage()));
    }
    more.replaceChildren(data.items.length < data.total
      ? el('button', { class: 'btn btn-ghost', onclick: () => loadPage(false) }, `Show more (${(data.total - data.items.length).toLocaleString()} left)`)
      : '');
  };

  let searchTimer = null;
  const allView = () => {
    const search = textInput({
      placeholder: 'Search captions, keywords, places, file names…', value: view.q, style: 'max-width:340px',
      oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { view.q = e.target.value.trim(); loadFirstPage(); }, 280); },
    });
    const sel = (opts, key) => {
      const s = el('select', { class: 'input', onchange: (e) => { view[key] = e.target.value; loadFirstPage(); } },
        opts.map(([v, label]) => el('option', { value: v, ...(view[key] === v ? { selected: true } : {}) }, label)));
      return s;
    };
    const fav = el('label', { class: 'row gap', style: 'align-items:center;font-size:13px' },
      el('input', { type: 'checkbox', ...(view.favorite ? { checked: true } : {}), onchange: (e) => { view.favorite = e.target.checked; loadFirstPage(); } }), 'Favorites');
    const albumChip = view.album ? el('span', { class: 'chip chip-toggle on', onclick: () => { view.album = null; view.albumName = null; drawBody(); loadFirstPage(); } }, `Album: ${view.albumName || 'selected'}  ✕`) : null;
    return el('div', {},
      view.album ? albumPanel(view.album) : null,
      el('div', { class: 'row gap wrap lib-toolbar' },
        search,
        sel([['', 'Photos and videos'], ['image', 'Photos only'], ['video', 'Videos only']], 'kind'),
        sel([['taken', 'Newest captures'], ['added', 'Recently added'], ['quality', 'Best quality']], 'sort'),
        fav, albumChip),
      grid, more);
  };

  // ---- albums -----------------------------------------------------------
  const albumPanel = (albumId) => {
    const box = el('div', { class: 'profile-box' }, spinner('Loading album…'));
    api.album(albumId).then(({ album }) => {
      const p = album.profile;
      const list = (title, arr) => (arr?.length ? el('div', {}, el('span', { class: 'field-label' }, title), el('div', { class: 'chip-row' }, arr.map((x) => el('span', { class: 'chip' }, x)))) : null);
      box.replaceChildren(
        el('div', { class: 'row spread' },
          el('div', {},
            el('h3', { style: 'margin:0' }, album.name),
            el('span', { class: 'muted' }, [album.folder?.length ? album.folder.join(' / ') : null, `${album.stats.items.toLocaleString()} items (${album.stats.photos} photos, ${album.stats.videos} videos)`, dateRange(album.stats.from, album.stats.to), album.stats.places?.slice(0, 3).join(', ')].filter(Boolean).join(' · '))),
          el('button', {
            class: 'btn btn-ghost btn-xs',
            onclick: async (e) => {
              e.target.textContent = 'Building…';
              try { await api.buildAlbumProfile(albumId); drawBody(); loadFirstPage(); } catch (err) { toast(err.message, 'err'); e.target.textContent = p ? 'Rebuild profile' : 'Build profile'; }
            },
          }, p ? 'Rebuild profile' : '✦ Build profile')),
        p ? el('div', {},
          el('p', { style: 'margin:8px 0' }, p.summary),
          p.mood ? el('p', { class: 'muted', style: 'margin:0 0 6px' }, `Mood: ${p.mood}`) : null,
          list('Themes', p.themes), list('Best uses', p.bestUses), list('Supports pillars', p.pillarsFit),
          list('Topic ideas', p.suggestedTopics), list('Missing shots', p.gaps),
          p.heroIds?.length ? el('div', {}, el('span', { class: 'field-label' }, 'Hero shots'),
            el('div', { class: 'mini-media-row' }, p.heroIds.map((id) => el('img', { class: 'mini-thumb', src: `/api/media/${id}/thumb`, alt: 'hero shot' })))) : null)
          : el('p', { class: 'muted' }, album.stats.analyzed ? 'No profile yet. Build one and the engine will know how this album can be used.' : 'Analyze this album first, then build its profile.'));
    }).catch((err) => box.replaceChildren(el('span', { class: 'muted' }, err.message)));
    return box;
  };

  const albumsView = () => {
    const wrap = el('div', {}, spinner('Loading albums…'));
    api.albums().then(({ albums }) => {
      const pending = albums.filter((a) => !a.hasProfile && a.stats.analyzed).length;
      wrap.replaceChildren(
        el('div', { class: 'row gap wrap lib-toolbar' },
          el('span', { class: 'muted' }, `${albums.length.toLocaleString()} album${albums.length === 1 ? '' : 's'}`),
          el('button', {
            class: 'btn btn-ghost btn-xs', disabled: !aiReady || !pending,
            title: 'Builds a profile for every analyzed album that has none: what it is, where and when, and how it can be used in content.',
            onclick: async () => {
              try { await api.buildAllProfiles(); toast('Building album profiles in the background'); } catch (err) { toast(err.message, 'err'); }
            },
          }, `✦ Build ${pending} album profile${pending === 1 ? '' : 's'}`)),
        albums.length ? el('div', { class: 'media-grid album-grid' }, albums.map((a) => el('div', {
          class: 'media-card album-card', onclick: () => { view.album = a.id; view.albumName = a.name; view.tab = 'all'; drawTabs(); drawBody(); loadFirstPage(); },
        },
          el('div', { class: 'media-thumb-wrap' }, a.stats.coverId ? el('img', { class: 'media-thumb', src: `/api/media/${a.stats.coverId}/thumb`, alt: a.name, loading: 'lazy' }) : null,
            a.hasProfile ? el('span', { class: 'media-analyzed', title: 'AI profile ready' }, '✦') : null),
          el('div', { class: 'media-meta' },
            el('strong', {}, a.name),
            el('span', { class: 'muted' }, `${a.stats.items.toLocaleString()} items${a.stats.videos ? ` · ${a.stats.videos} videos` : ''}`),
            a.stats.from ? el('span', { class: 'muted' }, dateRange(a.stats.from, a.stats.to)) : null,
            a.summary ? el('span', { class: 'muted album-summary' }, a.summary) : null))))
          : emptyState('No albums yet', 'Albums come from your Photos app through the Photos sync tool, so every collection you built stays a collection here.'));
    }).catch((err) => wrap.replaceChildren(emptyState('Could not load albums', err.message)));
    return wrap;
  };

  // ---- held review (private: filenames and reasons only, never an image) --
  const heldView = () => {
    const wrap = el('div', {}, spinner('Loading…'));
    api.moderation().then(({ counts, held, scan }) => {
      wrap.replaceChildren(
        el('div', { class: 'profile-box' },
          el('strong', {}, 'Nothing here is shown as an image.'),
          el('p', { class: 'muted', style: 'margin:6px 0 0' },
            'Anything flagged as nudity or sexual content, by the check on your Mac or by the AI check here, is held. Its files are deleted from storage, it never appears in selection, renders or publishing, and it can only come back if you approve it below and then run the Photos sync again. Artwork such as statues is held too, so you decide.'),
          el('div', { class: 'row gap', style: 'margin-top:10px' },
            el('button', {
              class: 'btn btn-ghost btn-xs', disabled: !aiReady,
              title: 'Runs the same safety check over items imported before screening existed. Clean ones are stamped clear; flagged ones are held.',
              onclick: async () => {
                try {
                  const { items } = await api.scanLegacy({ dryRun: true });
                  if (!items) return toast('Every item has already been checked');
                  if (!window.confirm(`Safety-check ${items.toLocaleString()} older item(s)? One small AI call each.`)) return;
                  await api.scanLegacy({});
                  toast('Safety check running in the background');
                } catch (err) { toast(err.message, 'err'); }
              },
            }, '✦ Safety-check older items'),
            scan?.running ? el('span', { class: 'muted' }, `Checking ${scan.done}/${scan.total}…`) : null)),
        held.length ? el('div', { class: 'held-list' }, held.map((h) => el('div', { class: 'held-row' },
          el('div', {}, el('strong', {}, h.name), el('span', { class: 'muted' }, ` ${h.takenAt ? fmtDate(h.takenAt) : ''}`),
            el('div', { class: 'muted' }, `${h.reason || 'held'} · ${h.source === 'mac-local' ? 'held on your Mac, never uploaded' : 'held by the AI check'}`)),
          h.releaseApproved
            ? el('div', { class: 'row gap' }, el('span', { class: 'chip' }, 'Approved: uploads on next sync'),
              el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { await api.revokeRelease(h.id); drawBody(); } }, 'Undo'))
            : el('button', { class: 'btn btn-ghost btn-xs', onclick: async () => { await api.approveRelease(h.id); toast('Approved. It uploads again on the next Photos sync.'); drawBody(); } }, 'Approve for next sync'))))
          : emptyState('Nothing is held', `${counts.pending ? `${counts.pending} item(s) are still being screened. ` : ''}Flagged items will be listed here by file name, with the reason.`));
    }).catch((err) => wrap.replaceChildren(emptyState('Could not load', err.message)));
    return wrap;
  };

  // ---- tabs --------------------------------------------------------------
  const drawBody = () => { body.replaceChildren(view.tab === 'albums' ? albumsView() : view.tab === 'held' ? heldView() : allView()); if (view.tab === 'all') drawGridInto(); };
  const drawTabs = () => {
    tabs.replaceChildren(...[['all', 'All'], ['albums', 'Albums'], ['held', `Held${data.held ? ` (${data.held})` : ''}`]].map(([id, label]) =>
      el('button', { class: `tab ${view.tab === id ? 'active' : ''}`, 'data-tab': id, onclick: () => { view.tab = id; drawTabs(); drawBody(); } }, label)));
  };

  container.append(
    el('div', { class: 'view-head' },
      el('div', {}, el('h1', {}, 'Media Library'), summary),
      el('div', { class: 'row gap' },
        el('label', { class: 'btn btn-primary', for: 'media-picker' }, '⬆ Import from device'),
        el('button', { class: 'btn btn-ghost', onclick: analyzeAll }, aiReady ? '✦ Analyze all' : '✦ Analyze all (needs Claude key)'))),
    fileInput, status, tabs, body,
  );

  drawTabs();
  drawBody();
  loadFirstPage().then(pollAnalysis);
  root.replaceChildren(container);
}

function mediaCard(item, refresh) {
  const detail = el('div', { class: 'media-detail' });
  let open = false;
  const screening = item.moderation?.status === 'pending';

  const card = el('div', { class: 'media-card' },
    el('div', {
      class: 'media-thumb-wrap',
      onclick: () => { open = !open; drawDetail(); },
    },
      el('img', { class: 'media-thumb', src: `/api/media/${item.id}/thumb`, alt: item.alt || item.name, loading: 'lazy' }),
      el('span', {
        class: 'media-kind',
        title: item.kind !== 'video' ? '' : (item.hasOriginal
          ? 'Full footage stored: renders use the real moving clip'
          : 'Only a preview frame is stored. Re-import this video file and the footage attaches automatically, so renders can use the real clip'),
      }, item.kind === 'video' ? (item.hasOriginal ? '▶ video' : '▶ frame only') : 'photo'),
      screening ? el('span', { class: 'media-flag', title: 'Not selectable until the safety check on this item passes' }, 'screening') : null,
      item.apple?.favorite ? el('span', { class: 'media-fav', title: 'Favorite in Photos' }, '♥') : null,
      item.analyzed ? el('span', { class: 'media-analyzed' }, '✦') : null),
    el('div', { class: 'media-meta' },
      el('strong', {}, item.caption || item.name),
      item.takenAt ? el('span', { class: 'muted' }, new Date(item.takenAt).toLocaleDateString()) : null,
      item.place ? el('span', { class: 'muted' }, `📍 ${item.place}`) : null),
    detail,
  );

  const drawDetail = () => {
    detail.replaceChildren();
    if (!open) return;
    const altInput = textInput({
      value: item.alt || '',
      placeholder: 'Alt text (<= 125 chars, entity-rich)',
      onchange: async (e) => { await api.updateMedia(item.id, { alt: e.target.value }); toast('Alt text saved'); },
    });
    detail.append(
      el('div', { class: 'detail-block' },
        el('span', { class: 'field-label' }, 'Alt text'), altInput,
        item.keywords?.length ? el('div', { class: 'chip-row' }, item.keywords.map((k) => el('span', { class: 'chip' }, k))) : null,
        item.storyIdeas?.length ? el('ul', { class: 'plain-list' }, item.storyIdeas.map((s) => el('li', {}, `💡 ${s}`))) : null,
        el('div', { class: 'row gap' },
          el('a', {
            class: 'btn btn-ghost btn-xs',
            href: `/api/media/${item.id}/file`,
            download: '',
            title: 'Download the full-quality stored copy with a keyword filename. Pair it with the alt text above when posting: platforms strip embedded photo metadata, so the alt text field is what carries it.',
          }, '⬇ Download'),
          item.kind === 'video' && item.hasOriginal ? el('a', {
            class: 'btn btn-ghost btn-xs',
            href: `/api/media/${item.id}/file/muted`,
            download: '',
            title: 'Same footage with audio removed — for silent autoplay or adding your own music',
          }, '⬇ No sound') : null,
          el('button', {
            class: 'btn btn-ghost btn-xs', onclick: async () => {
              detail.replaceChildren(spinner('Analyzing…'));
              try {
                const r = await api.analyzeMedia(item.id);
                if (r.held) toast('This item was held for review and removed from the library', 'err');
                await refresh();
              } catch (err) { toast(err.message, 'err'); drawDetail(); }
            },
          }, item.analyzed ? 'Re-analyze' : '✦ Analyze'),
          el('button', {
            class: 'btn btn-danger btn-xs', onclick: async () => {
              await api.deleteMedia(item.id);
              toast('Removed');
              await refresh();
            },
          }, 'Remove'))),
    );
  };

  return card;
}
