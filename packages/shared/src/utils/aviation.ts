/**
 * Aviation utility functions: atmosphere model, speed conversions, wind calculations
 */

/** ISA standard sea level conditions */
const ISA_SEA_LEVEL_TEMP_C = 15.0;
const ISA_SEA_LEVEL_PRESSURE_HPA = 1013.25;
const ISA_LAPSE_RATE_C_PER_FT = 0.0019812; // ~1.98°C per 1000ft up to tropopause
const TROPOPAUSE_FT = 36089;
const SPEED_OF_SOUND_SEA_LEVEL_KTS = 661.47;

/**
 * ISA temperature at altitude (°C)
 */
export function isaTemperature(altitudeFt: number): number {
  if (altitudeFt <= TROPOPAUSE_FT) {
    return ISA_SEA_LEVEL_TEMP_C - altitudeFt * ISA_LAPSE_RATE_C_PER_FT;
  }
  return -56.5; // Constant above tropopause
}

/**
 * Pressure ratio at altitude (ISA)
 */
export function pressureRatio(altitudeFt: number): number {
  if (altitudeFt <= TROPOPAUSE_FT) {
    return Math.pow(1 - altitudeFt * ISA_LAPSE_RATE_C_PER_FT / (ISA_SEA_LEVEL_TEMP_C + 273.15), 5.2559);
  }
  const tropoRatio = Math.pow(1 - TROPOPAUSE_FT * ISA_LAPSE_RATE_C_PER_FT / (ISA_SEA_LEVEL_TEMP_C + 273.15), 5.2559);
  return tropoRatio * Math.exp(-(altitudeFt - TROPOPAUSE_FT) / 20806);
}

/**
 * Density ratio at altitude (ISA)
 */
export function densityRatio(altitudeFt: number): number {
  const tempK = isaTemperature(altitudeFt) + 273.15;
  const seaLevelK = ISA_SEA_LEVEL_TEMP_C + 273.15;
  return pressureRatio(altitudeFt) * (seaLevelK / tempK);
}

/**
 * Convert IAS (Indicated Airspeed) to TAS (True Airspeed) at altitude
 */
export function iasToTas(iasKnots: number, altitudeFt: number): number {
  return iasKnots / Math.sqrt(densityRatio(altitudeFt));
}

/**
 * Convert TAS to IAS at altitude
 */
export function tasToIas(tasKnots: number, altitudeFt: number): number {
  return tasKnots * Math.sqrt(densityRatio(altitudeFt));
}

/**
 * Convert Mach number to TAS at altitude
 */
export function machToTas(mach: number, altitudeFt: number): number {
  const tempK = isaTemperature(altitudeFt) + 273.15;
  const speedOfSound = SPEED_OF_SOUND_SEA_LEVEL_KTS * Math.sqrt(tempK / (ISA_SEA_LEVEL_TEMP_C + 273.15));
  return mach * speedOfSound;
}

/**
 * Convert TAS to Mach number at altitude
 */
export function tasToMach(tasKnots: number, altitudeFt: number): number {
  const tempK = isaTemperature(altitudeFt) + 273.15;
  const speedOfSound = SPEED_OF_SOUND_SEA_LEVEL_KTS * Math.sqrt(tempK / (ISA_SEA_LEVEL_TEMP_C + 273.15));
  return tasKnots / speedOfSound;
}

/**
 * Convert IAS to Mach at altitude
 */
export function iasToMach(iasKnots: number, altitudeFt: number): number {
  return tasToMach(iasToTas(iasKnots, altitudeFt), altitudeFt);
}

/**
 * Convert Mach to IAS at altitude
 */
export function machToIas(mach: number, altitudeFt: number): number {
  return tasToIas(machToTas(mach, altitudeFt), altitudeFt);
}

/**
 * Pressure altitude given field elevation and altimeter setting
 */
export function pressureAltitude(fieldElevation: number, altimeterInHg: number): number {
  const altimeterHpa = altimeterInHg * 33.8639;
  return fieldElevation + (ISA_SEA_LEVEL_PRESSURE_HPA - altimeterHpa) * 30;
}

/**
 * Density altitude given field elevation and temperature
 */
