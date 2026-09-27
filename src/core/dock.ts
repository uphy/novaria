/**
 * 空中ドッキングの見積もり。地面で点火して上がるカタマリが、浮いているカタマリに下から当たるかを見る。
 *
 * 盤面ごと写して進める（`Game.fork`）と 1 フレームに 0.1ms ほどかかり、
 * 案ごとに数秒先まで読むとスマホでは 1 フレームに収まらない。
 * そこで、2 つのカタマリの高さだけを `Game.updateLumps` / `Game.applyThrust` と同じ式でフレームごとに進める。
 * 当たったかどうかは、同じ列で上がる側の一番上が、浮いている側の一番下に届いたかで見る。
 * 降ってくる隕石に押し下げられるぶんや、途中で別の点火が起きるぶんは見ない。
 * 見積もりが本物と合うかは tests/core/dock.test.ts が `Game.fork` で確かめる
 */
import { IGNITION_GRACE_FRAMES, PHYSICS } from './constants';
import type { Plan } from './cpu';
import type { Game } from './game';
import { Kind, type Lump } from './types';

/** 当たる見込み。lumpId は当たる相手、frames は今から当たるまで */
export interface DockForecast {
  lumpId: number;
  frames: number;
  /** 当たる相手のカタマリの隕石の数 */
  size: number;
}

/** 列ごとの一番下と一番上の rel */
function spans(lump: Lump): Map<number, { low: number; high: number }> {
  const out = new Map<number, { low: number; high: number }>();
  for (const c of lump.cells) {
    const s = out.get(c.col);
    if (!s) out.set(c.col, { low: c.rel, high: c.rel });
    else {
      s.low = Math.min(s.low, c.rel);
      s.high = Math.max(s.high, c.rel);
    }
  }
  return out;
}

/**
 * plan を今から delay フレーム後に打ち終えたとき、浮いているカタマリのどれかに下から当たるか。
 * 当たる前に相手が着地する、上がる側が届かない、horizon フレームのうちに当たらない、のどれかなら null
 */
export function forecastDock(game: Game, plan: Plan, delay: number, horizon = 240): DockForecast | null {
  if (game.lumps.length === 0) return null;
  const p = game.planet;

  // 点火する列ごとの点火位置（一番下の点火マス）。点火したマスから上が乗って上がる
  const pivots = new Map<number, number>();
  for (const cell of plan.pattern) {
    pivots.set(cell.col, Math.min(pivots.get(cell.col) ?? Infinity, cell.index));
  }
  let base = Infinity;
  for (const pivot of pivots.values()) base = Math.min(base, pivot);
  const tops = new Map<number, number>();
  let mass = 0;
  for (const [col, pivot] of pivots) {
    const stack = game.ground[col];
    tops.set(col, stack.length - 1 - base);
    for (let r = pivot; r < stack.length; r++) mass += stack[r].kind === Kind.Dust ? PHYSICS.dustMass : 1;
  }
  const count = plan.pattern.length;
  mass -= count * (1 - PHYSICS.dustMass);
  const m = Math.pow(Math.max(1, mass * p.lumpMassScale), PHYSICS.massExponent);
  const vertical = plan.aim.kind !== 'chain' && plan.aim.vertical;
  // 点火すると連鎖が 1 つ増える。その回数だけ推進が強くなる
  const bonus = (base === 0 ? p.bottomBonus : 1) * Math.pow(p.reigniteScale, game.combo);
  const gravity = p.gravity ?? PHYSICS.gravity;
  const fallGravity = p.lumpFallGravity ?? PHYSICS.lumpFallGravity;
  const maxFall = p.maxLumpFallSpeed ?? PHYSICS.maxLumpFallSpeed;

  const targets = game.lumps
    .map((lump) => ({
      lump,
      spans: spans(lump),
      y: lump.y,
      vy: lump.vy,
      thrust: lump.thrustFrames,
      accel: lump.thrustAccel,
      landed: false,
    }))
    .filter((t) => [...pivots.keys()].some((c) => t.spans.has(c)));
  if (targets.length === 0) return null;

  // 揃ってから点火するまでの猶予を踏み、次のフレームから上がり始める
  const ignite = delay + IGNITION_GRACE_FRAMES + 1;
  let y = base;
  let vy = (p.kick * count * bonus) / m;
  const accel = (p.thrust * count * bonus * (vertical ? p.columnThrustScale : 1)) / m;
  let thrust = p.thrustTime;

  const step = (s: { y: number; vy: number; thrust: number; accel: number }): void => {
    if (s.thrust > 0) {
      s.vy += s.accel;
      s.thrust--;
    }
    const rising = s.vy > 0 || s.thrust > 0;
    s.vy -= rising ? gravity : fallGravity;
    s.vy = Math.max(-maxFall, Math.min(PHYSICS.maxRiseSpeed, s.vy));
    s.y += s.vy;
  };

  for (let t = 1; t <= horizon; t++) {
    for (const target of targets) {
      if (target.landed) continue;
      step(target);
      // 落ちてきて山に触れたら着地する。もう当てられない
      if (target.vy <= 0) {
        for (const [col, s] of target.spans) {
          if (target.y + s.low <= game.ground[col].length) target.landed = true;
        }
      }
    }
    if (t < ignite) continue;
    if (t > ignite) {
      const b = { y, vy, thrust, accel };
      step(b);
      ({ y, vy, thrust } = b);
    }
    for (const target of targets) {
      if (target.landed) continue;
      for (const [col, top] of tops) {
        const s = target.spans.get(col);
        if (!s) continue;
        // 上がる側の一番上が、浮いている側の一番下の 1 マス手前まで来たら当たる（`Game.overlaps`）
        if (target.y + s.low - (y + top) < 1 && y + top < target.y + s.high + 1) {
          return { lumpId: target.lump.id, frames: t, size: target.lump.cells.length };
        }
      }
    }
    if (targets.every((t) => t.landed)) return null;
    // 上がる側が落ちてきて元の高さまで戻ったら着地する。もう届かない
    if (t > ignite && vy <= 0 && y <= base) return null;
  }
  return null;
}
