import type { Position } from '../types/aircraft.js';

const EARTH_RADIUS_NM = 3440.065;
const EARTH_RADIUS_KM = 6371.0;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Convert degrees to radians */
export function toRadians(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

/** Convert radians to degrees */
export function toDegrees(radians: number): number {
  return radians * RAD_TO_DEG;
}

/**
 * Haversine distance between two positions in nautical miles
 */
export function haversineDistance(a: Position, b: Position): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_NM * c;
}

/**
 * Initial bearing from position A to position B (degrees true, 0-360)
 */
export function initialBearing(from: Position, to: Position): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLon = toRadians(to.lon - from.lon);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Destination point given start, bearing (degrees true), and distance (nm)
 */
export function destinationPoint(
  start: Position,
  bearingDeg: number,
  distanceNm: number
): Position {
  const lat1 = toRadians(start.lat);
  const lon1 = toRadians(start.lon);
  const bearing = toRadians(bearingDeg);
  const angularDist = distanceNm / EARTH_RADIUS_NM;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDist) +
      Math.cos(lat1) * Math.sin(angularDist) * Math.cos(bearing)
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDist) * Math.cos(lat1),
      Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: toDegrees(lat2),
    lon: ((toDegrees(lon2) + 540) % 360) - 180, // Normalize to [-180, 180]
  };
}

/**
 * Cross-track distance from point to great circle path (nm).
 * Positive = right of path, negative = left.
 */
export function crossTrackDistance(
  point: Position,
  pathStart: Position,
  pathEnd: Position
): number {
  const d13 = haversineDistance(pathStart, point) / EARTH_RADIUS_NM;
  const brng13 = toRadians(initialBearing(pathStart, point));
  const brng12 = toRadians(initialBearing(pathStart, pathEnd));

  return (
    Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12)) * EARTH_RADIUS_NM
  );
}

/**
 * Stereographic projection: lat/lon → screen coordinates
 * Returns coordinates in nautical miles from center
 */
export function stereographicProject(
  position: Position,
  center: Position
): { x: number; y: number } {
  const lat = toRadians(position.lat);
  const lon = toRadians(position.lon);
  const lat0 = toRadians(center.lat);
  const lon0 = toRadians(center.lon);

  const cosLat = Math.cos(lat);
  const sinLat = Math.sin(lat);
  const cosLat0 = Math.cos(lat0);
  const sinLat0 = Math.sin(lat0);
  const dLon = lon - lon0;
  const cosDLon = Math.cos(dLon);

  const k =
    (2 * EARTH_RADIUS_NM) /
    (1 + sinLat0 * sinLat + cosLat0 * cosLat * cosDLon);

  const x = k * cosLat * Math.sin(dLon);
  const y = k * (cosLat0 * sinLat - sinLat0 * cosLat * cosDLon);

  return { x, y };
}

/**
 * Inverse stereographic projection: screen x/y (nm from center) → lat/lon
 */
export function stereographicUnproject(
  point: { x: number; y: number },
  center: Position
): Position {
  const lat0 = toRadians(center.lat);
  const lon0 = toRadians(center.lon);
  const R = EARTH_RADIUS_NM;

  const rho = Math.sqrt(point.x * point.x + point.y * point.y);
  if (rho < 1e-10) return { ...center };

  const c = 2 * Math.atan2(rho, 2 * R);
  const cosC = Math.cos(c);
  const sinC = Math.sin(c);
  const cosLat0 = Math.cos(lat0);
  const sinLat0 = Math.sin(lat0);

  const lat = Math.asin(cosC * sinLat0 + (point.y * sinC * cosLat0) / rho);
  const lon =
    lon0 +
    Math.atan2(
      point.x * sinC,
      rho * cosLat0 * cosC - point.y * sinLat0 * sinC
    );

  return {
    lat: toDegrees(lat),
    lon: ((toDegrees(lon) + 540) % 360) - 180,
  };
}

/**
 * Normalize heading to 0-360 range
 */
export function normalizeHeading(heading: number): number {
  return ((heading % 360) + 360) % 360;
}

/**
 * Shortest turn direction from current heading to target heading
 * Returns positive for right turn, negative for left turn
 */
export function headingDifference(from: number, to: number): number {
  const diff = normalizeHeading(to) - normalizeHeading(from);
  if (diff > 180) return diff - 360;
  if (diff < -180) return diff + 360;
  return diff;
}

/**
 * Check if a point is inside a polygon (ray casting)
 */
export function pointInPolygon(point: Position, polygon: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;

    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }
  return inside;
}
