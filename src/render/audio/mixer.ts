import { BUS_TRIM, ECHO, MASTER_EQ, MASTER_GAIN, METAL_RATIOS, ROOM, ROOM_SEND } from './palette';

export type BusName = keyof typeof BUS_TRIM;

/**
 * 鳴らす優先度。数が小さいほど大事。
 * 音源の数がそのまま音声スレッドの負荷になるので、混んできたら下から捨てる
 */
export type Priority = 1 | 2 | 3 | 4 | 5;

/** 同時に生かしておける音源（オシレータとバッファ）の数 */
const MAX_SOURCES = 24;

export interface Env {
  /** 立ち上がりの時間（秒） */
  attack?: number;
  /** 頂点を保つ時間（秒） */
  hold?: number;
  /** 減衰の時定数（秒）。省略すると dur / 5 */
  tau?: number;
}

export interface VoiceOpts {
  bus: BusName;
  type: OscillatorType;
  f0: number;
  /** 終わりの周波数。指数で寄せる */
  f1?: number;
  /** f0 から f1 へ寄せる時間（秒）。省略すると dur いっぱい */
  sweep?: number;
  gain: number;
  dur: number;
  /** 鳴らし始めを遅らせる秒数 */
  at?: number;
  env?: Env;
  /** sawtooth と square を生のままマスターへ出さないための lowpass */
  lowpass?: number;
  /** 音程をずらす（セント）。同じ音を少しずらして 2 本重ねると厚みが出る */
  detune?: number;
  /** 左右の位置（-1 が左、1 が右）。盤面のどの列で起きたかに合わせる */
  pan?: number;
  /** 左右を行き来するこだまへ送る量 */
  echo?: number;
  priority: Priority;
}

export interface NoiseOpts {
  bus: BusName;
  color: 'white' | 'brown';
  filter: { type: BiquadFilterType; f0: number; f1?: number; q?: number };
  gain: number;
  dur: number;
  at?: number;
  env?: Env;
  pan?: number;
  echo?: number;
  priority: Priority;
}

/**
 * バスと空間と音源の生成をまとめて持つ。
 *
 * 守っていること（描画と同じで、ここを崩すとスマホで音がフレームを食う）
 * - ノイズのバッファは unlock で 2 本焼くだけ。鳴らすたびに `createBuffer` しない
 *   （1 回 2 万要素の書き込みになり、10 連鎖なら 1 フレームで 40 万要素になる）
 * - 減衰は `setTargetAtTime`。`exponentialRampToValueAtTime` で 0 へ落とすと最後に段が付いて鳴る
 * - `ConvolverNode` / `PeriodicWave` / `WaveShaper` / `AnalyserNode` / `AudioWorklet` は使わない
 * - ノードは `ctx.createGain()` 形式で作る。`new GainNode(ctx)` は iOS 14 以前に無い
 */
export class Mixer {
  ctx: AudioContext | null = null;
  muted = false;

  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private input = new Map<BusName, GainNode>();
  private ducks = new Map<string, GainNode>();
  private echoIn: GainNode | null = null;
  private white: AudioBuffer | null = null;
  private brown: AudioBuffer | null = null;
  /** いま鳴っている音源の数。`onended` で減る */
  private active = 0;
  /** このフレームの基準時刻（`beginFrame` が入れる） */
  private frameNow = 0;

