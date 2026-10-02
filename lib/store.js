import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

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
    // Consented client outcomes: the concrete, attributed proof E-E-A-T
    // (and Google ranking generally) rewards. Only ever cited in generated
    // copy or emitted as Review schema when consent is true.
    testimonials: [],
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
      // Leads live beside state but in their own file, so a whole-state save
      // from a stale browser tab can never wipe the ingest key or the leads.
      leads: jsonFile(path.join(dir, 'leads.json'), { items: [], settings: {} }),
      // Visibility Ledger: fixed buyer questions, monthly answer checks, manual entries.
      ledger: jsonFile(path.join(dir, 'ledger.json'), { questions: [], runs: [], settings: {} }),
      // Trips (calendar-backed): own file for the same reason as leads.
      trips: jsonFile(path.join(dir, 'trips.json'), { items: [] }),
    });
  }
  return handles.get(id);
}

// ---- shared media library (all workspaces read and write the same pool) --
// Media used to live under each workspace's own media.json/media/ folder;
// every business now shares one library.json + library/ folder instead, so
// one bulk import is visible to every workspace's AI selection and manual
// picks equally. Items migrated from a workspace's old per-business catalog
// still carry a `businesses` array from that one-time move, but nothing
// reads or writes it any more (new uploads carry no business tag at all —
// see server.js).
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

// The "active" workspace used to be one process-wide pointer, so two people
// (or two browsers) switching businesses overwrote each other and a stale
// tab saved whole-state into the wrong brand. Each request now carries its
// own workspace (cookie or X-Workspace header, applied by server.js through
// runWithWorkspace) and everything below resolves it via AsyncLocalStorage,
// which also follows the render and generation jobs a request starts. The
// registry pointer is only the fallback for callers that name nothing (boot
// code, Basic-auth API tools).
const ctx = new AsyncLocalStorage();
export const runWithWorkspace = (id, fn) => ctx.run({ wsId: id }, fn);
export const workspaceExists = (id) => registry.get().items.some((w) => w.id === id);

const activeId = () => {
  const id = ctx.getStore()?.wsId;
  return id && workspaceExists(id) ? id : registry.get().activeId;
};
const active = () => handlesFor(activeId());

// ---- photo libraries -----------------------------------------------------
// One catalog (library.json), many libraries: every media item and every
// workspace carries a library name. Existing items and workspaces carry
// none, which means 'travel', so the original shared pool is untouched.
// A workspace only ever sees, selects from, and renders with its own
// library; two businesses share photos by pointing at the same library.
export const DEFAULT_LIBRARY = 'travel';
export const cleanLibrary = (name) =>
  String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || null;
const libraryOfItem = (i) => i.library || DEFAULT_LIBRARY;
const libraryOfWorkspace = (id) =>
  registry.get().items.find((w) => w.id === id)?.library || DEFAULT_LIBRARY;
export const currentLibrary = () => libraryOfWorkspace(activeId());

function syncName() {
  const name = active().state.get()?.profile?.business?.name;
  if (!name) return;
  const id = activeId();
  registry.update((r) => ({
    ...r,
    items: r.items.map((w) => (w.id === id && !w.nameLocked && w.name !== name ? { ...w, name } : w)),
  }));
}

export const stateStore = {
  get: () => active().state.get(),
  set: (v) => { const out = active().state.set(v); syncName(); return out; },
  update(fn) { return this.set(fn(this.get())); },
  flush: () => active().state.flush(),
};
// mediaStore is the CURRENT workspace's library view. get() returns only
// that library's items; set() replaces just that library's items inside the
// full catalog (other libraries are never touched) and tags new records.
export const mediaStore = {
  get() {
    const lib = currentLibrary();
    return { ...libraryHandle.get(), items: libraryHandle.get().items.filter((i) => libraryOfItem(i) === lib) };
  },
  set(v) {
    const lib = currentLibrary();
    const all = libraryHandle.get();
    const others = all.items.filter((i) => libraryOfItem(i) !== lib);
    const mine = (v.items || []).map((i) => (i.library === lib ? i : { ...i, library: lib }));
    libraryHandle.set({ ...all, items: [...mine, ...others] });
    return this.get();
  },
  update(fn) { return this.set(fn(this.get())); },
  flush: () => libraryHandle.flush(),
};
export const packageStore = {
  get: () => active().packages.get(),
  set: (v) => active().packages.set(v),
  update(fn) { return this.set(fn(this.get())); },
  flush: () => active().packages.flush(),
};

export const ledgerStore = {
  get: () => active().ledger.get(),
  set: (v) => active().ledger.set(v),
  update(fn) { return this.set(fn(this.get())); },
  flush: () => active().ledger.flush(),
};

