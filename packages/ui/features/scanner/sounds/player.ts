/**
 * The scanner's speaker: six short sounds, decoded once and played through one `AudioContext`.
 *
 * **Web Audio rather than an `<audio>` per sound.** A media element's `play()` is refused without
 * a fresh user gesture on Android's WebView (`mediaPlaybackRequiresUserGesture`), and a card lands
 * seconds after the last press — the pump's answer, not the reader's hand. An `AudioContext` needs
 * the page's activation once, which a reader who navigated to the Scanner has already given; it is
 * resumed again on any press in case the platform suspended it. Decoded buffers also start within
 * a frame, where a media element seeks and buffers each time.
 *
 * **One sound at a time**: a new one stops the one before. A reader feeding a pile at the camera
 * lands a card a second, and the jackpot's three seconds under four beeps would be noise.
 *
 * **Nothing here can throw at a caller.** A host with no Web Audio (jsdom, an old browser), a file
 * that will not decode and a context the platform will not resume each mean the scan is silent —
 * never a broken scanner.
 */
import jackpotUrl from "./jackpot.wav";
import tier1Url from "./price-tier-1.wav";
import tier2Url from "./price-tier-2.wav";
import tier3Url from "./price-tier-3.wav";
import needsInputUrl from "./scan-needs-input.wav";
import okUrl from "./scan-ok.wav";
import type { ScanSound } from "./scanSounds";

/** Each sound's file, as the build names it. */
export const SOUND_URL: Record<ScanSound, string> = {
  ok: okUrl,
  "needs-input": needsInputUrl,
  tier1: tier1Url,
  tier2: tier2Url,
  tier3: tier3Url,
  jackpot: jackpotUrl,
};

let context: AudioContext | null = null;
const buffers = new Map<ScanSound, Promise<AudioBuffer | null>>();
let playing: AudioBufferSourceNode | null = null;

/** The context, made on first use — `null` on a host with no Web Audio. */
function audio(): AudioContext | null {
  if (context !== null) return context;
  if (typeof AudioContext === "undefined") return null;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  // A context made before the page was pressed starts suspended; any press brings it back.
  const wake = () => {
    if (context?.state === "suspended") void context.resume().catch(() => {});
  };
  window.addEventListener("pointerdown", wake, { capture: true, passive: true });
  window.addEventListener("keydown", wake, { capture: true });
  return context;
}

/** One sound's decoded buffer, fetched and decoded once; `null` if it would not load. */
function buffer(ctx: AudioContext, sound: ScanSound): Promise<AudioBuffer | null> {
  let decoded = buffers.get(sound);
  if (decoded === undefined) {
    decoded = fetch(SOUND_URL[sound])
      .then((response) => response.arrayBuffer())
      .then((bytes) => ctx.decodeAudioData(bytes))
      .catch(() => null);
    buffers.set(sound, decoded);
  }
  return decoded;
}

/** Fetch and decode every sound now, so the first card that lands is not the one that waits. */
export function preloadScanSounds(): void {
  const ctx = audio();
  if (ctx === null) return;
  for (const sound of Object.keys(SOUND_URL) as ScanSound[]) void buffer(ctx, sound);
}

/** Play one sound, stopping whichever was playing. Silent wherever it cannot play. */
export function playScanSound(sound: ScanSound): void {
  const ctx = audio();
  if (ctx === null) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  void buffer(ctx, sound).then((decoded) => {
    if (decoded === null) return;
    try {
      playing?.stop();
    } catch {
      // Already ended.
    }
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.onended = () => {
      if (playing === source) playing = null;
    };
    playing = source;
    source.start();
  });
}
