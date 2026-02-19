/**
 * weatherGen Unit Tests
 *
 * Covers: playability clamp (ceiling ≥ 250 ft, vis ≥ 0.5 SM always), LIFR
 * description refresh after clamp, output structure, and statistical sanity
 * checks via repeated runs.
 */
import { describe, it, expect } from 'vitest';
import { generateRandomWeather, wxCategoryColor } from '../ui/weatherGen';

// ─── Constants mirrored from weatherGen.ts ───────────────────────────────────

const ILS_CEILING_FLOOR = 250;  // ft AGL
const ILS_VIS_FLOOR = 0.5;      // SM

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run the generator N times and collect all results */
function runMany(n = 500) {
  return Array.from({ length: n }, () => generateRandomWeather());
}

// ─── Structure ────────────────────────────────────────────────────────────────

describe('generateRandomWeather — output structure', () => {
  it('returns a weather object with the required fields', () => {
    const { weather, category, visualOk, description } = generateRandomWeather();

    // Top-level shape
    expect(category).toMatch(/^(VMC|MVMC|IFR|LIFR)$/);
    expect(typeof visualOk).toBe('boolean');
    expect(typeof description).toBe('string');
    expect(description.length).toBeGreaterThan(0);

    // WeatherState fields
    expect(weather.winds).toBeInstanceOf(Array);
    expect(weather.winds).toHaveLength(1);
    expect(typeof weather.altimeter).toBe('number');
    expect(typeof weather.temperature).toBe('number');
    expect(typeof weather.visibility).toBe('number');
    expect(weather.atisLetter).toBe('A');
  });

  it('wind direction is between 0 and 359', () => {
    const results = runMany(200);
    for (const { weather } of results) {
      const dir = weather.winds[0].direction;
      expect(dir).toBeGreaterThanOrEqual(0);
      expect(dir).toBeLessThanOrEqual(359);
    }
  });

  it('wind speed is non-negative', () => {
    const results = runMany(200);
    for (const { weather } of results) {
      expect(weather.winds[0].speed).toBeGreaterThanOrEqual(0);
    }
  });

  it('gusts are null or greater than wind speed', () => {
    const results = runMany(500);
    for (const { weather } of results) {
      const { speed, gusts } = weather.winds[0];
      if (gusts !== null) {
        expect(gusts).toBeGreaterThan(speed);
      }
    }
  });

  it('altimeter is within realistic range (29.60 – 30.20 inHg)', () => {
    const results = runMany(300);
    for (const { weather } of results) {
      expect(weather.altimeter).toBeGreaterThanOrEqual(29.60);
      expect(weather.altimeter).toBeLessThanOrEqual(30.20);
    }
  });

  it('temperature is within realistic KRIC range (-5 to 32 °C)', () => {
    const results = runMany(300);
    for (const { weather } of results) {
      expect(weather.temperature).toBeGreaterThanOrEqual(-5);
      expect(weather.temperature).toBeLessThanOrEqual(32);
    }
  });

  it('ceiling is either null (clear) or a positive number', () => {
    const results = runMany(500);
    for (const { weather } of results) {
      if (weather.ceiling !== null) {
        expect(weather.ceiling).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Playability clamp ────────────────────────────────────────────────────────

describe('generateRandomWeather — playability clamp', () => {
  it('ceiling is always ≥ ILS_CEILING_FLOOR (250 ft) when set', () => {
    const results = runMany(1000);
    for (const { weather } of results) {
      if (weather.ceiling !== null) {
        expect(weather.ceiling).toBeGreaterThanOrEqual(ILS_CEILING_FLOOR);
      }
    }
  });

  it('visibility is always ≥ ILS_VIS_FLOOR (0.5 SM)', () => {
    const results = runMany(1000);
    for (const { weather } of results) {
      expect(weather.visibility).toBeGreaterThanOrEqual(ILS_VIS_FLOOR);
    }
  });

  it('the clamp applies even when LIFR category is selected', () => {
    // Run enough times that LIFR (8% weight) will almost certainly appear
    const results = runMany(1000);
    const lifrResults = results.filter(r => r.category === 'LIFR');
    for (const { weather } of lifrResults) {
      if (weather.ceiling !== null) {
        expect(weather.ceiling).toBeGreaterThanOrEqual(ILS_CEILING_FLOOR);
      }
      expect(weather.visibility).toBeGreaterThanOrEqual(ILS_VIS_FLOOR);
    }
  });
});

// ─── visualOk flag ────────────────────────────────────────────────────────────

describe('generateRandomWeather — visualOk flag', () => {
  it('visualOk is true when ceiling ≥ 1000 ft and vis ≥ 3 SM', () => {
    const results = runMany(500);
    for (const { weather, visualOk } of results) {
      const effectiveCeiling = weather.ceiling ?? Infinity;
      const shouldBeVisual = effectiveCeiling >= 1000 && weather.visibility >= 3;
      expect(visualOk).toBe(shouldBeVisual);
    }
  });
});

// ─── Category consistency ─────────────────────────────────────────────────────

describe('generateRandomWeather — category / weather consistency', () => {
  it('VMC results have good visibility (≥ 3 SM for visual)', () => {
    const results = runMany(500);
    const vmcResults = results.filter(r => r.category === 'VMC');
    // VMC should always have vis ≥ 6 (pickWeighted gives 6-9 or 10)
    for (const { weather } of vmcResults) {
      expect(weather.visibility).toBeGreaterThanOrEqual(6);
    }
  });

  it('IFR results have ceiling defined (not null)', () => {
    const results = runMany(1000);
    const ifrResults = results.filter(r => r.category === 'IFR');
    for (const { weather } of ifrResults) {
      expect(weather.ceiling).not.toBeNull();
    }
  });

  it('LIFR results have ceiling defined and description matches ceiling/vis values', () => {
    const results = runMany(1000);
    const lifrResults = results.filter(r => r.category === 'LIFR');
    for (const { weather, description } of lifrResults) {
      expect(weather.ceiling).not.toBeNull();
      // Description is refreshed after clamp — should contain ceiling and visibility values
      expect(description).toContain(`ceiling ${weather.ceiling} ft`);
      expect(description).toContain('SM');
    }
  });

  it('generates all four categories across 2000 runs', () => {
    const results = runMany(2000);
    const categories = new Set(results.map(r => r.category));
    expect(categories).toContain('VMC');
    expect(categories).toContain('MVMC');
    expect(categories).toContain('IFR');
    expect(categories).toContain('LIFR');
  });
});

// ─── wxCategoryColor ──────────────────────────────────────────────────────────

describe('wxCategoryColor', () => {
  it('returns a hex color string for each category', () => {
    const hexPattern = /^#[0-9a-fA-F]{6}$/;
    expect(wxCategoryColor('VMC')).toMatch(hexPattern);
    expect(wxCategoryColor('MVMC')).toMatch(hexPattern);
    expect(wxCategoryColor('IFR')).toMatch(hexPattern);
    expect(wxCategoryColor('LIFR')).toMatch(hexPattern);
  });

  it('VMC is green, LIFR is red', () => {
    // Green has high G channel, low R; red has high R, low G
    const vmc = wxCategoryColor('VMC');
    const lifr = wxCategoryColor('LIFR');
    // VMC should be greenish (e.g. #00cc44)
    expect(parseInt(vmc.slice(3, 5), 16)).toBeGreaterThan(100); // G channel
    // LIFR should be reddish (e.g. #ff2222)
    expect(parseInt(lifr.slice(1, 3), 16)).toBeGreaterThan(200); // R channel
  });
});
