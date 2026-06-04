import Phaser from 'phaser';
import { TILE, BLOCK } from '../config.js';
import { getBlock } from '../world.js';
import GameScene from './GameScene.js';
import { GAME_MODES, createMatchForMode } from '../engine/index.js';
import { createSquad } from '../engine/agents.js';
import { drawRobot as drawSharedRobot } from '../render/robot.js';
import { btnCss, wireBtn } from './arenaUI.js';

// Live spectator. Extends GameScene to REUSE the real game rendering — same
// procedural tiles, ore, shop, robot models — at 1:1 TILE scale, but driven by
// an engine match of scripted bots on a free-scroll camera. Adds dig-crack +
// debris + dynamite FX so you can SEE blocks break and bombs go off, and a
// speed control so the tempo reads like deliberate real-time mining.
const BASE_TICK_MS = 280;       // deliberate pace (×speed below)
const SPEEDS = [0.5, 1, 2];

function squadCounts(n) {
  const kinds = ['shuttle', 'prospector', 'deepdiver', 'shuttle', 'prospector'];
  const c = {};
  for (let i = 0; i < n; i++) { const k = kinds[i % kinds.length]; c[k] = (c[k] || 0) + 1; }
  return c;
}

export default class SpectatorScene extends GameScene {
  constructor() { super('Spectator'); }

  init(data) {
    this.specMode = data?.mode || 'coop-gem';
    this.specSeed = data?.seed ?? 1234;
  }

  create() {
    this.cleanupSceneDOM();
    this.spectator = true;
    this.mode = GAME_MODES[this.specMode] || GAME_MODES['coop-gem'];
    this.bots = createSquad(squadCounts(this.mode.miners));
    this.match = createMatchForMode(this.specMode, {
      seed: this.specSeed,
      miners: this.bots.map((b) => ({ name: b.name, hat: b.hat, color: b.color, items: b.items || undefined })),
    });
    this.world = this.match.state.world;

    // Render layers (depth-ordered). worldGfx/tilePool feed inherited drawWorld.
    this.worldGfx = this.add.graphics();
    this.digFxGfx = this.add.graphics(); this.digFxGfx.setDepth(3);
    this.debrisGfx = this.add.graphics(); this.debrisGfx.setDepth(4);
    this.robotGfx = this.add.graphics(); this.robotGfx.setDepth(5);
    this.fxGfx = this.add.graphics(); this.fxGfx.setDepth(6);
    this.tilePool = []; this.tilePoolCursor = 0;
    this.fallingStones = [];
    this.digging = null; this.failedDig = null;
    this.debris = [];   // reused by inherited spawnDebris/updateDebris/drawDebris
    this.flashes = [];  // explosion rings

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.world.W * TILE, this.world.H * TILE);
    cam.setBackgroundColor('#4a7bbf');
    cam.setRoundPixels(true);
    cam.setZoom(1);
    cam.centerOn(this.match.state.shopX * TILE, (this.world.surface + 7) * TILE);

    this.setupCameraControls();
    this.specDraw = this.match.state.miners.map((m) => ({ px: m.tx, py: m.ty }));

    this.speedIdx = 1;
    this.tickMs = BASE_TICK_MS / SPEEDS[this.speedIdx];
    this.buildHUD();
    this.buildTimer();
    this.worldDirty = true;

