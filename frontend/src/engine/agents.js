// Agent factory: scripted stand-in "bots" so we can watch matches and shake out
// the mechanics BEFORE wiring real LLM agents through the skill pack (Phase 3).
// Each agent is { name, kind, hat, color, items?, decide(observation) -> action }
// with private state in a closure. All policies are deterministic functions of
// the observation (no Math.random), so a match stays reproducible.
//
// The world is full of undrillable STONE, so every policy is stone-aware (it
// routes around it) and every agent is wrapped in an anti-stuck guard that
// perturbs the action if the miner hasn't moved for a few non-digging ticks.
// That guarantees liveness — a naive "dig straight down" bot otherwise deadlocks
// the instant it meets a stone wall (a real finding from the first watch run).

import { BLOCK } from '../config.js';
import { ACTION } from './actions.js';
import { DYNAMITE_FUSE_TICKS } from './constants.js';

const LOOK = {
  shuttle: { hat: 'hardhat', color: 'classic' },
  prospector: { hat: 'cap', color: 'mint' },
  deepdiver: { hat: 'horns', color: 'racer' },
  idler: { hat: 'beanie', color: 'carbon' },
};

const WAIT = { type: ACTION.WAIT };
const move = (dir) => ({ type: ACTION.MOVE, dir });

function viewIndex(obs) {
  const map = new Map();
  for (const t of obs.view.tiles) map.set(`${t.x},${t.y}`, t);
  return map;
}
const tileAt = (idx, x, y) => idx.get(`${x},${y}`) || null;
const isStone = (t) => t && t.block === BLOCK.STONE;

// Pick a downward dir that routes around stone: straight down if the tile below
// is drillable, else step toward a drillable side, else climb out.
function descend(idx, s, biasRight) {
  const { x, y } = s.pos;
  if (!isStone(tileAt(idx, x, y + 1))) return 'down';
  const leftOk = !isStone(tileAt(idx, x - 1, y));
  const rightOk = !isStone(tileAt(idx, x + 1, y));
  if (biasRight) return rightOk ? 'right' : leftOk ? 'left' : 'up';
  return leftOk ? 'left' : rightOk ? 'right' : 'up';
}

// Pick an upward dir that routes around stone overhead.
function ascend(idx, s) {
  const { x, y } = s.pos;
  if (!isStone(tileAt(idx, x, y - 1))) return 'up';
  if (!isStone(tileAt(idx, x - 1, y))) return 'left';
  if (!isStone(tileAt(idx, x + 1, y))) return 'right';
  return 'up';
}

// Carrying the diamond → make for the surface, walk to the shop, turn it in.
// This is the win, so it overrides whatever the bot was doing.
function homeward(obs) {
  const s = obs.self;
  if (s.depth <= 0) {
    const shopX = obs.surface.shopX;
    if (Math.abs(s.pos.x - shopX) <= 1) return { type: ACTION.TURN_IN };
    return move(s.pos.x < shopX ? 'right' : 'left');
  }
  return move(ascend(viewIndex(obs), s));
}

// ---- policies (each returns a decide(obs) closure) -------------------------

function shuttlePolicy({ biasRight }) {
  let mode = 'down';
  let target = 6;
  return (obs) => {
    const s = obs.self;
    if (!s.alive || s.busy) return WAIT;
    const idx = viewIndex(obs);
    if (mode === 'down' && (s.depth >= target || s.cargoCount >= s.maxCargo || s.fuel < 12)) mode = 'up';
    if (mode === 'up') {
      if (s.depth <= 0) {
        mode = 'down';
        // Stay shallow: a 12-ladder / 100-fuel budget can't safely round-trip
        // much deeper, so the shuttle farms the top band instead of diving into
        // a fuel/ladder death spiral. (Reaching the diamond is a deep-world
        // problem the agent-tuned map must address — see MULTIPLAYER_PLAN §7b.)
        target = Math.min(10, target + 2);
      } else {
        return move(ascend(idx, s));
      }
    }
    if (s.depth <= 0 && s.fuel < s.maxFuel && s.money >= 5) return { type: ACTION.REFUEL };
    return move(descend(idx, s, biasRight));
  };
}

