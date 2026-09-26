/**
 * 盤面で流す曲。効果音と違ってこれだけは音声ファイル（`public/audio/`）を鳴らす。
 *
 * 曲は `play.mp3` の 1 つ（F メジャー・130 BPM）。効果音の音階（`palette.ts`）もこれに合わせてある。
 * 頭の 16 小節は盛り上がっていく導入で、最初の 1 回だけ流す。
 * そのあとは 17 小節目の頭から 72 小節目の頭の手前まで（56 小節）を繰り返す。
 * 72 小節目の入り方が 17 小節目と同じ形なので、ここで戻しても継ぎ目が分からない。
 * ピンチのときに別の曲へ替えるのはやめた（docs/decisions.md「盤面の曲」）
 *
 * `<audio loop>` はつなぎ目に数十 ms の無音が入る端末があるので、
 * 1 度だけ `decodeAudioData` して `AudioBufferSourceNode` の loopStart / loopEnd で回す。
 * 2 つの点は曲の途中にあるので、mp3 の頭に付く無音の長さが端末ごとに違っても、
 * 両方が同じだけずれるだけで継ぎ目は合ったまま
 */

const BAR = (4 * 60) / 130;

export interface TrackSpec {
  url: string;
  /** 1 小節目の頭（秒） */
  firstBar: number;
  loopStart: number;
  loopEnd: number;
  /** 鳴らす音量。ファイルは -12 LUFS 前後と大きいので、効果音の下に沈むまで絞る */
  gain: number;
}

/** 盤面の曲。ファイルの頭に 0.2 秒ほど無音がある */
export const CALM: TrackSpec = {
  url: `${import.meta.env.BASE_URL}audio/play.mp3`,
  firstBar: 0.216,
  loopStart: 0.216 + 16 * BAR,
  loopEnd: 0.216 + 72 * BAR,
  gain: 0.32,
};

/**
 * 鳴らし始めてから elapsed 秒たったときの、曲の中の位置。
 * loopEnd を越えたら loopStart へ戻したぶんを畳む
 */
export function loopPosition(elapsed: number, loopStart: number, loopEnd: number): number {
  if (elapsed < loopEnd) return elapsed;
  return loopStart + ((elapsed - loopStart) % (loopEnd - loopStart));
}

/**
 * 展開だけに使う ctx。AudioContext と違ってタップの前でも作れる。
 * 展開した AudioBuffer は ctx に縛られないので、あとで作る AudioContext でそのまま鳴らせる。
 * 長さ 1 サンプルで作り、描き出し（startRendering）はしない。
 *
 * 32kHz で展開する。96kbps の mp3 は 15kHz より上をもともと持たないので失うものが無く、
 * 44.1kHz で展開するより置き場が 3 割減る
 */
function offlineContext(): OfflineAudioContext | null {
  const Ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctor) return null;
  for (const rate of [32000, 44100]) {
    try {
      return new Ctor(2, 1, rate);
    } catch {
      // 古い Safari は 44.1kHz と 48kHz しか受けない
    }
  }
  return null;
}

/** 1 つの曲。読み込みと、いま回している音源 1 本を持つ */
class Track {
  buffer: AudioBuffer | null = null;
  private loading = false;
  private src: AudioBufferSourceNode | null = null;
  /** 音源ごとの音量。止めるときに絞る */
  private fader: GainNode | null = null;
  /** 曲の頭が鳴ったことになる ctx の時刻。いまの位置は `currentTime - origin` から出す */
  private origin = 0;

  constructor(readonly spec: TrackSpec) {}

  get sounding(): boolean {
    return this.src !== null;
  }

  load(decoder: BaseAudioContext, onReady: () => void): void {
    if (this.buffer || this.loading) return;
    this.loading = true;
    fetch(this.spec.url)
      .then((res) => {
        if (!res.ok) throw new Error(`music ${res.status}`);
        return res.arrayBuffer();
      })
      .then(
        (data) =>
          // Promise の形は iOS 14.1 より前の Safari に無いので、callback の形で呼ぶ
          new Promise<AudioBuffer>((resolve, reject) => decoder.decodeAudioData(data, resolve, reject)),
      )
      .then((buffer) => {
        this.buffer = buffer;
        onReady();
      })
      .catch(() => {
        // 取れなくても効果音だけで遊べる。次に鳴らすときにもう一度取りに行く
      })
      .finally(() => {
        this.loading = false;
      });
  }

