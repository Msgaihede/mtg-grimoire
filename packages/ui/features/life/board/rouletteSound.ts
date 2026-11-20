/**
 * The roulette's sound — a ball ticking round a wheel and a chime where it lands — synthesized on
 * the spot rather than played from a file: a pinch of filtered noise per tick, four sine bells for
 * the chime. Nothing to download, nothing to cache, and no setting: it plays only on a press of
 * *Pick who goes first*, which is a reader asking for exactly this.
 *
 * **The context is made lazily, on that press.** A browser (and Android's WebView) starts an
 * `AudioContext` made outside a user gesture suspended, and one made at mount would be a context
 * for a board most games never spin. Every voice is put on the audio clock up front, so the ticks
 * keep time with the light however busy the page is, and every voice is kept so the board can stop
 * them all — a second spin, or the board leaving mid-spin.
 */

type AudioContextCtor = typeof AudioContext;

export class RouletteSound {
  private ctx: AudioContext | null = null;
  private clack: AudioBuffer | null = null;
  private voices: AudioScheduledSourceNode[] = [];

  /** The context, made on first use; `null` where the page has no Web Audio. */
  context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      (window as unknown as { AudioContext?: AudioContextCtor }).AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    return this.ctx;
  }

  /** The audio clock's now, a hair ahead so the first voice is not scheduled in the past; or
   *  `null` without sound. Resumes a context the browser suspended. */
  start(): number | null {
    const ctx = this.context();
    if (!ctx) return null;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx.currentTime + 0.03;
  }

  /** The ball on a fret: noise through a band-pass, with a short falling knock under it. */
  tickAt(when: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (!this.clack || this.clack.sampleRate !== ctx.sampleRate) {
        const length = Math.floor(ctx.sampleRate * 0.03);
        this.clack = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = this.clack.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = this.clack;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 2400 + Math.random() * 700;
      band.Q.value = 2.5;
      const level = ctx.createGain();
      level.gain.setValueAtTime(0.5, when);
      level.gain.exponentialRampToValueAtTime(0.001, when + 0.035);
      noise.connect(band);
      band.connect(level);
      level.connect(ctx.destination);
      noise.start(when);

      const knock = ctx.createOscillator();
      knock.type = "triangle";
      knock.frequency.setValueAtTime(1500, when);
      knock.frequency.exponentialRampToValueAtTime(650, when + 0.03);
      const body = ctx.createGain();
      body.gain.setValueAtTime(0.16, when);
      body.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
      knock.connect(body);
      body.connect(ctx.destination);
      knock.start(when);
      knock.stop(when + 0.06);
      this.voices.push(noise, knock);
    } catch {
      // A context that refuses a node is a roulette without sound, which is still a roulette.
    }
  }

  /** The win: four bell notes climbing a major chord, each ringing out. */
  chimeAt(when: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      for (const [frequency, offset] of [
        [1046.5, 0],
        [1318.5, 0.08],
        [1568, 0.16],
        [2093, 0.26],
      ]) {
        const at = when + offset;
        const bell = ctx.createOscillator();
        bell.type = "sine";
        bell.frequency.value = frequency;
        const ring = ctx.createGain();
        ring.gain.setValueAtTime(0.0001, at);
        ring.gain.exponentialRampToValueAtTime(0.2, at + 0.012);
        ring.gain.exponentialRampToValueAtTime(0.0008, at + 0.7);
        bell.connect(ring);
        ring.connect(ctx.destination);
        bell.start(at);
        bell.stop(at + 0.75);
        this.voices.push(bell);
      }
    } catch {
      // As for a tick.
    }
  }

  /** Stop every voice still scheduled or ringing. */
  stopAll(): void {
    for (const voice of this.voices) {
      try {
        voice.stop();
      } catch {
        // Already stopped, or never started: either way it is silent.
      }
    }
    this.voices = [];
  }

  /** Stop everything and let the context go — the board is leaving. */
  close(): void {
    this.stopAll();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) ctx.close().catch(() => {});
  }
}