function prospectorPolicy({ biasRight }) {
  let mode = 'down';
  return (obs) => {
    const s = obs.self;
    if (!s.alive || s.busy) return WAIT;
    const idx = viewIndex(obs);
    if (mode === 'down' && (s.cargoCount >= s.maxCargo * 0.8 || s.fuel < 14)) mode = 'up';
    if (mode === 'up') {
      if (s.depth <= 0) {
        mode = 'down';
        if (s.fuel < s.maxFuel && s.money >= 5) return { type: ACTION.REFUEL };
      } else {
        return move(ascend(idx, s));
      }
    }
    // Nearest valuable tile at/below our row.
    let best = null;
    let bestD = Infinity;
    for (const t of obs.view.tiles) {
      if (t.y < s.pos.y) continue;
      if (!(t.value > 0 || t.block === BLOCK.CHEST)) continue;
      const d = Math.abs(t.x - s.pos.x) + Math.abs(t.y - s.pos.y);
      if (d > 0 && d < bestD) { bestD = d; best = t; }
    }
    if (best) {
      let dir = best.x < s.pos.x ? 'left' : best.x > s.pos.x ? 'right' : 'down';
      // Don't smash into stone to reach it — route down instead.
      const tgt = dir === 'left' ? tileAt(idx, s.pos.x - 1, s.pos.y)
        : dir === 'right' ? tileAt(idx, s.pos.x + 1, s.pos.y)
        : tileAt(idx, s.pos.x, s.pos.y + 1);
      if (isStone(tgt)) dir = descend(idx, s, biasRight);
      return move(dir);
    }
    return move(descend(idx, s, biasRight));
  };
}

// Deep diver: punch toward the core, blasting stone walls with dynamite and
// retreating from the fuse so it doesn't blow itself up.
function deepDiverPolicy({ biasRight }) {
  let retreat = 0;
  return (obs) => {
    const s = obs.self;
    if (!s.alive || s.busy) return WAIT;
    const idx = viewIndex(obs);
    if (retreat > 0) {
      retreat--;
      // Step clear of the blast for the first couple of ticks, then wait it out.
      return retreat > DYNAMITE_FUSE_TICKS - 2 ? move(ascend(idx, s)) : WAIT;
    }
    if (s.fuel < 10 && s.depth > 0) return move(ascend(idx, s));
    if (isStone(tileAt(idx, s.pos.x, s.pos.y + 1))) {
      if (s.items.dynamite > 0) {
        retreat = DYNAMITE_FUSE_TICKS + 2;
        return { type: ACTION.DYNAMITE, size: 1, dir: 'down' };
      }
      return move(descend(idx, s, biasRight)); // out of dynamite — go around
    }
    return move('down');
  };
}

function idlerPolicy() {
  return () => WAIT;
}

const POLICIES = {
  shuttle: shuttlePolicy,
  prospector: prospectorPolicy,
  deepdiver: deepDiverPolicy,
  idler: idlerPolicy,
};

// Starting-item loadouts per kind (merged into the miner spawn). Deep divers
// carry extra ladders so they can always retreat up from a dynamite fuse.
const LOADOUT = {
  deepdiver: { dynamite: 40, ladder: 80 },
};

export const AGENT_KINDS = Object.keys(POLICIES);

/**
 * Create one scripted agent.
 * @param {string} kind   one of AGENT_KINDS
 * @param {object} [opts] { name, hat, color, biasRight }
 */
export function createAgent(kind, opts = {}) {
  const make = POLICIES[kind] || idlerPolicy;
  const look = LOOK[kind] || LOOK.idler;
  const biasRight = opts.biasRight ?? true;
  const policy = make({ biasRight });

  // Anti-stuck guard: if the miner hasn't moved for a few non-digging ticks,
  // rotate through directions to break out. Keeps any bot live against stone.
  let lastKey = null;
  let same = 0;
  let phase = 0;
  const ESCAPE = ['down', 'right', 'left', 'up'];
  const decide = (obs) => {
    const s = obs.self;
    if (!s.alive) { lastKey = null; same = 0; return WAIT; }
    if (s.busy) return WAIT; // mid-dig: don't count as stuck
    const key = `${s.pos.x},${s.pos.y}`;
    if (key === lastKey) same++; else { same = 0; lastKey = key; }
    if (same >= 3) { phase++; return move(ESCAPE[phase % ESCAPE.length]); }
    // Got the diamond? Drop everything and carry it home — that's the win.
    if (s.hasDiamond) return homeward(obs);
    return policy(obs);
  };

  return {
    name: opts.name || kind,
    kind,
    hat: opts.hat || look.hat,
    color: opts.color || look.color,
    items: LOADOUT[kind] || null,
    decide,
  };
}

/** Build a mixed roster, e.g. createSquad({ shuttle: 4, prospector: 3 }). */
export function createSquad(counts) {
  const roster = [];
  let i = 0;
  for (const [kind, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++) {
      roster.push(createAgent(kind, { name: `${kind}-${k}`, biasRight: i % 2 === 0 }));
      i++;
    }
  }
  return roster;
}
