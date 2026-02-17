import type {
  AircraftState,
  AircraftPerformance,
  WeatherState,
  WindLayer,
  Position,
} from '@atc-sim/shared';
import {
  iasToTas,
  destinationPoint,
  haversineDistance,
  initialBearing,
  headingDifference,
  normalizeHeading,
  knotsToNmPerSecond,
  fpmToFps,
  glideslopeAltitude,
} from '@atc-sim/shared';
import { performanceDB } from '../data/PerformanceDB.js';

/** One physics tick duration (seconds) */
const TICK_SECONDS = 1;

/** Maximum history trail length */
const MAX_HISTORY = 60;

/**
 * PhysicsEngine handles per-tick movement of all aircraft.
 * Heading changes use bank angle / standard rate turn.
 * Altitude changes use performance-based climb/descent rates.
 * Speed changes apply acceleration / deceleration.
 * Wind effects modify ground track and groundspeed.
 */
export class PhysicsEngine {
  /**
   * Update a single aircraft for one tick.
   * Mutates the aircraft state in-place and returns it.
   */
  updateAircraft(
    ac: AircraftState,
    weather: WeatherState,
    dt: number = TICK_SECONDS
  ): void {
    const perf = performanceDB.getOrDefault(ac.typeDesignator);

    // 1. Update heading toward target
    this.updateHeading(ac, perf, dt);

    // 2. Update altitude toward target
    this.updateAltitude(ac, perf, dt);

    // 3. Update speed toward target (with 250kt below 10000 enforcement)
    this.updateSpeed(ac, perf, dt);

    // 4. Calculate TAS and groundspeed with wind
    const wind = this.getWindAtAltitude(weather, ac.altitude);
    const tas = iasToTas(ac.speed, ac.altitude);
    ac.groundspeed = this.calculateGroundspeed(ac.heading, tas, wind);

    // 5. Move aircraft position
    this.updatePosition(ac, wind, tas, dt);

    // 6. Update history trail
    this.updateHistory(ac);
  }

  private updateHeading(
    ac: AircraftState,
    perf: AircraftPerformance,
    dt: number
  ): void {
    const diff = headingDifference(ac.heading, ac.targetHeading);
    if (Math.abs(diff) < 0.5) {
      ac.heading = ac.targetHeading;
      // Roll out smoothly rather than snapping bank to 0
      if (Math.abs(ac.bankAngle) > 0.5) {
        const rollOutRate = 5; // deg/sec
        const bankChange = Math.min(Math.abs(ac.bankAngle), rollOutRate * dt);
        ac.bankAngle -= Math.sign(ac.bankAngle) * bankChange;
      } else {
        ac.bankAngle = 0;
      }
      return;
    }

    // Determine turn direction
    let turnDir: number; // +1 right, -1 left
    if (ac.clearances.turnDirection === 'right') {
      turnDir = 1;
    } else if (ac.clearances.turnDirection === 'left') {
      turnDir = -1;
    } else {
      turnDir = diff > 0 ? 1 : -1;
    }

    // Standard rate turn: 3 deg/sec, with bank angle
    const turnRate = perf.turn.standardRate; // deg/sec
    const targetBank = turnDir * Math.min(perf.turn.maxBank, 25); // degrees

    // Begin roll-out anticipation: reduce bank when within 10 deg of target heading
    const rollOutAnticipation = 10;
    let effectiveTargetBank = targetBank;
    if (Math.abs(diff) < rollOutAnticipation) {
      // Linearly reduce target bank as we approach the target heading
      effectiveTargetBank = targetBank * (Math.abs(diff) / rollOutAnticipation);
    }

    // Smoothly roll to target bank (realistic roll rate)
    const bankRate = 5; // deg/sec roll rate
    const bankDiff = effectiveTargetBank - ac.bankAngle;
    if (Math.abs(bankDiff) > bankRate * dt) {
      ac.bankAngle += Math.sign(bankDiff) * bankRate * dt;
    } else {
      ac.bankAngle = effectiveTargetBank;
    }

    // Turn rate proportional to actual bank angle (not just max rate)
    const actualTurnRate = (Math.abs(ac.bankAngle) / Math.abs(targetBank || 25)) * turnRate;
    const maxChange = actualTurnRate * dt;
    const change = Math.min(Math.abs(diff), maxChange) * turnDir;
    ac.heading = normalizeHeading(ac.heading + change);

    // If we've passed the target, snap to it
    const newDiff = headingDifference(ac.heading, ac.targetHeading);
    if (Math.abs(newDiff) < 1 || Math.sign(newDiff) !== Math.sign(diff)) {
      ac.heading = normalizeHeading(ac.targetHeading);
      ac.bankAngle = 0;
    }
  }

