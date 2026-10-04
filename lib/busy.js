// One heavy ffmpeg job at a time (the instance has 2GB): Auto-Produce renders,
// Short imports and edit renders all register here so they never overlap.
const active = new Map();
export const beginJob = (key, label) => active.set(key, label);
export const endJob = (key) => active.delete(key);
export const otherJobLabel = (exceptKey) => [...active].find(([k]) => k !== exceptKey)?.[1] || null;
