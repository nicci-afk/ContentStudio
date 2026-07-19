import { api, appState } from './api.js';
import { el, toast, spinner, emptyState, textInput } from './ui.js';

// ---- EXIF (JPEG): capture date + GPS so real-world context rides along ---

function parseExif(buffer) {
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
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);
    return frames(img, img.naturalWidth, img.naturalHeight);
  }
  return frames(bitmap, bitmap.width, bitmap.height);
}

function frames(source, w, h) {
  return {
    w, h,
    thumbB64: canvasB64(drawScaled(source, w, h, 360), 0.72),
    analysisB64: canvasB64(drawScaled(source, w, h, 960), 0.78),
  };
}

function videoFrames(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = el('video', { muted: true, playsinline: true, preload: 'auto' });
    video.src = url;
    video.onloadeddata = () => { video.currentTime = Math.min(0.6, (video.duration || 1) / 3); };
    video.onseeked = () => {
      try {
        const result = frames(video, video.videoWidth, video.videoHeight);
        result.duration = Math.round(video.duration || 0);
        URL.revokeObjectURL(url);
        resolve(result);
      } catch (err) { reject(err); }
    };
    video.onerror = () => reject(new Error(`Could not decode ${file.name}`));
  });
}

// ---- import + analyze pipeline -------------------------------------------

async function importFiles(files, onStatus) {
  let done = 0;
  const results = [];
  for (const file of files) {
    onStatus(`Importing ${++done}/${files.length}: ${file.name}`);
    try {
      const isVideo = file.type.startsWith('video');
      let exif = {};
      if (/jpe?g$/i.test(file.name) || file.type === 'image/jpeg') {
        exif = parseExif(await file.slice(0, 256 * 1024).arrayBuffer());
      }
      const f = isVideo ? await videoFrames(file) : await imageFrames(file);
      const { item } = await api.addMedia({
        name: file.name, mime: file.type || 'application/octet-stream',
        kind: isVideo ? 'video' : 'image', size: file.size,
        w: f.w, h: f.h,
        takenAt: exif.takenAt || (file.lastModified ? new Date(file.lastModified).toISOString() : null),
        gps: exif.gps || null,
        thumbB64: f.thumbB64, analysisB64: f.analysisB64,
      });
      results.push(item);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'err');
    }
  }
  return results;
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
    for (const item of pending) {
      status.replaceChildren(spinner(`Analyzing ${++n}/${pending.length}: ${item.name}`));
      try {
        await api.analyzeMedia(item.id);
      } catch (err) {
        toast(`${item.name}: ${err.message}`, 'err');
        if (/not configured/i.test(err.message)) break;
      }
    }
    status.replaceChildren();
    await refresh();
    toast('Library analyzed — alt text, keywords, and story ideas attached');
  };

  const fileInput = el('input', {
    class: 'hidden-input', type: 'file', multiple: true, accept: 'image/*,video/*', id: 'media-picker',
    onchange: async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      await importFiles(files, (msg) => status.replaceChildren(spinner(msg)));
      status.replaceChildren();
      e.target.value = '';
      await refresh();
      toast(`${files.length} asset(s) imported`);
      if (aiReady) analyzeAll();
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
      el('span', { class: 'media-kind' }, item.kind === 'video' ? '▶ video' : 'photo'),
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