  private updateAltitude(
    ac: AircraftState,
    perf: AircraftPerformance,
    dt: number
  ): void {
    const diff = ac.targetAltitude - ac.altitude;

    // On glideslope: use proportional correction to converge onto the GS path.
    // The nominal VS matches the geometric glideslope descent rate; if the
    // aircraft is above or below the target GS altitude, a correction term
    // steepens or shallows the descent so the aircraft converges smoothly.
    if (ac.onGlideslope) {
      const gsAngle = 3.0; // degrees
      const nominalVS =
        (ac.groundspeed / 60) * 6076.12 * Math.tan((gsAngle * Math.PI) / 180);
      // deviation > 0 → above GS → descend faster; < 0 → below → descend slower
      const deviation = ac.altitude - ac.targetAltitude;
      // 3 fpm per foot of deviation gives ~20s half-life convergence
      const correctionFpm = deviation * 3;
      const targetVS = -(nominalVS + correctionFpm);

      // Smoothly transition vertical speed
      const vsAccel = 500; // ft/min per second
      const vsDiff = targetVS - ac.verticalSpeed;
      if (Math.abs(vsDiff) > vsAccel * dt) {
        ac.verticalSpeed += Math.sign(vsDiff) * vsAccel * dt;
      } else {
        ac.verticalSpeed = targetVS;
      }

      // Apply altitude change
      ac.altitude += fpmToFps(ac.verticalSpeed) * dt;

      // Don't descend below runway elevation
      if (ac.altitude < ac.targetAltitude) {
        ac.altitude = ac.targetAltitude;
      }
      return;
    }

    // Normal (non-glideslope) altitude handling
    if (Math.abs(diff) < 10) {
      ac.altitude = ac.targetAltitude;
      ac.verticalSpeed = 0;
      return;
    }

    let targetVS: number;
    if (diff > 0) {
      // Climbing
      targetVS = this.getClimbRate(perf, ac.altitude);
    } else {
      // Descending
      targetVS = -perf.descent.standardRate;
    }

    // Smoothly transition vertical speed
    const vsAccel = 500; // ft/min per second
    const vsDiff = targetVS - ac.verticalSpeed;
    if (Math.abs(vsDiff) > vsAccel * dt) {
      ac.verticalSpeed += Math.sign(vsDiff) * vsAccel * dt;
    } else {
      ac.verticalSpeed = targetVS;
    }

    // Apply altitude change
    const altChange = fpmToFps(ac.verticalSpeed) * dt;
    ac.altitude += altChange;

    // Clamp to target
    if (
      (diff > 0 && ac.altitude >= ac.targetAltitude) ||
      (diff < 0 && ac.altitude <= ac.targetAltitude)
    ) {
      ac.altitude = ac.targetAltitude;
      ac.verticalSpeed = 0;
    }
  }

  private getClimbRate(perf: AircraftPerformance, altitude: number): number {
    if (altitude < 10000) {
      // Interpolate between initial and 10k rate
      const frac = altitude / 10000;
      return perf.climb.initialRate * (1 - frac) + perf.climb.rateAt10k * frac;
    } else if (altitude < 24000) {
      const frac = (altitude - 10000) / 14000;
      return perf.climb.rateAt10k * (1 - frac) + perf.climb.rateAt24k * frac;
    } else {
      const frac = Math.min(1, (altitude - 24000) / 11000);
      return perf.climb.rateAt24k * (1 - frac) + perf.climb.rateAt35k * frac;
    }
  }

