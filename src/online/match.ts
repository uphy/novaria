/**
 * オンライン対戦の端末側。
 *
 * CPU 戦（`src/core/versus.ts`）と違って、相手の盤面はこちらでは動かさない。
 * 自分の盤面だけを 60fps で進め、打ち上げたぶん（攻撃）と盤面の絵だけを相手へ送る。
 * 相手の操作を送り合って両方の盤面を再現する作りにすると、1 フレームでも通信が遅れた時点で
 * 盤面が食い違うので、決着まで直せない。送るのは結果（何個降らせたか）だけにしてある。
 *
 * 通信そのものは `MatchSocket` の向こう側にあるので、テストでは偽の回線を挿して
 * 2 人ぶんの対戦をそのまま回せる（`tests/online/match.test.ts`）。
 */
import { Game, emptyEvents } from '../core/game';
import type { VersusResult } from '../core/versus';
import type { RivalView } from '../core/types';
import {
  BOARD_INTERVAL_FRAMES,
  decodeBoard,
  encodeBoard,
  parseMessage,
  type PlayMessage,
} from './protocol';
import type { Events } from '../core/game';

/** 滅亡したフレームがこれだけしか違わなければ相打ち（0.5 秒） */
export const DRAW_WINDOW_FRAMES = 30;
/** 自分が滅亡してから、相手の滅亡の知らせを待つ長さ（1 秒） */
export const RESOLVE_GRACE_FRAMES = 60;

/** つなぐところから決着まで */
export type OnlinePhase = 'connecting' | 'waiting' | 'playing' | 'ended';

/** 自分から見た決着。`left` は相手の接続が切れたとき */
export type OnlineOutcome = VersusResult | 'left';

/** 相手との回線。ブラウザでは WebSocket（`src/online/socket.ts`）が入る */
export interface MatchSocket {
  send(text: string): void;
  close(): void;
  /** 届いた文字列の渡し先。`OnlineMatch` が入れる */
  onMessage: ((text: string) => void) | null;
  onClose: (() => void) | null;
}

export class OnlineMatch {
  phase: OnlinePhase = 'connecting';
  /** 合言葉で待っているときだけ入る。画面に出して相手に伝えてもらう */
  code: string | null = null;
  rivalName = '相手';
  /** 相手の盤面。届くたびに差し替える */
  rival: RivalView | null = null;
  /** 相手が見つかってから作る。決着したあとも結果を出すために残す */
  game: Game | null = null;
  result: OnlineOutcome | null = null;
  /** 混んでいてつなげなかったか。待ち画面の案内を変える */
  busy = false;

  /** 対戦が始まってからのフレーム数。滅亡した早さの比べ合いに使う */
  private elapsed = 0;
  private overAt: number | null = null;
  private rivalOverAt: number | null = null;
  /** 受け取ってまだ降らせていない攻撃の隕石 */
  private taking = 0;

  constructor(
    private readonly socket: MatchSocket,
    /** 画面を描き替えてもらうための合図。段階が変わるたびに呼ぶ */
    private readonly onChange: () => void,
  ) {
    socket.onMessage = (text) => this.receive(text);
    socket.onClose = () => this.disconnected();
  }

  /** 対戦をやめて回線を切る。待っている途中でも決着したあとでも呼べる */
  leave(): void {
    this.phase = 'ended';
    this.socket.onMessage = null;
    this.socket.onClose = null;
    this.socket.close();
  }

  /** 投了。自分の惑星を滅ぼして負けにする */
  resign(): void {
    if (this.game && !this.game.over) this.game.over = true;
  }

  /**
   * 自分の盤面を 1 フレーム進める。戻り値は演出のための出来事。
   * 相手から届いた攻撃はこのフレームの終わりに降らせる（CPU 戦と同じ並び）
   */
  tick(): Events {
    const game = this.game;
    // 相手が見つかる前は盤面が無い。呼び出し側が段階を見ているので、ここでは何もしない
    if (!game) return emptyEvents();
    this.elapsed++;
    const events = game.tick();

    // 降らせるのはこのフレームの終わり（CPU 戦と同じ並び）
    if (this.taking > 0) {
      events.attackTaken += game.receiveAttack(this.taking, events);
      this.taking = 0;
    }
    if (events.attackSent > 0) this.send({ t: 'attack', n: events.attackSent });

    // 滅亡は取りこぼせない。盤面を 1 枚添えて、相手の画面に最後の形を残す
    if (game.over && this.overAt === null) {
      this.overAt = this.elapsed;
      this.sendBoard();
      this.send({ t: 'over', f: this.elapsed });
    } else if (this.elapsed % BOARD_INTERVAL_FRAMES === 0) {
      this.sendBoard();
    }

    this.resolve();
    return events;
  }

  // ------------------------------------------------------------ 受け取り

  private receive(text: string): void {
    const message = parseMessage(text);
    if (!message) return;
    switch (message.t) {
      case 'waiting':
        this.phase = 'waiting';
        this.code = message.code;
        this.onChange();
        return;
      case 'start':
        // 隕石の降る順番は両者で同じにする。腕以外のところで差が付かないように
        this.game = new Game({ seed: message.seed });
        this.rivalName = message.name;
        this.phase = 'playing';
        this.onChange();
        return;
      case 'busy':
        this.busy = true;
        this.leave();
        this.onChange();
        return;
      case 'board':
        this.rival = decodeBoard(message);
        return;
      case 'attack':
        this.taking += message.n;
        return;
      case 'over':
        this.rivalOverAt = message.f;
        this.resolve();
        return;
      case 'left':
        this.disconnected();
        return;
      default:
        return;
    }
  }

  /** 回線が切れた。まだ決着していなければ、相手が落ちたものとして終わる */
  private disconnected(): void {
    if (this.phase === 'ended') return;
    if (this.phase === 'playing' && this.result === null) this.result = 'left';
    this.phase = 'ended';
    this.onChange();
  }

  // -------------------------------------------------------------- 決着

  /**
   * 勝ち負けを決める。決め方は両者で同じ 2 つの数（互いの滅亡フレーム）だけを見るので、
   * どちらの端末でも同じ答えになる。
   * 自分が滅亡したときは、相手も滅亡していないかを少しだけ待つ（`RESOLVE_GRACE_FRAMES`）。
   * 待たずに負けにすると、ほぼ同時に潰れたときに両者とも負けになる
   */
  private resolve(): void {
    if (this.result !== null || this.phase !== 'playing') return;
    const mine = this.overAt;
    const theirs = this.rivalOverAt;
    if (mine !== null && theirs !== null) {
      const gap = Math.abs(mine - theirs);
      this.finish(gap <= DRAW_WINDOW_FRAMES ? 'draw' : mine < theirs ? 'lose' : 'win');
      return;
    }
    // 相手の滅亡だけが分かっていても、すぐには勝ちにしない。
    // 自分も相打ちの幅のうちに潰れるかもしれない。ここを待たずに勝ちにすると、
    // 相手が「相打ち」、こちらが「勝ち」と食い違う
    if (theirs !== null && this.elapsed - theirs > DRAW_WINDOW_FRAMES) this.finish('win');
    else if (mine !== null && this.elapsed - mine >= RESOLVE_GRACE_FRAMES) this.finish('lose');
  }

  private finish(result: OnlineOutcome): void {
    this.result = result;
    this.onChange();
  }

  // -------------------------------------------------------------- 送り

  private sendBoard(): void {
    if (this.game) this.send(encodeBoard(this.game));
  }

  private send(message: PlayMessage): void {
    if (this.phase !== 'playing') return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // 切れた回線に書いても、決着は `onClose` の側で付ける
    }
  }
}