  /** 最初のタップの中で呼ぶ。ブラウザはユーザー操作の中でしか音を出せない */
  open(): boolean {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return true;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    const ctx = new Ctor();
    this.ctx = ctx;

    // マスターの後ろに limiter を置く。いちばん派手な瞬間（爆発 + 大気圏突破 + 着地）で
    // 和が 1.0 を越えてもここで潰れるので割れない
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 8;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    limiter.connect(ctx.destination);

    // 味付け。低い中域（打撃の芯）と高域（きらめき）を少しだけ持ち上げてから limiter へ
    const punch = ctx.createBiquadFilter();
    punch.type = 'lowshelf';
    punch.frequency.value = MASTER_EQ.punch.f;
    punch.gain.value = MASTER_EQ.punch.gain;
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = MASTER_EQ.air.f;
    air.gain.value = MASTER_EQ.air.gain;
    punch.connect(air).connect(limiter);

    // 曲は効果音の味付け（EQ・部屋・こだま）を通さず、limiter にだけ入れる。
    // 曲そのものがもう仕上がっているので、響きを足すと濁る
    const music = ctx.createGain();
    music.gain.value = this.muted ? 0 : 1;
    music.connect(limiter);
    this.music = music;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_GAIN;
    master.connect(punch);
    this.master = master;

    // 共通の部屋。長さの違う櫛を 4 本並べ、左右に振って広がりを出す
    const room = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = ROOM.wet;
    wet.connect(master);
    ROOM.combs.forEach((time, i) => {
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = time;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = ROOM.lowpass;
      const fb = ctx.createGain();
      fb.gain.value = ROOM.feedback;
      room.connect(delay);
      delay.connect(lp).connect(fb).connect(delay);
      this.panned(ctx, lp, i % 2 === 0 ? -0.7 : 0.7).connect(wet);
    });

    // 左右を行き来するこだま。左に 190ms、右に 280ms で返し、互いに帰還させる
    const echoIn = ctx.createGain();
    echoIn.gain.value = ECHO.send;
    const echoLp = ctx.createBiquadFilter();
    echoLp.type = 'lowpass';
    echoLp.frequency.value = ECHO.lowpass;
    echoIn.connect(echoLp);
    const left = ctx.createDelay(1);
    left.delayTime.value = ECHO.left;
    const right = ctx.createDelay(1);
    right.delayTime.value = ECHO.right;
    const lfb = ctx.createGain();
    lfb.gain.value = ECHO.feedback;
    const rfb = ctx.createGain();
    rfb.gain.value = ECHO.feedback;
    echoLp.connect(left);
    left.connect(lfb).connect(right);
    right.connect(rfb).connect(left);
    this.panned(ctx, left, -0.8).connect(master);
    this.panned(ctx, right, 0.8).connect(master);
    this.echoIn = echoIn;

    for (const name of Object.keys(BUS_TRIM) as BusName[]) {
      const trim = ctx.createGain();
      trim.gain.value = BUS_TRIM[name];
      // 爆発のあいだ引っ込ませたいバスにだけ、音量を折る節を挟む
      if (name === 'burn' || name === 'move') {
        const duck = ctx.createGain();
        duck.gain.value = 1;
        trim.connect(duck).connect(master);
        this.ducks.set(name, duck);
      } else {
        trim.connect(master);
      }
      const send = ROOM_SEND[name];
      if (send > 0) {
        const s = ctx.createGain();
        s.gain.value = send;
        trim.connect(s).connect(room);
      }
      this.input.set(name, trim);
    }

    this.white = this.makeNoise(ctx, false);
    this.brown = this.makeNoise(ctx, true);
    return true;
  }

  /**
   * node を左右の pan に振った出口を返す。StereoPanner の無い古い端末では真ん中のまま
   */
  private panned(ctx: AudioContext, node: AudioNode, pan: number): AudioNode {
    if (pan === 0 || typeof ctx.createStereoPanner !== 'function') return node;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    return node.connect(p);
  }

  /** 1 つの音の出口。左右に振り、頼まれていればこだまへも送る */
  private route(ctx: AudioContext, tail: AudioNode, bus: GainNode, pan = 0, echo = 0): void {
    const out = this.panned(ctx, tail, pan);
    out.connect(bus);
    if (echo > 0 && this.echoIn) {
      const s = ctx.createGain();
      s.gain.value = echo;
      out.connect(s).connect(this.echoIn);
    }
  }

