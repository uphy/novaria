import type { Page } from '@playwright/test';
import type { CpuLevel } from '../src/core/cpu';
import type { Game } from '../src/core/game';
import type { Tour } from '../src/core/tour';
import type { Versus } from '../src/core/versus';
import type { OnlineMatch } from '../src/online/match';
import type { Kind } from '../src/core/types';
import type { GameAudio } from '../src/render/audio';
import type { Effects } from '../src/render/effects';
import type { View } from '../src/render/view';

/** main.ts が window に出している入口。e2e からゲームの中を触るために使う */
export interface NovariaHandle {
  readonly game: Game;
  /** 遊んでいる最中（メニューでも一時停止でもない）か */
  readonly running: boolean;
  /** メニューのどの画面を出しているか。遊んでいる最中は null */
  readonly menu:
    | 'top'
    | 'name'
    | 'tour'
    | 'versus'
    | 'online'
    | 'waiting'
    | 'how'
    | 'records'
    | null;
  /** トップメニューのオープニングを流している最中か */
  readonly intro: boolean;
  /** CPU と対戦しているときだけ入る */
  readonly versus: Versus | null;
  /** 対戦の決着の演出が始まってからのフレーム数。演出をしていなければ null */
  readonly finale: number | null;
  /** 惑星めぐりのときだけ入る */
  readonly tour: Tour | null;
  /** オンライン対戦。相手を探しているあいだも入っている */
  readonly online: OnlineMatch | null;
  start(): void;
  startVersus(level?: CpuLevel): void;
  startTour(): void;
  startOnline(code?: string | null): void;
  view: View;
  fx: Effects;
  /** 鳴らした音の並びと、いま鳴っている音源の数 */
  audio: GameAudio;
  /** 新版を見に行った回数。起動したときと画面に戻ってきたときに増える */
  readonly updateChecks: number;
  /** 新版の知らせを偽って流す（preview には新しい版が無いので） */
  fakeUpdate(step: 'downloading' | 'ready' | 'failed'): void;
  /** fakeUpdate の ready で渡した入れ替えが呼ばれた回数 */
  readonly updatesApplied: number;
  setColumns(columns: Kind[][]): void;
}

declare global {
  interface Window {
    __novaria: NovariaHandle;
  }
}

/** e2e で使う遊び手。初回の名前入れを飛ばすために、開く前に端末へ置いておく */
export const TEST_PLAYER = { id: '11111111-1111-4111-8111-111111111111', name: 'てすと' };

/**
 * タイトルを開く。seed を固定するので、同じ操作なら同じ盤面になる。
 * 名前を決めた状態で開くので、出るのはトップメニュー。
 * オープニングの演出は切る（待ち時間が要らなくなるので、他のテストが揺れない）。
 * 名前がまだ無いときの流れと、オープニングそのものを見たいときは `openFirstTime` を使う
 */
export async function openTitle(page: Page, seed = 7): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((player) => {
    localStorage.setItem('novaria.player.v1', JSON.stringify(player));
  }, TEST_PLAYER);
  await page.goto(`/?seed=${seed}`);
  await page.waitForFunction(() => Boolean(window.__novaria));
}

/** 何も入っていない端末で初めて開く。名前は聞かれず、出るのはトップメニュー */
export async function openFirstTime(page: Page, seed = 7): Promise<void> {
  await page.goto(`/?seed=${seed}`);
  await page.waitForFunction(() => Boolean(window.__novaria));
}

/** タイトルから「一人用」を押して、ゲームが動き出すまで待つ */
export async function startGame(page: Page, seed = 7): Promise<void> {
  await openTitle(page, seed);
  await page.getByRole('button', { name: '一人用' }).click();
  await page.waitForFunction(() => window.__novaria.running);
}

/**
 * 1 列だけを大気圏まで積み上げて滅亡させる。
 * 縦に同じ柄が 3 つ続かない並びにして、点火で崩れないようにする。
 * 降ってくる隕石が積み上がって別の列が揃うと点火してしまうので、
 * 滅亡するまで同じ盤面を置き直して、降ってきたぶんを消し続ける
 */
export async function annihilate(page: Page): Promise<void> {
  const doomed = Array.from({ length: 13 }, (_, i) => (i % 2 === 0 ? 0 : 1)) as Kind[];
  await page.evaluate(
    (columns) => {
      const n = window.__novaria;
      n.setColumns(columns);
      const timer = window.setInterval(() => {
        if (n.game.over) {
          window.clearInterval(timer);
          return;
        }
        n.setColumns(columns);
      }, 150);
    },
    [doomed, [], [], [], [], [], [], [], []] as Kind[][],
  );
  await page.waitForFunction(() => window.__novaria.game.over, null, { timeout: 30_000 });
}

/** いま進んでいるフレーム数 */
export function frame(page: Page): Promise<number> {
  return page.evaluate(() => window.__novaria.game.frame);
}

/** 現在から count フレーム進むまで待つ */
export async function advance(page: Page, count: number): Promise<void> {
  const from = await frame(page);
  await page.waitForFunction((f) => window.__novaria.game.frame > f, from + count);
}

/** 盤面の (col, row) のマスの中心の画面座標。canvas は画面いっぱいなので client 座標と同じ */
export function cellCenter(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([c, r]) => {
      const { view } = window.__novaria;
      const half = view.layout.cell / 2;
      return { x: view.colLeft(c) + half, y: view.rowTop(r) + half };
    },
    [col, row] as const,
  );
}

/** 列ごとの種類を、下から順に並べて取り出す */
export function columnKinds(page: Page): Promise<number[][]> {
  return page.evaluate(() => window.__novaria.game.ground.map((col) => col.map((m) => m.kind)));
}