    this.scale.on('resize', this.onSpecResize, this);
    this.events.once('shutdown', () => this.teardown());
    this.events.once('destroy', () => this.teardown());
  }

  onSpecResize() { this.scene.restart({ mode: this.specMode, seed: this.specSeed }); }

  buildTimer() {
    if (this.tickEvent) this.tickEvent.remove();
    this.tickEvent = this.time.addEvent({ delay: this.tickMs, loop: true, callback: () => this.stepMatch() });
  }

  setupCameraControls() {
    // Fixed 1:1 zoom the whole time. Two ways to move the camera:
    //  • drag with the mouse
    //  • mouse wheel SCROLLS (pans) — vertical wheel = up/down, horizontal
    //    wheel (or shift+wheel) = left/right. No zoom.
    const cam = this.cameras.main;
    this.input.on('pointermove', (p) => {
      if (!p.isDown) return;
      cam.scrollX -= p.x - p.prevPosition.x;
      cam.scrollY -= p.y - p.prevPosition.y;
      this.worldDirty = true;
    });
    this.input.on('wheel', (_p, _o, dx, dy) => {
      cam.scrollX += dx;
      cam.scrollY += dy;
      this.worldDirty = true;
    });
  }

  stepMatch() {
    if (this.match.finished) return;
    const ms = this.match.state.miners;
    // Snapshot in-progress digs so we can pop debris when a block breaks.
    const wasBusy = ms.map((m) => (m.busy ? { tx: m.busy.tx, ty: m.busy.ty, type: m.busy.blockType } : null));

    for (const id of this.match.minerIds) {
      this.match.submitAction(id, this.bots[id].decide(this.match.observe(id)));
    }
    const events = this.match.advance();

    // A dig that was running and is now gone, on a tile that is now empty,
    // means the block just broke → burst of debris.
    for (let i = 0; i < ms.length; i++) {
      const pb = wasBusy[i];
      const m = ms[i];
      if (!pb) continue;
      const stillSame = m.busy && m.busy.tx === pb.tx && m.busy.ty === pb.ty;
      if (!stillSame && getBlock(this.world, pb.tx, pb.ty) === BLOCK.SKY) {
        this.spawnDebris(pb.tx, pb.ty, pb.type, 10);
      }
    }
    // Dynamite went off → flash + shake + rubble.
    for (const e of events) {
      if (e.type === 'detonation') {
        this.flashes.push({ x: e.x, y: e.y, maxR: (e.radius + 1) * TILE, life: 320, maxLife: 320 });
        this.spawnDebris(e.x, e.y, BLOCK.STONE, 18);
        this.cameras.main.shake(170, 0.004 * (e.radius + 1));
      }
    }

    this.worldDirty = true;
    this.updateHUD();
    if (this.match.finished) this.showFinish();
  }

  update(time, dt) {
    const k = Math.min(1, (dt / this.tickMs) * 1.7);
    const ms = this.match.state.miners;
    for (let i = 0; i < this.specDraw.length; i++) {
      const m = ms[i], d = this.specDraw[i];
      d.px += (m.tx - d.px) * k;
      d.py += (m.ty - d.py) * k;
    }
    if (this.debris.length > 0) this.updateDebris(dt); // inherited physics
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      this.flashes[i].life -= dt;
      if (this.flashes[i].life <= 0) this.flashes.splice(i, 1);
    }

    if (this.worldDirty) { this.drawWorld(); this.worldDirty = false; } // inherited — real tiles
    this.drawDigCracks();
    this.debrisGfx.clear();
    if (this.debris.length > 0) this.drawDebris(); // inherited
    this.drawSpecRobots(time);
    this.drawFx(time);
  }

  drawSpecRobots(time) {
    const g = this.robotGfx; g.clear();
    const ms = this.match.state.miners;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m.alive) continue;
      const d = this.specDraw[i];
      drawSharedRobot(g, d.px * TILE + TILE / 2, d.py * TILE + TILE / 2, TILE, {
        facing: m.facing,
        digging: !!m.busy,
        time,
        hasDiamond: m.hasDiamond,
        hat: m.hat,
        bodyColor: m.color,
        tier: 1,
      });
    }
  }

  // Crack overlay + progress bar on every tile currently being drilled.
  drawDigCracks() {
    const g = this.digFxGfx; g.clear();
    for (const m of this.match.state.miners) {
      if (!m.alive || !m.busy) continue;
      const { tx, ty, ticksLeft, totalTicks } = m.busy;
      const progress = totalTicks ? 1 - ticksLeft / totalTicks : 0;
      const px = tx * TILE, py = ty * TILE;
      g.lineStyle(3, 0x000000, 0.85);
      if (progress >= 0.25) {
        g.strokeLineShape(new Phaser.Geom.Line(px + 8, py + 10, px + TILE / 2, py + TILE / 2));
        g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2, py + TILE / 2, px + TILE - 14, py + TILE - 8));
      }
      if (progress >= 0.5) {
        g.strokeLineShape(new Phaser.Geom.Line(px + TILE - 8, py + 6, px + TILE / 2 + 4, py + TILE / 2));
        g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2 - 2, py + TILE / 2 + 2, px + 10, py + TILE - 4));
      }
      if (progress >= 0.75) {
        g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2, py + 4, px + TILE / 2 + 3, py + TILE / 2));
      }
      g.fillStyle(0x000000, 0.55); g.fillRect(px + 3, py - 9, TILE - 6, 6);
      g.fillStyle(0xffdd55, 1); g.fillRect(px + 4, py - 8, (TILE - 8) * progress, 4);
    }
  }

  drawFx(time) {
    const g = this.fxGfx; g.clear();
    // Live dynamite fuses (so you see one is about to blow).
    for (const b of this.match.state.bombs) {
      const cx = b.x * TILE + TILE / 2, cy = b.y * TILE + TILE / 2;
      const pulse = 0.5 + 0.5 * Math.sin(time / 70);
      g.fillStyle(0xff3b1f, 0.35 + 0.35 * pulse);
      g.fillCircle(cx, cy, TILE * 0.45 * (0.6 + 0.4 * pulse));
      g.fillStyle(0xffe14a, 1);
      g.fillCircle(cx, cy - TILE * 0.32, 3 + 2 * pulse);
    }
    // Explosion rings.
    for (const f of this.flashes) {
      const a = f.life / f.maxLife;
      const r = 8 + f.maxR * (1 - a);
      const cx = f.x * TILE + TILE / 2, cy = f.y * TILE + TILE / 2;
      g.fillStyle(0xff7a1f, 0.25 * a); g.fillCircle(cx, cy, r);
      g.lineStyle(4, 0xffd14a, a); g.strokeCircle(cx, cy, r);
    }
  }

  // ---- HUD (DOM) ----
  buildHUD() {
    const bar = document.createElement('div');
    bar.id = 'spec-hud';
    bar.style.cssText = `position:fixed;left:0;top:0;width:100%;height:46px;z-index:20;
      display:flex;align-items:center;gap:14px;padding:0 14px;box-sizing:border-box;
      background:linear-gradient(#000c,#0007);font-family:'Courier New',monospace;color:#fff`;

    const back = wireBtn(document.createElement('button'));
    back.textContent = '← BACK';
    back.style.cssText = btnCss('#cdd3da') + 'font-size:14px;padding:6px 13px;box-shadow:2px 2px 0 rgba(0,0,0,.35)';
    back.onclick = () => this.goLobby();
    bar.appendChild(back);

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;color:#ffdd55;font-size:17px';
    title.textContent = this.mode.label;
    bar.appendChild(title);

    const speed = wireBtn(document.createElement('button'));
    speed.id = 'spec-speed';
    speed.style.cssText = btnCss('#5fd0e6') + 'font-size:13px;padding:6px 12px;box-shadow:2px 2px 0 rgba(0,0,0,.35)';
    speed.onclick = () => this.cycleSpeed();
    bar.appendChild(speed);
    this.speedEl = speed;

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;opacity:.6';
    hint.textContent = 'drag or wheel to scroll';
    bar.appendChild(hint);

    const stats = document.createElement('div');
    stats.id = 'spec-stats';
    stats.style.cssText = 'margin-left:auto;font-size:14px';
    bar.appendChild(stats);

    document.body.appendChild(bar);
    this.statsEl = stats;
    this.refreshSpeedLabel();
    this.updateHUD();
  }

  cycleSpeed() {
    this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
    this.tickMs = BASE_TICK_MS / SPEEDS[this.speedIdx];
    this.buildTimer();
    this.refreshSpeedLabel();
  }

  refreshSpeedLabel() {
    if (this.speedEl) this.speedEl.textContent = `⏩ ${SPEEDS[this.speedIdx]}×`;
  }

  updateHUD() {
    if (!this.statsEl) return;
    const s = this.match.state;
    const alive = s.miners.filter((m) => m.alive).length;
    const dug = s.miners.reduce((a, m) => a + m.stats.tilesDug, 0);
    this.statsEl.innerHTML =
      `tick <b>${s.tick}</b>　agents <b>${alive}/${s.miners.length}</b>　` +
      `dug <b>${dug}</b>　team <b style="color:#ffec6e">$${s.teamScore}</b>` +
      (s.diamondFound ? '　<b style="color:#5ff6ff">💎</b>' : '');
  }

  showFinish() {
    if (document.getElementById('spec-finish')) return;
    const s = this.match.state;
    const ov = document.createElement('div');
    ov.id = 'spec-finish';
    ov.style.cssText = `position:fixed;inset:0;z-index:22;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:18px;background:#000a;
      font-family:'Courier New',monospace;color:#fff;text-align:center`;
    const reason = s.finishedReason === 'diamond' ? '💎 DIAMOND DELIVERED'
      : s.finishedReason === 'score_target' ? '🏁 SCORE TARGET REACHED' : '⏱ TIME UP';
    ov.innerHTML = `<div style="font-size:40px;font-weight:bold;color:#ffdd55;text-shadow:3px 3px 0 #000">${reason}</div>
      <div style="font-size:22px">team score: <b style="color:#ffec6e">$${s.teamScore}</b></div>`;
    const again = wireBtn(document.createElement('button'));
    again.textContent = '↺  LOBBY';
    again.style.cssText = btnCss('#5fd0e6') + 'font-size:18px;padding:12px 30px';
    again.onclick = () => this.goLobby();
    ov.appendChild(again);
    document.body.appendChild(ov);
  }

  goLobby() {
    this.scale.off('resize', this.onSpecResize, this);
    this.scene.start('Lobby');
  }

  teardown() {
    if (this.tickEvent) { this.tickEvent.remove(); this.tickEvent = null; }
    document.getElementById('spec-hud')?.remove();
    document.getElementById('spec-finish')?.remove();
  }
}
