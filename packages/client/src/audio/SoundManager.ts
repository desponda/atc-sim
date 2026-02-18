/**
 * ATC sound effects synthesized with Web Audio API.
 * No audio files required — all tones are generated programmatically.
 */

let ctx: AudioContext | null = null;
let muted = false;

function getCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
  }
  // Resume if suspended (browsers require user gesture before playing audio)
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
  return ctx;
}

function masterGain(): GainNode {
  const g = getCtx().createGain();
  g.gain.value = muted ? 0 : 0.4;
  g.connect(getCtx().destination);
  return g;
}

/** Single tone burst */
function tone(
  freqHz: number,
  durationSec: number,
  startSec: number,
  gainNode: GainNode,
  type: OscillatorType = 'sine',
  fadeOut = true
): void {
  const ac = getCtx();
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.value = freqHz;
  osc.connect(env);
  env.connect(gainNode);
  env.gain.setValueAtTime(1, ac.currentTime + startSec);
  if (fadeOut) {
    env.gain.linearRampToValueAtTime(0, ac.currentTime + startSec + durationSec);
  } else {
    env.gain.setValueAtTime(0, ac.currentTime + startSec + durationSec);
  }
  osc.start(ac.currentTime + startSec);
  osc.stop(ac.currentTime + startSec + durationSec + 0.01);
}

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------

/**
 * Conflict Alert: double fast alternating beep ×3 (classic STARS CA sound).
 * High urgency, cuts through noise.
 */
export function playConflictAlert(): void {
  const g = masterGain();
  const hi = 1100;
  const lo = 700;
  const dur = 0.07;
  const gap = 0.03;
  const cycleLen = (dur + gap) * 2;
  for (let i = 0; i < 3; i++) {
    const base = i * (cycleLen + 0.05);
    tone(hi, dur, base, g, 'square');
    tone(lo, dur, base + dur + gap, g, 'square');
  }
}

/**
 * MSAW (Minimum Safe Altitude Warning): rapid-fire pulses at low frequency.
 * More urgent and lower-pitch than CA.
 */
export function playMSAW(): void {
  const g = masterGain();
  for (let i = 0; i < 6; i++) {
    tone(440, 0.06, i * 0.09, g, 'sawtooth');
  }
}

/**
 * New flight strip / aircraft check-in: single clean chime.
 * Pleasant ping indicating new contact.
 */
export function playNewStrip(): void {
  const g = masterGain();
  tone(880, 0.25, 0, g, 'sine', true);
  tone(1320, 0.15, 0.05, g, 'sine', true);
}

/**
 * Radar handoff initiated: short double-click.
 * Data-link acknowledgement sound.
 */
export function playHandoffOffered(): void {
  const g = masterGain();
  tone(1200, 0.04, 0, g, 'sine', false);
  tone(1200, 0.04, 0.08, g, 'sine', false);
}

/**
 * Radar handoff accepted: quick rising two-tone.
 */
export function playHandoffAccepted(): void {
  const g = masterGain();
  tone(800, 0.08, 0, g, 'sine', false);
  tone(1200, 0.1, 0.1, g, 'sine', true);
}

/**
 * Radar handoff rejected: low descending tone.
 */
export function playHandoffRejected(): void {
  const g = masterGain();
  tone(600, 0.08, 0, g, 'sine', false);
  tone(400, 0.1, 0.1, g, 'sine', true);
}

/**
 * Pilot radio transmission received: short radio squelch break tone.
 * Subtle — doesn't compete with alert sounds.
 */
export function playPilotMessage(): void {
  const g = masterGain();
  g.gain.value = muted ? 0 : 0.15; // quieter than alerts
  tone(1050, 0.04, 0, g, 'sine', false);
}

/**
 * Runway conflict / incursion alert: distinctive short alarm.
 */
export function playRunwayAlert(): void {
  const g = masterGain();
  for (let i = 0; i < 2; i++) {
    tone(900, 0.12, i * 0.18, g, 'square');
  }
}

// ---------------------------------------------------------------------------
// Mute control
// ---------------------------------------------------------------------------

export function setMuted(m: boolean): void {
  muted = m;
}

export function isMuted(): boolean {
  return muted;
}

/**
 * Call once on first user interaction to unlock the AudioContext.
 * Call from a click/keydown handler in the UI.
 */
export function unlockAudio(): void {
  getCtx();
}
