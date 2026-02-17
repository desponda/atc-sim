/** Convert knots to meters per second */
export function knotsToMps(knots: number): number {
  return knots * 0.514444;
}

/** Convert meters per second to knots */
export function mpsToKnots(mps: number): number {
  return mps / 0.514444;
}

/** Convert feet to meters */
export function feetToMeters(feet: number): number {
  return feet * 0.3048;
}

/** Convert meters to feet */
export function metersToFeet(meters: number): number {
  return meters / 0.3048;
}

/** Convert nautical miles to kilometers */
export function nmToKm(nm: number): number {
  return nm * 1.852;
}

/** Convert kilometers to nautical miles */
export function kmToNm(km: number): number {
  return km / 1.852;
}

/** Convert nautical miles to feet */
export function nmToFeet(nm: number): number {
  return nm * 6076.12;
}

/** Convert feet to nautical miles */
export function feetToNm(feet: number): number {
  return feet / 6076.12;
}

/** Convert nautical miles to statute miles */
export function nmToSm(nm: number): number {
  return nm * 1.15078;
}

/** Convert statute miles to nautical miles */
export function smToNm(sm: number): number {
  return sm / 1.15078;
}

/** Convert flight level to altitude in feet (FL350 = 35000ft) */
export function flightLevelToAltitude(fl: number): number {
  return fl * 100;
}

/** Convert altitude in feet to flight level */
export function altitudeToFlightLevel(altitude: number): number {
  return Math.round(altitude / 100);
}

/** Convert knots to nautical miles per second */
export function knotsToNmPerSecond(knots: number): number {
  return knots / 3600;
}

/** Convert feet per minute to feet per second */
export function fpmToFps(fpm: number): number {
  return fpm / 60;
}

/** Convert feet per second to feet per minute */
export function fpsToFpm(fps: number): number {
  return fps * 60;
}

/**
 * Format altitude for display
 * Below 18,000: "5,000" / Above 18,000: "FL350"
 */
export function formatAltitude(feet: number): string {
  if (feet >= 18000) {
    return `FL${Math.round(feet / 100)}`;
  }
  return feet.toLocaleString();
}

/**
 * Format altitude for data block (hundreds of feet, 3 digits)
 * e.g., 5000 → "050", 35000 → "350"
 */
export function formatAltitudeDataBlock(feet: number): string {
  return String(Math.round(feet / 100)).padStart(3, '0');
}

/**
 * Format speed for data block (tens of knots, 3 digits)
 * e.g., 250 → "25", 180 → "18"
 */
export function formatSpeedDataBlock(knots: number): string {
  return String(Math.round(knots / 10)).padStart(2, '0');
}

/**
 * Format heading as three digits
 * e.g., 5 → "005", 90 → "090", 270 → "270"
 */
export function formatHeading(degrees: number): string {
  return String(Math.round(degrees) % 360 || 360).padStart(3, '0');
}

/**
 * Format frequency for display
 * e.g., 119.05 → "119.05", 121.9 → "121.90"
 */
export function formatFrequency(freq: number): string {
  return freq.toFixed(freq % 1 === 0 ? 2 : String(freq).split('.')[1].length < 2 ? 2 : String(freq).split('.')[1].length);
}