export function densityAltitude(fieldElevation: number, tempC: number, altimeterInHg: number): number {
  const pa = pressureAltitude(fieldElevation, altimeterInHg);
  const isaTemp = isaTemperature(pa);
  return pa + 118.8 * (tempC - isaTemp);
}

/**
 * Calculate wind correction angle (degrees)
 * Returns angle to add to course to track desired course
 */
export function windCorrectionAngle(
  course: number,
  tasKnots: number,
  windDirection: number,
  windSpeedKnots: number
): number {
  if (windSpeedKnots === 0 || tasKnots === 0) return 0;

  const courseRad = (course * Math.PI) / 180;
  const windRad = (windDirection * Math.PI) / 180;

  // Wind is FROM windDirection, so the vector points opposite
  const relativeAngle = windRad - courseRad;
  const sinWCA = (windSpeedKnots / tasKnots) * Math.sin(relativeAngle);

  // Clamp to valid asin range
  return (Math.asin(Math.max(-1, Math.min(1, sinWCA))) * 180) / Math.PI;
}

/**
 * Calculate headwind component (positive = headwind, negative = tailwind)
 */
export function headwindComponent(
  runwayHeading: number,
  windDirection: number,
  windSpeedKnots: number
): number {
  const angle = ((windDirection - runwayHeading) * Math.PI) / 180;
  return windSpeedKnots * Math.cos(angle);
}

/**
 * Calculate crosswind component (positive = from right)
 */
export function crosswindComponent(
  runwayHeading: number,
  windDirection: number,
  windSpeedKnots: number
): number {
  const angle = ((windDirection - runwayHeading) * Math.PI) / 180;
  return windSpeedKnots * Math.sin(angle);
}

/**
 * Calculate groundspeed given TAS, course, and wind
 */
export function calculateGroundspeed(
  course: number,
  tasKnots: number,
  windDirection: number,
  windSpeedKnots: number
): number {
  if (windSpeedKnots === 0) return tasKnots;

  const courseRad = (course * Math.PI) / 180;
  const windRad = (windDirection * Math.PI) / 180;

  // Wind vector (FROM direction, so negate)
  const wx = -windSpeedKnots * Math.sin(windRad);
  const wy = -windSpeedKnots * Math.cos(windRad);

  // Aircraft vector
  const wca = windCorrectionAngle(course, tasKnots, windDirection, windSpeedKnots);
  const headingRad = ((course + wca) * Math.PI) / 180;
  const ax = tasKnots * Math.sin(headingRad);
  const ay = tasKnots * Math.cos(headingRad);

  // Ground vector
  const gx = ax + wx;
  const gy = ay + wy;

  return Math.sqrt(gx * gx + gy * gy);
}

/**
 * Magnetic variation approximate calculation.
 * For KRIC area, ~10°W. This is a simplified model.
 */
export function magneticVariation(lat: number, lon: number): number {
  // Simplified World Magnetic Model approximation for CONUS
  // More accurate: use WMM coefficients or lookup table
  // For the KRIC area (37.5N, 77.3W), variation is approximately -10 (10°W)
  return -10.0 + (lat - 37.5) * 0.2 + (lon + 77.3) * 0.15;
}

/**
 * Convert true heading to magnetic heading
 */
export function trueToMagnetic(trueHeading: number, variation: number): number {
  return ((trueHeading - variation) % 360 + 360) % 360;
}

/**
 * Convert magnetic heading to true heading
 */
export function magneticToTrue(magneticHeading: number, variation: number): number {
  return ((magneticHeading + variation) % 360 + 360) % 360;
}

/**
 * Calculate required descent rate (ft/min) to lose altitude over distance at given groundspeed
 */
export function requiredDescentRate(
  altitudeToLose: number,
  distanceNm: number,
  groundspeedKnots: number
): number {
  if (distanceNm <= 0 || groundspeedKnots <= 0) return 0;
  const timeMinutes = (distanceNm / groundspeedKnots) * 60;
  return altitudeToLose / timeMinutes;
}

/**
 * Standard 3° glideslope: altitude above threshold at distance
 */
export function glideslopeAltitude(
  distanceNm: number,
  thresholdElevation: number,
  glideslopeAngle: number = 3.0
): number {
  const altitudeAboveThreshold = Math.tan((glideslopeAngle * Math.PI) / 180) * distanceNm * 6076.12;
  return thresholdElevation + altitudeAboveThreshold;
}