  /** ミュートはノードを外さず master を絞る。持続音の帳尻が狂わない */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, this.ctx.currentTime, 0.01);
    this.music?.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
  }

  /** 曲の入口（`Music` がつなぐ） */
  get musicInput(): GainNode | null {
    return this.music;
  }

  /** バスの入口。持続音（`Burner`）もここへ挿す */
  busInput(name: BusName): GainNode | null {
    return this.input.get(name) ?? null;
  }

  /** 焼いたノイズ。持続音（`Burner`）が同じ 1 本を借りて鳴らす */
  get noiseBuffers(): { white: AudioBuffer; brown: AudioBuffer } | null {
    return this.white && this.brown ? { white: this.white, brown: this.brown } : null;
  }

  get sources(): number {
    return this.active;
  }

  /**
   * このフレームの基準時刻を読み直す。
   * `ctx.currentTime` はスレッドをまたぐ読み出しなので 1 フレームに 1 回だけ読む。
   * 同じフレームの音を同じ時刻から並べれば、遅れ（`at`）の関係も崩れない
   */
  beginFrame(): number {
    // 5ms 先を基準にする。過去の時刻に予約すると立ち上がりが欠けてプチッと鳴る
    this.frameNow = this.ctx ? this.ctx.currentTime + 0.005 : 0;
    return this.frameNow;
  }

  get now(): number {
    return this.frameNow;
  }

  /**
   * 爆発の瞬間だけ、鳴り続けている音と指の音を引っ込める。
   * 爆発が前に出て、盤面で何が起きたかが音だけで分かる
   */
  duck(name: 'burn' | 'move', to: number, hold: number, tau: number): void {
    const duck = this.ducks.get(name);
    if (!duck || !this.ctx) return;
    const t0 = this.now;
    duck.gain.cancelScheduledValues(t0);
    duck.gain.setValueAtTime(to, t0);
    duck.gain.setTargetAtTime(1, t0 + hold, tau);
  }

  /**
   * 混み具合で捨てる。優先度 1（爆発の芯と連鎖の音程）だけは捨てない（合流と間引きで数が抑えてある）。
   * 2 は上限いっぱいまで、3 以下は上限の手前で捨てる
   */
  private rejects(priority: Priority): boolean {
    if (priority >= 5) return this.active > MAX_SOURCES - 10;
    if (priority >= 3) return this.active > MAX_SOURCES - 4;
    if (priority === 2) return this.active >= MAX_SOURCES;
    return false;
  }

  private envelope(g: GainNode, peak: number, t0: number, dur: number, env?: Env): void {
    const attack = env?.attack ?? 0.002;
    const hold = env?.hold ?? 0;
    const tau = env?.tau ?? dur / 5;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.setTargetAtTime(0, t0 + attack + hold, tau);
  }

  /** 音源が増えた／減ったを数える。数がそのまま音声スレッドの負荷になる */
  private track(src: AudioScheduledSourceNode): void {
    this.active++;
    src.onended = () => {
      this.active--;
      src.onended = null;
    };
  }

  voice(o: VoiceOpts): void {
    const ctx = this.ctx;
    const bus = this.input.get(o.bus);
    if (!ctx || !bus || this.muted || o.gain <= 0 || this.rejects(o.priority)) return;
    const t0 = this.now + (o.at ?? 0);

    const osc = ctx.createOscillator();
    osc.type = o.type;
    if (o.detune) osc.detune.value = o.detune;
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 !== undefined && o.f1 !== o.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + (o.sweep ?? o.dur));
    }
    const g = ctx.createGain();
    this.envelope(g, o.gain, t0, o.dur, o.env);

    let tail: AudioNode = osc;
    if (o.lowpass !== undefined) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lowpass;
      tail = osc.connect(lp);
    }
    this.route(ctx, tail.connect(g), bus, o.pan, o.echo);
    this.track(osc);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
  }

  noise(o: NoiseOpts): void {
    const ctx = this.ctx;
    const bus = this.input.get(o.bus);
    const buffer = o.color === 'brown' ? this.brown : this.white;
    if (!ctx || !bus || !buffer || this.muted || o.gain <= 0 || this.rejects(o.priority)) return;
    const t0 = this.now + (o.at ?? 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // 焼いた 1 本を毎回ちがう場所から鳴らす。同じ波形の繰り返しに聞こえない
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = o.filter.type;
    filter.frequency.setValueAtTime(o.filter.f0, t0);
    if (o.filter.f1 !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.filter.f1), t0 + o.dur);
    }
    filter.Q.value = o.filter.q ?? 1;

    const g = ctx.createGain();
    this.envelope(g, o.gain, t0, o.dur, o.env);
    this.route(ctx, src.connect(filter).connect(g), bus, o.pan, o.echo);
    this.track(src);
    src.start(t0, Math.random() * Math.max(0, buffer.duration - o.dur - 0.1));
    src.stop(t0 + o.dur + 0.05);
  }

  /** 叩いた金属。非整数倍音の sine を重ねる。音源を本数ぶん使うので gain は控えめに */
  metal(
    bus: BusName,
    root: number,
    gain: number,
    dur: number,
    partials: number,
    at = 0,
    priority: Priority = 2,
    pan = 0,
    echo = 0,
  ): void {
    const weights = [1, 0.5, 0.35, 0.2, 0.1];
    for (let i = 0; i < Math.min(partials, METAL_RATIOS.length); i++) {
      this.voice({
        bus,
        type: 'sine',
        f0: root * METAL_RATIOS[i],
        gain: gain * weights[i],
        dur: dur * (1 - i * 0.12),
        at,
        env: { tau: dur / 4 },
        pan,
        echo,
        priority,
      });
    }
  }

  /**
   * ノイズを 2 秒ぶんだけ焼く。
   * brown は white を積分して低域を持ち上げたもので、爆発の「腹」と砂利に使う
   */
  private makeNoise(ctx: AudioContext, brown: boolean): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        b = (b + 0.02 * w) / 1.02;
        data[i] = b * 3.5;
      } else {
        data[i] = w;
      }
    }
    return buf;
  }
}
