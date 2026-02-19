/**
 * KRIC runway utilities — approach capability, availability, and flow defaults.
 *
 * DA/MDA values match PilotAI.ts which hardcodes:
 *   ILS  = runway.elevation + 200 ft (CAT I)
 *   RNAV = runway.elevation + 400 ft (LPV/LNAV)
 * The kric.json approach `minimums` field is currently unused by the server.
 * Vis mins: ILS CAT I = 0.5 SM (RVR 2400), RNAV = 1.0 SM.
 */
import type { WeatherState } from '@atc-sim/shared';

export interface RunwayInfo {
  heading: number;
  lengthFt: number;
  /** null = no ILS published for this end */
  ilsMinimumsAGL: number | null;
  /** null = no RNAV published for this end */
  rnavMinimumsAGL: number | null;
}

export const KRIC_RUNWAY_INFO: Record<string, RunwayInfo> = {
  '16': { heading: 157, lengthFt: 9003, ilsMinimumsAGL: 200, rnavMinimumsAGL: 400 },
  '34': { heading: 337, lengthFt: 9003, ilsMinimumsAGL: 200, rnavMinimumsAGL: 400 },
  '02': { heading:  23, lengthFt: 6607, ilsMinimumsAGL: 200, rnavMinimumsAGL: 400 },
  '20': { heading: 203, lengthFt: 6607, ilsMinimumsAGL: null, rnavMinimumsAGL: 400 },
};

export const KRIC_RUNWAYS: readonly string[] = ['16', '34', '02', '20'];

/**
 * Returns the best available approach type for a runway given current weather.
 *
 * Priority: VISUAL > ILS > RNAV > null (below all minimums)
 *
 * Visual: ceiling ≥ 1000 ft AGL, vis ≥ 3 SM (FAA VFR minimum)
 * ILS CAT I: ceiling ≥ 200 ft HAT, vis ≥ 0.5 SM (RVR 2400)
 * RNAV LPV: ceiling ≥ 400 ft HAT, vis ≥ 1.0 SM
 */
export function approachCapability(
  rwyId: string,
  wx: WeatherState,
): 'ILS' | 'RNAV' | 'VISUAL' | null {
  const info = KRIC_RUNWAY_INFO[rwyId];
  if (!info) return null;

  const ceiling = wx.ceiling ?? Infinity;
  const vis = wx.visibility;

  if (ceiling >= 1000 && vis >= 3) return 'VISUAL';
  if (info.ilsMinimumsAGL !== null && ceiling >= info.ilsMinimumsAGL && vis >= 0.5) return 'ILS';
  if (info.rnavMinimumsAGL !== null && ceiling >= info.rnavMinimumsAGL && vis >= 1.0) return 'RNAV';
  return null;
}

/** Runways that have at least one usable approach under the current weather */
export function availableRunways(wx: WeatherState): string[] {
  return (KRIC_RUNWAYS as string[]).filter(r => approachCapability(r, wx) !== null);
}

/**
 * Determine the default active runway set for the given weather.
 *
 * All available runways that have a headwind component (wind-to-runway angle ≤ 90°)
 * are included. Tailwind runways (angle > 90°) are excluded from the default.
 * Calm/variable winds (< 3 kt) → prefer north flow (RWY 34/02).
 * Falls back to ['34'] if no runways are available (should not happen after wx clamp).
 */
export function defaultRunwayConfig(wx: WeatherState): { arr: string[]; dep: string[] } {
  const avail = availableRunways(wx);
  if (avail.length === 0) return { arr: ['34'], dep: ['34'] };

  const windDir = wx.winds[0]?.direction ?? 0;
  const windSpd = wx.winds[0]?.speed ?? 0;

  if (windSpd < 3) {
    // Calm/variable — default north flow (34/02)
    const northFlow = avail.filter(r => ['34', '02'].includes(r));
    const active = northFlow.length ? northFlow : avail;
    return { arr: active, dep: active };
  }

  // Keep runways whose heading is within 90° of the wind direction (headwind component)
  const inFlow = avail.filter(r => {
    const hdg = KRIC_RUNWAY_INFO[r].heading;
    const angle = Math.abs(((windDir - hdg + 180 + 360) % 360) - 180);
    return angle <= 90;
  });

  const active = inFlow.length > 0 ? inFlow : avail; // safety fallback if no headwind rwy
  return { arr: active, dep: active };
}
