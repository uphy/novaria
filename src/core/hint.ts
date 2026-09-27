/**
 * 練習のヒント。CPU の最初の 1 手を、どの隕石をどこまで運ぶかの形で持っておく。
 * 盤面は毎フレーム変わるので、毎回考え直すと手本が入れ替わり続けて読めない。
 * 手本は隕石の id で覚えておき、打てなくなるか一定の時間がたつまで同じものを出す
 */
import { suggest } from './cpu';
import type { Game } from './game';
import type { Meteor } from './types';

/** 同じ手本を出し続ける最短のフレーム数。これより前に良い手が見つかっても差し替えない */
const HOLD_FRAMES = 30;
/** 手本を出しているあいだに考え直す間隔（フレーム） */
const RETHINK_FRAMES = 6;

/** 手本の矢印。col 列の from（運ぶ隕石の今の row）から to（運び先の row）へ。row は世界座標 */
export interface HintArrow {
  col: number;
  from: number;
  to: number;
}

interface Held {
  kind: 'ground' | 'lump';
  lumpId: number;
  col: number;
  /** 運ぶ隕石 */
  meteorId: number;
  /** 運び先の添字（下から 0） */
  to: number;
  /** 考えたときに運び先にいた隕石。入れ替わっていたら、盤面が変わったので手本も古い */
  targetId: number;
}

export class Hinter {
  private held: Held | null = null;
  private age = 0;
  private wait = 0;
  private game: Game | null = null;

  /** 1 tick ごとに呼ぶ。指で動かしているあいだは手本を替えない */
  update(game: Game): void {
    if (game !== this.game) {
      // 惑星めぐりで盤面が替わった。隕石の id は盤面ごとに振り直すので、前の手本は使えない
      this.game = game;
      this.held = null;
    }
    if (game.drag) return;
    this.age++;
    const valid = this.held !== null && this.stillValid(game, this.held);
    // 手本があるうちは HOLD_FRAMES のあいだ据え置き、そのあとも RETHINK_FRAMES おきにだけ考える。
    // 手本が無いときも同じ間隔で探す。古くなった手本は待たずに替える
    const rest = valid ? this.age < HOLD_FRAMES || --this.wait > 0 : this.held === null && --this.wait > 0;
    if (rest) return;
    this.wait = RETHINK_FRAMES;
    const next = this.think(game);
    if (valid && next && sameHint(next, this.held!)) return;
    this.held = next;
    this.age = 0;
  }

  /** いま出す矢印。手本が無ければ null */
  arrow(game: Game): HintArrow | null {
    const h = this.held;
    if (!h || game !== this.game) return null;
    const list = column(game, h);
    if (!list) return null;
    const from = list.findIndex((c) => c.meteor.id === h.meteorId);
    const to = list[h.to];
    if (from < 0 || !to || from === h.to) return null;
    return { col: h.col, from: list[from].row, to: to.row };
  }

  private think(game: Game): Held | null {
    const s = suggest(game);
    if (!s) return null;
    const list = column(game, s);
    const meteor = list?.[s.from]?.meteor;
    const target = list?.[s.to]?.meteor;
    if (!meteor || !target || s.from === s.to) return null;
    return { kind: s.kind, lumpId: s.lumpId, col: s.col, meteorId: meteor.id, to: s.to, targetId: target.id };
  }

  private stillValid(game: Game, h: Held): boolean {
    const list = column(game, h);
    if (!list) return false;
    const from = list.findIndex((c) => c.meteor.id === h.meteorId);
    return from >= 0 && from !== h.to && list[h.to]?.meteor.id === h.targetId;
  }
}

function sameHint(a: Held, b: Held): boolean {
  return a.meteorId === b.meteorId && a.to === b.to && a.targetId === b.targetId;
}

/** 手本の列を下から並べる。row はその隕石の世界座標。カタマリが消えていれば null */
function column(
  game: Game,
  at: { kind: 'ground' | 'lump'; lumpId: number; col: number },
): { meteor: Meteor; row: number }[] | null {
  if (at.kind === 'ground') return game.ground[at.col]?.map((meteor, row) => ({ meteor, row })) ?? null;
  const lump = game.lumps.find((l) => l.id === at.lumpId);
  if (!lump) return null;
  return lump.cells
    .filter((c) => c.col === at.col)
    .sort((a, b) => a.rel - b.rel)
    .map((c) => ({ meteor: c.meteor, row: lump.y + c.rel }));
}