export const tripStore = {
  get: () => active().trips.get(),
  set: (v) => active().trips.set(v),
  update(fn) { return this.set(fn(this.get())); },
  flush: () => active().trips.flush(),
};

export const leadStore = {
  get: () => active().leads.get(),
  set: (v) => active().leads.set(v),
  update(fn) { return this.set(fn(this.get())); },
  flush: () => active().leads.flush(),
};

// Public lead ingest authenticates by a per-workspace secret instead of a
// session. Returns the workspace id that owns this key, or null.
export function findWorkspaceByLeadKey(key) {
  const given = Buffer.from(String(key || ''));
  if (given.length < 24) return null;
  for (const w of registry.get().items) {
    const stored = handlesFor(w.id).leads.get().settings?.ingestKey;
    if (!stored) continue;
    const want = Buffer.from(stored);
    if (want.length === given.length && crypto.timingSafeEqual(want, given)) return w.id;
  }
  return null;
}

// The public capture id is NOT a secret (it sits in the landing page); it
// only routes a sign-up to its workspace. Abuse is bounded by origin checks,
// a honeypot, and rate limits in server.js.
export function findWorkspaceByCaptureId(id) {
  const want = String(id || '');
  if (want.length < 12) return null;
  for (const w of registry.get().items) {
    if (handlesFor(w.id).leads.get().settings?.captureId === want) return w.id;
  }
  return null;
}

// Download and unsubscribe links carry a per-lead random token.
export function findLeadByToken(token) {
  const t = String(token || '');
  if (t.length < 24) return null;
  for (const w of registry.get().items) {
    const lead = handlesFor(w.id).leads.get().items.find((l) => l.token === t);
    if (lead) return { wsId: w.id, lead };
  }
  return null;
}

// ---- workspace management ------------------------------------------------

export function listWorkspaces() {
  const r = registry.get();
  const counts = {};
  for (const i of libraryHandle.get().items) counts[libraryOfItem(i)] = (counts[libraryOfItem(i)] || 0) + 1;
  const items = r.items.map((w) => ({ ...w, library: w.library || DEFAULT_LIBRARY }));
  const names = new Set([...items.map((w) => w.library), ...Object.keys(counts)]);
  return {
    items,
    activeId: activeId(),
    libraries: [...names].sort().map((name) => ({ name, items: counts[name] || 0 })),
  };
}

// Reads one specific workspace's state and packages regardless of which
// workspace is currently "active". stateStore/packageStore above always
// read the single process-wide active workspace, which is fine for the
// authenticated UI (one operator, one workspace open at a time) but wrong
// for any public, unauthenticated, multi-tenant surface: a crawler hitting
// such a route would get whichever brand a human last clicked into, not
// the brand the URL is actually supposed to represent. Returns null for
// an unknown id instead of silently falling back to the active workspace.
export function readWorkspace(id) {
  if (!registry.get().items.some((w) => w.id === id)) return null;
  const h = handlesFor(id);
  return { state: h.state.get(), packages: h.packages.get() };
}

// Write-capable handle on one specific workspace (state + packages), for
// background jobs such as the content-plan scheduler that must work across
// every business without ever touching the active-workspace pointer. Each
// part exposes the same get/set/update/flush as the jsonFile it wraps.
export function workspaceHandle(id) {
  if (!registry.get().items.some((w) => w.id === id)) return null;
  const h = handlesFor(id);
  return { state: h.state, packages: h.packages };
}

// A new business gets its OWN photo library unless the caller names an
// existing one to share (library = 'travel' joins the travel pool). The
// caller (server.js) points the requesting browser at the new workspace;
// nobody else's view changes.
export function createWorkspace(name, library) {
  const id = uid();
  handlesFor(id);
  registry.update((r) => ({
    ...r,
    items: [...r.items, {
      id, name: name?.trim() || 'New business', createdAt: new Date().toISOString(),
      library: cleanLibrary(library) || `ws-${id.slice(0, 6)}`,
    }],
  }));
  registry.flush();
  return id;
}

export function setWorkspaceLibrary(id, library) {
  const lib = cleanLibrary(library);
  if (!lib || !workspaceExists(id)) return false;
  registry.update((r) => ({ ...r, items: r.items.map((w) => (w.id === id ? { ...w, library: lib } : w)) }));
  registry.flush();
  return true;
}

export function renameWorkspace(id, name) {
  if (!name?.trim()) return false;
  registry.update((r) => ({
    ...r,
    // A manual rename is deliberate (e.g. the Tahiti FAM workspace whose
    // profile still says "Travel GHR"), so it stops the profile-name sync.
    items: r.items.map((w) => (w.id === id ? { ...w, name: name.trim(), nameLocked: true } : w)),
  }));
  registry.flush();
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
