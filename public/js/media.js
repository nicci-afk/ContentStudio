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

async function importFiles(files, onStatus, existing = []) {
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

export function renderLibrary(root) {
  const container = el('div', { class: 'view' });
  let items = [];
  const aiReady = appState.health?.providers?.anthropic;

  const status = el('div', { class: 'import-status' });
  const grid = el('div', { class: 'media-grid' });

  const refresh = async () => {
    items = (await api.media()).items;
    drawGrid();
  };

  const analyzeAll = async () => {
    const pending = items.filter((i) => !i.analyzed);
    if (!pending.length) return toast('Everything is already analyzed');
    let n = 0;
    let stop = false;
    status.replaceChildren(spinner(`Analyzing 0/${pending.length} (3 in parallel)…`));
    const results = await pool(pending, 3, async (item) => {
      if (stop) return null;
      try {
        await api.analyzeMedia(item.id);
      } catch (err) {
        if (/not configured/i.test(err.message)) { stop = true; }
        throw err;
      }
      status.replaceChildren(spinner(`Analyzing ${++n}/${pending.length} (3 in parallel)…`));
      return item.id;
    });
    for (const r of results) {
      if (r?.__error && !stop) toast(`${r.__name}: ${r.__error}`, 'err');
    }
    status.replaceChildren();
    await refresh();
    toast(stop ? 'Analysis needs the Claude key on the server' : 'Library analyzed — alt text, keywords, geo, and story ideas attached');
  };

  const fileInput = el('input', {
    class: 'hidden-input', type: 'file', multiple: true, accept: 'image/*,video/*', id: 'media-picker',
    onchange: async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const imported = await importFiles(files, (msg) => status.replaceChildren(spinner(msg)), items);
      status.replaceChildren();
      e.target.value = '';
      await refresh();
      toast(`${imported.length} asset(s) imported`);
      if (aiReady && imported.length) analyzeAll();
    },
  });

  const drawGrid = () => {
    grid.replaceChildren();
    if (!items.length) {
      grid.append(emptyState('Your library is empty',
        'On iPhone, tap Import and Safari opens your photo library — select as many photos and videos as you like. The studio extracts capture dates and GPS, then AI writes alt text, keywords, and story ideas for every asset.'));
      return;
    }
    for (const item of items) grid.append(mediaCard(item, refresh));
  };

  container.append(
    el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, 'Media Library'),
        el('p', { class: 'sub' }, 'Your real photos and videos, enriched with AI-visibility metadata and matched to content.')),
      el('div', { class: 'row gap' },
        el('label', { class: 'btn btn-primary', for: 'media-picker' }, '⬆ Import from device'),
        el('button', { class: 'btn btn-ghost', onclick: analyzeAll }, aiReady ? '✦ Analyze all' : '✦ Analyze all (needs Claude key)'))),
    fileInput, status, grid,
  );

  refresh();
  root.replaceChildren(container);
}

function mediaCard(item, refresh) {
  const detail = el('div', { class: 'media-detail' });
  let open = false;

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
            title: 'Download the full-size stored copy with a keyword filename. Pair it with the alt text above when posting: platforms strip embedded photo metadata, so the alt text field is what carries it.',
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
              try { await api.analyzeMedia(item.id); await refresh(); }
              catch (err) { toast(err.message, 'err'); drawDetail(); }
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
