import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.CONTENTSTUDIO_DATA || path.join(process.cwd(), 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

function jsonFile(name, fallback) {
  const file = path.join(DATA_DIR, name);
  let cache = fallback;
  try {
    if (fs.existsSync(file)) cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cache = fallback;
  }
  let timer = null;
  const flush = () => {
    timer = null;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    get: () => cache,
    set(value) {
      cache = value;
      if (!timer) timer = setTimeout(flush, 120);
      return cache;
    },
    update(fn) {
      return this.set(fn(cache));
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    },
  };
}

export const uid = () => crypto.randomBytes(8).toString('hex');

export const stateStore = jsonFile('state.json', {
  profile: {
    business: {},
    interview: { answers: {}, brief: null },
    voiceDna: { sources: [], summary: null },
    pillars: [],
    series: [],
  },
  settings: {},
});

export const mediaStore = jsonFile('media.json', { items: [] });
export const packageStore = jsonFile('packages.json', { items: [] });

export function mediaPath(id, kind) {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  return path.join(MEDIA_DIR, `${safe}.${kind}`);
}

export function saveMediaFile(id, kind, buffer) {
  fs.writeFileSync(mediaPath(id, kind), buffer);
}

export function readMediaFile(id, kind) {
  const file = mediaPath(id, kind);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function deleteMediaFiles(id) {
  for (const kind of ['thumb', 'analysis', 'original']) {
    const file = mediaPath(id, kind);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
