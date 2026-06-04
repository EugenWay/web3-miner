// World presets — one shape per mode. A WorldSpec is plain data passed to
// generateWorld(seed, spec). `solo` reproduces today's single-player world
// exactly (defaults = config constants + no regen), so single-player is
// untouched (verified by a grid-hash baseline).
//
// Depth landmarks (diamond / lava / water) scale with `height` via DIMS.depthScale
// (see dims.js + scaleDepth()), so a shallower preset keeps the same relative
// layout. `regen` retries generation with new seeds until the diamond is
// reachable — on for agent presets, off for solo (which stays warn-only).

import { WORLD_W, WORLD_H, SURFACE_Y } from '../config.js';

const SOLO = {
  name: 'solo',
  width: WORLD_W, // 120
  height: WORLD_H, // 250
  surface: SURFACE_Y,
  regen: false,
};

export const WORLD_PRESETS = {
  solo: SOLO,
  // 10-agent world: wide enough to spread out and explore, deep enough for an
  // ore gradient + a real journey to the diamond. The GameScene renderer is now
  // world-size aware, so the spectator shows this at the same 1:1 scale.
  // TUNE: bump width/height here to taste.
  agents: { ...SOLO, name: 'agents', width: 200, height: 200, regen: true },
  coop: { ...SOLO, name: 'coop', width: 200, height: 160, regen: true },
  arena: { ...SOLO, name: 'arena', width: 140, height: 110, regen: true },
};

// Accept: undefined → solo; a preset name string; or a partial spec object.
export function resolveSpec(spec) {
  if (!spec) return { ...SOLO };
  if (typeof spec === 'string') return { ...(WORLD_PRESETS[spec] || SOLO) };
  return { ...SOLO, ...spec };
}
