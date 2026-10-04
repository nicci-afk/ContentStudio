// Free resources (lead magnets) live in the repo under resources/<workspaceId>/
// so they are versioned and never directly served: the only way to a file is a
// per-lead tokenized link (see /r/:token/:file in server.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, '');

export function loadManifest(wsId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, safe(wsId), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function findResource(wsId, slug) {
  return loadManifest(wsId)?.resources?.find((r) => r.slug === slug) || null;
}

// Absolute path of a resource's PDF, or null when it does not exist.
export function resourcePath(wsId, resource) {
  if (!resource?.file || /[\\/]/.test(resource.file)) return null;
  const file = path.join(ROOT, safe(wsId), resource.file);
  return fs.existsSync(file) ? file : null;
}
