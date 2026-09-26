import type { Mixer } from './mixer';

/** 鳴り続けている値を書き替えるときの時定数（秒） */
const TAU = { up: 0.025, down: 0.18, filter: 0.05 } as const;

/** 静かになってから音源を止めるまでのフレーム数。画面が静かなあいだは音声スレッドも空ける */
const IDLE_FRAMES = 90;

/**
 * 鳴り続ける値。
 * 毎フレーム `setTargetAtTime` を打つと 1 本あたり 60 個/秒の予約が溜まり、
 * 音声スレッド側の探索が伸びる。前に書いた値から動いたときだけ打つ
 */
class Held {
  private last = -1;
  constructor(private readonly param: AudioParam) {
    param.value = 0;
  }

  set(value: number, now: number, tau: number): void {
    if (this.last >= 0 && Math.abs(value - this.last) < Math.abs(this.last) * 0.03 + 0.0005) return;
    this.last = value;
    this.param.setTargetAtTime(value, now, tau);
  }
}

/**
 * ループで鳴らすノイズ。
 * バッファは `Mixer` が焼いた 1 本を借りるだけで、ここでは作らない。
 * 止めたあとに鳴らし直すときも、作り直すのは `AudioBufferSourceNode` 1 本だけ
 */
class NoiseLoop {
  private src: AudioBufferSourceNode | null = null;
  private quiet = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly buffer: AudioBuffer,
    private readonly head: AudioNode,
  ) {}

  /** 鳴らす必要があるか（gain が正か）を毎フレーム渡す */
  update(wanted: boolean): void {
    if (wanted) {
      this.quiet = 0;
      if (!this.src) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.buffer;
        src.loop = true;
        src.connect(this.head);
        src.start(this.ctx.currentTime, Math.random() * this.buffer.duration);
        this.src = src;
      }
      return;
    }
    if (!this.src) return;
    this.quiet++;
    if (this.quiet < IDLE_FRAMES) return;
    // 減衰しきってから止める。止めたあとに聞こえる音は残っていない
    this.src.stop();
    this.src.disconnect();
    this.src = null;
  }

  stop(): void {
    this.quiet = IDLE_FRAMES;
    this.update(false);
  }
}

/**
 * 噴射で上がっているあいだ鳴り続ける燃焼音。
 *
 * カタマリごとに音を持たせると、2 つ浮いただけで音量が倍になって割れる。
 * 推進力の合計から 1 本の音の太さを決め、フィルタの開き具合で「上がっている／くすぶっている」を出す。
 * ノードは 1 度作るだけで、tick では gain と周波数しか動かさない
 */
export class Burner {
  private noise: NoiseLoop | null = null;
  private lp: BiquadFilterNode | null = null;
  private gain: Held | null = null;
  private cutoff: Held | null = null;
  private rumbleGain: Held | null = null;
  private rumbleFreq: Held | null = null;
  private lfoDepth: Held | null = null;
  private lfoFreq: Held | null = null;
  private wind: NoiseLoop | null = null;
  private windGain: Held | null = null;

  /** `Mixer.open` のあとに 1 度だけ呼ぶ */
  build(mixer: Mixer, white: AudioBuffer, brown: AudioBuffer): void {
    const ctx = mixer.ctx;
    const bus = mixer.busInput('burn');
    if (!ctx || !bus) return;

    // 噴射の芯。ノイズを lowpass で開け閉めして、火の強さを出す
    const burnGain = ctx.createGain();
    burnGain.connect(bus);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.9;
    lp.connect(burnGain);
    this.noise = new NoiseLoop(ctx, brown, lp);
    this.lp = lp;
    this.gain = new Held(burnGain.gain);
    this.cutoff = new Held(lp.frequency);

    // 腹に響く地鳴り。生の sawtooth は耳に刺さるので必ず lowpass を通す
    const rumbleGain = ctx.createGain();
    rumbleGain.connect(bus);
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 140;
    rumbleLp.connect(rumbleGain);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.connect(rumbleLp);
    osc.start();
    this.rumbleGain = new Held(rumbleGain.gain);
    this.rumbleFreq = new Held(osc.frequency);

    // 推進が切れて落ち始めたら、地鳴りを揺らして「くすぶり」にする
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const depth = ctx.createGain();
    lfo.connect(depth).connect(rumbleGain.gain);
    lfo.start();
    this.lfoDepth = new Held(depth.gain);
    this.lfoFreq = new Held(lfo.frequency);

    // 加速の風。同じく 1 本を使い回す
    const windGain = ctx.createGain();
    windGain.connect(bus);
    const windBp = ctx.createBiquadFilter();
    windBp.type = 'bandpass';
    windBp.frequency.value = 1200;
    windBp.Q.value = 0.5;
    windBp.connect(windGain);
    this.wind = new NoiseLoop(ctx, white, windBp);
    this.windGain = new Held(windGain.gain);
  }

  /**
   * 1 フレームぶん動かす。
   * `rise` は推進力を供給しているぶん、`hover` は浮いたまま／落ちているぶん
   */
  update(rise: number, hover: number, boost: boolean, now: number): void {
    if (!this.noise || !this.lp || !this.gain || !this.cutoff) return;
    const power = Math.min(3, rise + hover);
    const r = Math.min(1, rise / 2.5);
    const burning = power > 0;

    this.noise.update(burning);
    this.gain.set(burning ? 0.1 + 0.22 * Math.min(1, power / 2.5) : 0, now, burning ? TAU.up : TAU.down);
    // 落ちているだけなら低くこもり、噴いているあいだは開けて明るくなる
    this.cutoff.set(350 + 1400 * r + (boost ? 150 : 0), now, TAU.filter);
    this.rumbleGain?.set(burning ? 0.06 + 0.1 * r : 0, now, burning ? TAU.up : TAU.down);
    this.rumbleFreq?.set(55 + 22 * r, now, TAU.filter);
    this.lfoFreq?.set(boost ? 10 : 7, now, TAU.filter);
    this.lfoDepth?.set(burning && rise === 0 ? 0.35 * (0.06 + 0.1 * r) : 0, now, TAU.filter);

    this.wind?.update(boost);
    this.windGain?.set(boost ? 0.06 : 0, now, boost ? 0.05 : 0.15);
  }

  /** 盤面を止めるとき（メニュー・一時停止・滅亡）。鳴っているものを畳む */
  hush(now: number): void {
    this.gain?.set(0, now, 0.05);
    this.rumbleGain?.set(0, now, 0.05);
    this.lfoDepth?.set(0, now, 0.05);
    this.windGain?.set(0, now, 0.05);
    this.noise?.stop();
    this.wind?.stop();
  }
}
