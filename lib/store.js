import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.CONTENTSTUDIO_DATA || path.join(process.cwd(), 'data');
const WS_ROOT = path.join(DATA_DIR, 'workspaces');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');
fs.mkdirSync(WS_ROOT, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });

const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const SNAPSHOT_KEEP = 12;

function takeSnapshot(file) {
  try {
    if (!fs.existsSync(file)) return;
    const dir = path.join(path.dirname(file), 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((f) => /^state-\d+\.json$/.test(f)).sort();
    const latestTs = existing.length ? Number(existing.at(-1).match(/(\d+)/)[1]) : 0;
    if (Date.now() - latestTs < SNAPSHOT_INTERVAL_MS) return;
    fs.copyFileSync(file, path.join(dir, `state-${Date.now()}.json`));
    for (const old of existing.slice(0, Math.max(0, existing.length - (SNAPSHOT_KEEP - 1)))) {
      fs.unlinkSync(path.join(dir, old));
    }
  } catch { /* snapshots are best-effort */ }
}

function jsonFile(file, fallback, opts = {}) {
  let cache = fallback;
  try {
    if (fs.existsSync(file)) cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cache = fallback;
  }
  let timer = null;
  const flush = () => {
    timer = null;
    if (opts.snapshots) takeSnapshot(file);
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

const EMPTY_STATE = {
  profile: {
    business: {},
    interview: { answers: {}, brief: null },
    voiceDna: { sources: [], summary: null },
    pillars: [],
    series: [],
  },
  settings: {},
};

const registry = jsonFile(path.join(DATA_DIR, 'workspaces.json'), { items: [], activeId: null });
const handles = new Map();

const wsDir = (id) => path.join(WS_ROOT, String(id).replace(/[^a-z0-9_-]/gi, ''));

function handlesFor(id) {
  if (!handles.has(id)) {
    const dir = wsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    handles.set(id, {
      state: jsonFile(path.join(dir, 'state.json'), structuredClone(EMPTY_STATE), { snapshots: true }),
      packages: jsonFile(path.join(dir, 'packages.json'), { items: [] }),
    });
  }
  return handles.get(id);
}

// ---- shared media library (all workspaces read and write the same pool) --
// Media used to live under each workspace's own media.json/media/ folder;
// every business now shares one library.json + library/ folder instead, so
// one bulk import is visible to every workspace's AI selection and manual
// picks. Each item carries `businesses: [workspaceId, ...]` for provenance
// and filtering, but nothing restricts selection to those ids.
const libraryHandle = jsonFile(path.join(DATA_DIR, 'library.json'), { items: [] });

// One-time-per-workspace migration: move any pre-existing per-workspace
// media (files + catalog) into the shared library, tagged with that
// workspace's id. Uses fs.renameSync (same disk, no extra space, no
// copy-then-delete window) and is gated per workspace on its own
// media.json still existing, so it is safe to run on every boot and never
// redoes work that already landed in the shared library.
function migrateMediaToLibrary() {
  for (const w of registry.get().items) {
    const dir = wsDir(w.id);
    const wsMediaJson = path.join(dir, 'media.json');
    if (!fs.existsSync(wsMediaJson)) continue;
    let wsMedia;
    try { wsMedia = JSON.parse(fs.readFileSync(wsMediaJson, 'utf8')); } catch (err) {
      console.warn(`media migration: could not read ${wsMediaJson}, leaving it in place (${err.message})`);
      continue;
    }
    const items = wsMedia.items || [];
    const srcMediaDir = path.join(dir, 'media');
    const lib = libraryHandle.get();
    const existingIds = new Set(lib.items.map((i) => i.id));
    const migrated = [];
    for (const item of items) {
      let id = item.id;
      if (existingIds.has(id)) id = uid(); // defends against a cross-workspace id collision
      for (const kind of ['thumb', 'analysis', 'render', 'original', 'original.part']) {
        const src = path.join(srcMediaDir, `${item.id}.${kind}`);
        if (!fs.existsSync(src)) continue;
        try { fs.renameSync(src, path.join(LIBRARY_DIR, `${id}.${kind}`)); } catch (err) {
          console.warn(`media migration: could not move ${src} (${err.message})`);
        }
      }
      migrated.push({ ...item, id, businesses: [w.id] });
      existingIds.add(id);
    }
    if (migrated.length) {
      libraryHandle.set({ items: [...lib.items, ...migrated] });
      libraryHandle.flush();
      console.log(`media migration: moved ${migrated.length} item(s) from workspace "${w.name || w.id}" into the shared library`);
    }
    try { fs.renameSync(wsMediaJson, `${wsMediaJson}.migrated`); } catch { /* best effort; safe to retry next boot */ }
  }
}

// One-time migration: single-profile installs (data/state.json at the root)
// become the first workspace, keeping everything already entered.
(function migrateAndSeed() {
  const legacyState = path.join(DATA_DIR, 'state.json');
  if (!registry.get().items.length && fs.existsSync(legacyState)) {
    const id = uid();
    const dir = wsDir(id);
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    for (const f of ['state.json', 'media.json', 'packages.json']) {
      const src = path.join(DATA_DIR, f);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(dir, f));
    }
    const legacyMedia = path.join(DATA_DIR, 'media');
    if (fs.existsSync(legacyMedia)) {
      for (const f of fs.readdirSync(legacyMedia)) {
        fs.renameSync(path.join(legacyMedia, f), path.join(dir, 'media', f));
      }
      try { fs.rmdirSync(legacyMedia); } catch { /* leave non-empty dir */ }
    }
    let name = 'My business';
    try {
      name = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).profile?.business?.name || name;
    } catch { /* fresh name */ }
    registry.set({ items: [{ id, name, createdAt: new Date().toISOString() }], activeId: id });
    registry.flush();
  }
  if (!registry.get().items.length) {
    const id = uid();
    handlesFor(id);
    registry.set({ items: [{ id, name: 'My business', createdAt: new Date().toISOString() }], activeId: id });
    registry.flush();
  }
  if (!registry.get().activeId) registry.update((r) => ({ ...r, activeId: r.items[0].id }));
})();

// Runs after workspace seeding so a brand-new legacy-migrated workspace's
// media.json (created above) is swept into the shared library too.
migrateMediaToLibrary();

const activeId = () => registry.get().activeId;
const active = () => handlesFor(activeId());

function syncName() {
  const name = active().state.get()?.profile?.business?.name;
  if (!name) return;
  registry.update((r) => ({
    ...r,
    items: r.items.map((w) => (w.id === r.activeId && w.name !== name ? { ...w, name } : w)),
  }));
}

export const stateStore = {
  get: () => active().state.get(),
  set: (v) => { const out = active().state.set(v); syncName(); return out; },
  update(fn) { return this.set(fn(this.get())); },
  flush: () => active().state.flush(),
};
export const mediaStore = {
  get: () => libraryHandle.get(),
  set: (v) => libraryHandle.set(v),
  update(fn) { return this.set(fn(this.get())); },
  flush: () => libraryHandle.flush(),
};
export const packageStore = {
  get: () => active().packages.get(),
  set: (v) => active().packages.set(v),
  update(fn) { return this.set(fn(this.get())); },
  flush: () => active().packages.flush(),
};

// ---- workspace management ------------------------------------------------

export function listWorkspaces() {
  const r = registry.get();
  return { items: r.items, activeId: r.activeId };
}

// The workspace active at the moment of a call — used to tag newly
// uploaded media with the business that brought it in, for provenance and
// filtering in a library every workspace otherwise shares equally.
export const currentWorkspaceId = () => activeId();

export function createWorkspace(name) {
  const id = uid();
  handlesFor(id);
  registry.update((r) => ({
    items: [...r.items, { id, name: name?.trim() || 'New business', createdAt: new Date().toISOString() }],
    activeId: id,
  }));
  registry.flush();
  return id;
}

export function activateWorkspace(id) {
  if (!registry.get().items.some((w) => w.id === id)) return false;
  registry.update((r) => ({ ...r, activeId: id }));
  registry.flush();
  return true;
}

export function renameWorkspace(id, name) {
  if (!name?.trim()) return false;
  registry.update((r) => ({
    ...r,
    items: r.items.map((w) => (w.id === id ? { ...w, name: name.trim() } : w)),
  }));
  return true;
}

export function deleteWorkspace(id) {
  const r = registry.get();
  if (r.items.length <= 1 || !r.items.some((w) => w.id === id)) return false;
  handles.delete(id);
  fs.rmSync(wsDir(id), { recursive: true, force: true });
  const items = r.items.filter((w) => w.id !== id);
  registry.set({ items, activeId: r.activeId === id ? items[0].id : r.activeId });
  registry.flush();
  return true;
}

// ---- state snapshots (active workspace) ----------------------------------

export function listSnapshots() {
  const dir = path.join(wsDir(activeId()), 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^state-\d+\.json$/.test(f))
    .sort()
    .reverse()
    .map((f) => ({ name: f, takenAt: new Date(Number(f.match(/(\d+)/)[1])).toISOString() }));
}

export function restoreSnapshot(name) {
  if (!/^state-\d+\.json$/.test(String(name))) return null;
  const file = path.join(wsDir(activeId()), 'snapshots', name);
  if (!fs.existsSync(file)) return null;
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  stateStore.set(snapshot);
  stateStore.flush();
  return snapshot;
}

export function workspaceDir() {
  return wsDir(activeId());
}

// ---- media files (shared library, not scoped to any one workspace) -------

export function mediaPath(id, kind) {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  return path.join(LIBRARY_DIR, `${safe}.${kind}`);
}

export function saveMediaFile(id, kind, buffer) {
  fs.writeFileSync(mediaPath(id, kind), buffer);
}

export function readMediaFile(id, kind) {
  const file = mediaPath(id, kind);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function deleteMediaFiles(id) {
  for (const kind of ['thumb', 'analysis', 'render', 'original', 'original.part']) {
    const file = mediaPath(id, kind);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