  private updateSpeed(
    ac: AircraftState,
    perf: AircraftPerformance,
    dt: number
  ): void {
    // Enforce 250kt below 10000ft
    let effectiveTarget = ac.targetSpeed;
    if (ac.altitude < 10000 && effectiveTarget > perf.speed.vmaxBelow10k) {
      effectiveTarget = perf.speed.vmaxBelow10k;
    }

    const diff = effectiveTarget - ac.speed;
    if (Math.abs(diff) < 2) {
      ac.speed = effectiveTarget;
      return;
    }

    // Acceleration/deceleration rate: ~2 kts/sec for jets (realistic: 30-60s for 70kt change)
    const accelRate = diff > 0 ? 2 : -1.5;
    const change = accelRate * dt;

    if (Math.abs(change) > Math.abs(diff)) {
      ac.speed = effectiveTarget;
    } else {
      ac.speed += change;
    }

    // Clamp to min/max
    ac.speed = Math.max(perf.speed.vminFlaps, Math.min(ac.speed, perf.speed.vmo));
  }

  private getWindAtAltitude(
    weather: WeatherState,
    altitude: number
  ): { direction: number; speed: number } {
    const winds = weather.winds;
    if (winds.length === 0) return { direction: 0, speed: 0 };
    if (winds.length === 1) return { direction: winds[0].direction, speed: winds[0].speed };

    // Find bracketing layers and interpolate
    let below: WindLayer | null = null;
    let above: WindLayer | null = null;

    for (const layer of winds) {
      if (layer.altitude <= altitude) {
        if (!below || layer.altitude > below.altitude) below = layer;
      }
      if (layer.altitude >= altitude) {
        if (!above || layer.altitude < above.altitude) above = layer;
      }
    }

    if (!below) return above ? { direction: above.direction, speed: above.speed } : { direction: 0, speed: 0 };
    if (!above) return { direction: below.direction, speed: below.speed };
    if (below.altitude === above.altitude) return { direction: below.direction, speed: below.speed };

    const frac = (altitude - below.altitude) / (above.altitude - below.altitude);
    // Interpolate wind speed linearly
    const speed = below.speed + (above.speed - below.speed) * frac;
    // Interpolate direction (handle wrapping)
    const dirDiff = headingDifference(below.direction, above.direction);
    const direction = normalizeHeading(below.direction + dirDiff * frac);

    return { direction, speed };
  }

  private calculateGroundspeed(
    heading: number,
    tasKnots: number,
    wind: { direction: number; speed: number }
  ): number {
    if (wind.speed === 0) return tasKnots;

    const hdgRad = (heading * Math.PI) / 180;
    const windRad = (wind.direction * Math.PI) / 180;

    // Wind vector (FROM direction → negate)
    const wx = -wind.speed * Math.sin(windRad);
    const wy = -wind.speed * Math.cos(windRad);

    // Aircraft TAS vector
    const ax = tasKnots * Math.sin(hdgRad);
    const ay = tasKnots * Math.cos(hdgRad);

    const gx = ax + wx;
    const gy = ay + wy;

    return Math.sqrt(gx * gx + gy * gy);
  }

  private updatePosition(
    ac: AircraftState,
    wind: { direction: number; speed: number },
    tasKnots: number,
    dt: number
  ): void {
    // Calculate ground track including wind
    const hdgRad = (ac.heading * Math.PI) / 180;
    const windRad = (wind.direction * Math.PI) / 180;

    // TAS vector
    const ax = tasKnots * Math.sin(hdgRad);
    const ay = tasKnots * Math.cos(hdgRad);

    // Wind vector
    const wx = -wind.speed * Math.sin(windRad);
    const wy = -wind.speed * Math.cos(windRad);

    // Ground vector
    const gx = ax + wx;
    const gy = ay + wy;
    const gs = Math.sqrt(gx * gx + gy * gy);

    if (gs < 1) return; // essentially stationary

    // Ground track bearing
    const track = (Math.atan2(gx, gy) * 180) / Math.PI;
    const distanceNm = knotsToNmPerSecond(gs) * dt;

    ac.position = destinationPoint(ac.position, track, distanceNm);
  }

  private updateHistory(ac: AircraftState): void {
    ac.historyTrail.unshift({ lat: ac.position.lat, lon: ac.position.lon });
    if (ac.historyTrail.length > MAX_HISTORY) {
      ac.historyTrail.length = MAX_HISTORY;
    }
  }
}
