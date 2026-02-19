import type { WeatherState } from '@atc-sim/shared';

export type WxCategory = 'VMC' | 'MVMC' | 'IFR' | 'LIFR';

export interface WxConditions {
  weather: WeatherState;
  category: WxCategory;
  /** True when visual approaches are legal (ceiling ≥ 1000 AGL, vis ≥ 3 SM) */
  visualOk: boolean;
  /** Short plain-English description for the briefing */
  description: string;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickWeighted<T>(items: { value: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.value;
  }
  return items[items.length - 1].value;
}

/** Generate a realistic random KRIC weather condition. */
export function generateRandomWeather(): WxConditions {
  // Virginia/Mid-Atlantic prevailing winds
  const windDir = pickWeighted([
    { value: Math.round(rand(180, 250)), weight: 40 }, // SW (prevailing)
    { value: Math.round(rand(280, 330)), weight: 25 }, // NW
    { value: Math.round(rand(330, 390) % 360), weight: 20 }, // N/NE
    { value: Math.round(rand(120, 180)), weight: 15 }, // S/SE
  ]);

  const windSpd = pickWeighted([
    { value: Math.round(rand(0, 4)), weight: 15 },   // calm
    { value: Math.round(rand(5, 15)), weight: 50 },  // light
    { value: Math.round(rand(15, 25)), weight: 25 }, // moderate
    { value: Math.round(rand(22, 35)), weight: 10 }, // gusty
  ]);

  const gusts = windSpd >= 18 && Math.random() < 0.5
    ? windSpd + Math.round(rand(5, 12))
    : null;

  const altimeter = parseFloat((rand(29.60, 30.20)).toFixed(2));

  // Weather category weighted for Virginia
  const cat = pickWeighted<WxCategory>([
    { value: 'VMC',  weight: 50 },
    { value: 'MVMC', weight: 22 },
    { value: 'IFR',  weight: 20 },
    { value: 'LIFR', weight: 8 },
  ]);

  let visibility: number;
  let ceiling: number | null;
  let description: string;

  switch (cat) {
    case 'VMC':
      visibility = pickWeighted([
        { value: 10, weight: 70 },
        { value: Math.round(rand(6, 9)), weight: 30 },
      ]);
      ceiling = Math.random() < 0.4 ? null : Math.round(rand(4500, 12000) / 500) * 500;
      description = ceiling === null
        ? 'Clear skies, excellent visibility'
        : `Few/scattered clouds at ${(ceiling / 1000).toFixed(1)}k ft`;
      break;

    case 'MVMC':
      visibility = parseFloat(rand(3, 6).toFixed(1));
      ceiling = Math.round(rand(1500, 3500) / 100) * 100;
      description = `Marginal VFR — broken ceiling at ${ceiling} ft`;
      break;

    case 'IFR':
      visibility = parseFloat(rand(0.75, 3).toFixed(1));
      ceiling = Math.round(rand(400, 1200) / 100) * 100;
      description = `IFR — overcast ceiling at ${ceiling} ft, vis ${visibility} SM`;
      break;

    case 'LIFR':
      visibility = parseFloat(rand(0.1, 0.75).toFixed(2));
      ceiling = Math.round(rand(100, 400) / 100) * 100;
      description = `Low IFR — ceiling ${ceiling} ft, vis ${visibility} SM`;
      break;
  }

  // ── Playability guarantee ───────────────────────────────────────────────
  // Ensure at least one ILS approach is always flyable so sessions are never
  // unplayable. KRIC CAT I ILS: 200 ft HAT / 0.5 SM (RVR 2400).
  // Floor uses a 50 ft buffer above the DA so the ceiling clears minimums.
  const ILS_CEILING_FLOOR = 250; // ft AGL (200 ft DA + 50 ft buffer)
  const ILS_VIS_FLOOR = 0.5;     // SM — CAT I ILS minimum (RVR 2400)
  if (ceiling !== null && ceiling < ILS_CEILING_FLOOR) {
    ceiling = ILS_CEILING_FLOOR;
  }
  if (visibility < ILS_VIS_FLOOR) {
    visibility = ILS_VIS_FLOOR;
  }
  // Refresh LIFR description if either value was clamped
  if (cat === 'LIFR') {
    description = `Low IFR — ceiling ${ceiling} ft, vis ${visibility.toFixed(2)} SM`;
  }
  // ────────────────────────────────────────────────────────────────────────

  const visualOk = (ceiling === null || ceiling >= 1000) && visibility >= 3;

  const weather: WeatherState = {
    winds: [{ altitude: 0, direction: windDir, speed: windSpd, gusts }],
    altimeter,
    temperature: Math.round(rand(-5, 32)),
    visibility,
    ceiling: ceiling ?? null,
    atisLetter: 'A',
  };

  return { weather, category: cat, visualOk, description };
}

export function wxCategoryColor(cat: WxCategory): string {
  switch (cat) {
    case 'VMC':  return '#00cc44';
    case 'MVMC': return '#ffbb00';
    case 'IFR':  return '#ff6633';
    case 'LIFR': return '#ff2222';
  }
}