  /** at 秒（ctx の時刻）に、曲の offset 秒の位置から鳴らす */
  begin(ctx: AudioContext, out: AudioNode, offset: number, at: number): void {
    if (!this.buffer || this.src) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = this.spec.loopStart;
    src.loopEnd = this.spec.loopEnd;
    const g = ctx.createGain();
    g.gain.value = this.spec.gain;
    src.connect(g).connect(out);
    src.start(at, offset);
    this.origin = at - offset;
    this.src = src;
    this.fader = g;
  }

  /** ctx の時刻 t に、曲のどこを鳴らしているか */
  position(t: number): number {
    // 鳴らし始めの予約より前なら負になるので 0 で止める
    return loopPosition(Math.max(0, t - this.origin), this.spec.loopStart, this.spec.loopEnd);
  }

  /** 音量を dur 秒で level（0〜1）へ寄せる */
  private fade(ctx: AudioContext, level: number, dur: number): void {
    if (!this.fader) return;
    const t = ctx.currentTime;
    this.fader.gain.cancelScheduledValues(t);
    this.fader.gain.setTargetAtTime(level * this.spec.gain, t, dur / 5);
  }

  /** 鳴っている音源を fade 秒で絞って捨てる */
  halt(ctx: AudioContext | null, fade: number): void {
    const src = this.src;
    this.src = null;
    if (!ctx || !src) return;
    this.fade(ctx, 0, fade);
    this.fader = null;
    src.stop(ctx.currentTime + fade + 0.05);
  }
}

export type MusicState = 'stopped' | 'playing' | 'paused';

export class Music {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private track = new Track(CALM);
  /** 次に鳴らし始める位置（秒） */
  private offset = 0;
  state: MusicState = 'stopped';

  /** 曲を読み終えて、いつでも鳴らせるか */
  get ready(): boolean {
    return this.track.buffer !== null;
  }

  /** いま実際に音源が回っているか */
  get sounding(): boolean {
    return this.track.sounding;
  }

  /** ctx ができたら 1 度だけ呼ぶ。出口を dest へつなぎ、まだ読めていなければ取りに行く */
  attach(ctx: AudioContext, dest: AudioNode): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(dest);
    this.load();
  }

  /**
   * 曲を取りに行って展開する。起動したらすぐ呼ぶ。
   * 初めて開いた端末ではダウンロードと展開に数秒かかり、最初のタップ（ctx ができる）から始めると
   * 遊び始めてしばらく無音になっていた。メニューを見ているあいだに済ませておく
   */
  load(): void {
    if (this.ready) return;
    const decoder = offlineContext() ?? this.ctx;
    // 展開に使える ctx がまだ無い古い端末では、ctx ができたとき（attach）に取りに行く
    if (!decoder) return;
    // 読み終わる前に盤面が始まっていたら、読み終えたところから鳴らす
    this.track.load(decoder, () => {
      if (this.state === 'playing') this.begin();
    });
  }

  /** 曲を頭から鳴らす */
  start(): void {
    this.halt(0.05);
    this.offset = 0;
    this.state = 'stopped';
    this.play();
  }

  /** 止めたところから鳴らす。止めていなければ何もしない */
  play(): void {
    if (this.state === 'playing') return;
    this.state = 'playing';
    if (!this.ready) this.load();
    this.begin();
  }

  /** 止めて、いまの位置を覚えておく */
  pause(): void {
    if (this.state !== 'playing') return;
    if (this.ctx && this.track.sounding) this.offset = this.track.position(this.ctx.currentTime);
    this.halt(0.05);
    this.state = 'paused';
  }

  /** fade 秒かけて消し、次は頭から鳴らす */
  stop(fade = 0.3): void {
    this.halt(fade);
    this.offset = 0;
    this.state = 'stopped';
  }

  private begin(): void {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    this.track.begin(ctx, this.out, this.offset, ctx.currentTime + 0.02);
  }

  private halt(fade: number): void {
    this.track.halt(this.ctx, fade);
  }
}
