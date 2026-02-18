/**
 * Landing Debug Test
 *
 * Simulates the EXACT tick loop from SimulationEngine to reproduce
 * the issue where aircraft never transition to "landed" phase.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AircraftState, Runway, AirportData, WeatherState, Position } from '@atc-sim/shared';
import {
  glideslopeAltitude,
  haversineDistance,
  destinationPoint,
  normalizeHeading,
  crossTrackDistance,
  initialBearing,
  headingDifference,
} from '@atc-sim/shared';
import { PhysicsEngine } from '../engine/PhysicsEngine.js';
import { FlightPlanExecutor } from '../ai/FlightPlanExecutor.js';
import { performanceDB } from '../data/PerformanceDB.js';

const RWY_ELEVATION = 167;
const RWY_HEADING = 157;
const ILS_COURSE = 157;
const GS_ANGLE = 3.0;
const THRESHOLD: Position = { lat: 37.516636, lon: -77.323578 };
const RECIPROCAL = normalizeHeading(ILS_COURSE + 180);

const RWY16: Runway = {
  id: '16',
  heading: RWY_HEADING,
  threshold: THRESHOLD,
  end: destinationPoint(THRESHOLD, RWY_HEADING, 9120 / 6076.12),
  length: 9120,
  width: 150,
  elevation: RWY_ELEVATION,
  ilsAvailable: true,
  ilsFrequency: 111.3,
  ilsCourse: ILS_COURSE,
  glideslopeAngle: GS_ANGLE,
};

const LIGHT_WIND: WeatherState = {
  winds: [{ altitude: 0, direction: 160, speed: 5, gusts: null }],
  altimeter: 29.92,
  temperature: 15,
  visibility: 10,
  ceiling: null,
  atisLetter: 'A',
};

function minimalAirportData(): AirportData {
  return {
    icao: 'KRIC',
    name: 'Richmond International',
    position: { lat: 37.5052, lon: -77.3197 },
    elevation: RWY_ELEVATION,
    runways: [RWY16],
    fixes: [],
    navaids: [],
    approaches: [],
    stars: [],
    sids: [],
    airspace: [],
    magneticVariation: -10,
    frequencies: {
      atis: 127.15,
      approach: [124.0],
      tower: [118.3],
      ground: [121.9],
      departure: [124.0],
      center: [132.35],
    },
  } as AirportData;
}

function makeAircraft(overrides: Partial<AircraftState> & { position: Position; altitude: number }): AircraftState {
  const defaults: AircraftState = {
    id: 'test-1',
    callsign: 'DAL104',
    typeDesignator: 'B738',
    wakeCategory: 'LARGE',
    position: overrides.position,
    altitude: overrides.altitude,
    heading: ILS_COURSE,
    speed: 180,
    groundspeed: 180,
    verticalSpeed: 0,
    onGround: false,
    flightPhase: 'approach',
    transponder: 'modeC',
    flightPlan: {
      departure: 'KJFK',
      arrival: 'KRIC',
      cruiseAltitude: 35000,
      route: [],
      sid: null,
      star: 'DUCXS5',
      runway: '16',
      squawk: '1234',
    },
    clearances: {
      altitude: null,
      heading: null,
      speed: null,
      turnDirection: null,
      approach: { type: 'ILS', runway: '16' },
      holdFix: null,
      directFix: null,
      procedure: null,
      climbViaSID: false,
      descendViaSTAR: false,
      expectedApproach: null,
      maintainUntilEstablished: null,
      handoffFrequency: null,
      handoffFacility: null,
    },
    currentFixIndex: 0,
    onLocalizer: false,
    onGlideslope: false,
    handingOff: false,
    category: 'arrival',
    historyTrail: [],
    targetAltitude: overrides.altitude,
    targetHeading: ILS_COURSE,
    targetSpeed: 180,
    bankAngle: 0,
  };
  return { ...defaults, ...overrides };
}

function aircraftOnCenterline(distNm: number, altitude: number, extra?: Partial<AircraftState>): AircraftState {
  const pos = destinationPoint(THRESHOLD, RECIPROCAL, distNm);
  return makeAircraft({ position: pos, altitude, heading: ILS_COURSE, targetHeading: ILS_COURSE, ...extra });
}

describe('Landing debug - tracing full pipeline', () => {
  let executor: FlightPlanExecutor;
  let physics: PhysicsEngine;

  beforeEach(() => {
    executor = new FlightPlanExecutor();
    executor.setAirportData(minimalAirportData());
    physics = new PhysicsEngine();
  });

  it('traces tick-by-tick descent and landing from 5nm', () => {
    // Start at 5nm, at glideslope altitude, already established
    const gsAlt5 = glideslopeAltitude(5, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(5, gsAlt5, {
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
      speed: 160,
      groundspeed: 160,
      targetSpeed: 160,
    });

    const log: string[] = [];
    let landed = false;
    const MAX_TICKS = 300;

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      const dist = haversineDistance(ac.position, THRESHOLD);
      const gsAlt = glideslopeAltitude(dist, RWY_ELEVATION, GS_ANGLE);

      // Log every tick near the threshold
      if (dist < 1.5 || tick % 20 === 0) {
        log.push(
          `T${tick}: dist=${dist.toFixed(3)}nm alt=${ac.altitude.toFixed(1)} tgtAlt=${ac.targetAltitude.toFixed(1)} ` +
          `gsAlt=${gsAlt.toFixed(1)} dev=${(ac.altitude - gsAlt).toFixed(1)} VS=${ac.verticalSpeed.toFixed(0)} ` +
          `spd=${ac.speed.toFixed(0)} gs=${ac.groundspeed.toFixed(0)} phase=${ac.flightPhase} ` +
          `onLoc=${ac.onLocalizer} onGS=${ac.onGlideslope} onGround=${ac.onGround}`
        );
      }

      // Simulate the exact SimulationEngine tick order:
      // 1. FlightPlanExecutor (via PilotAI)
      if (ac.flightPhase !== 'landed' && !ac.onGround) {
        executor.execute(ac);
      }

      // 2. PhysicsEngine
      if (ac.flightPhase === 'landed' && ac.onGround) {
        physics.updateGroundRollout(ac, 1);
      } else if (!ac.onGround) {
        physics.updateAircraft(ac, LIGHT_WIND, 1);
      }

      if (ac.flightPhase === 'landed') {
        landed = true;
        log.push(`LANDED at tick ${tick}!`);
        break;
      }

      if (ac.flightPhase === 'missed') {
        log.push(`MISSED APPROACH at tick ${tick}!`);
        break;
      }

      // Check for aircraft going past the threshold
      if (dist < 0.01) {
        log.push(`WARNING: Aircraft at threshold! dist=${dist.toFixed(4)} alt=${ac.altitude.toFixed(0)} phase=${ac.flightPhase}`);
      }
    }

    // Print log for debugging
    console.log('\n=== Landing Trace ===');
    for (const line of log) {
      console.log(line);
    }
    console.log('=== End Trace ===\n');

    expect(landed).toBe(true);
  });

  it('traces tick-by-tick with aircraft slightly offset from centerline', () => {
    // More realistic: aircraft 0.3nm east of centerline
    const centerPos = destinationPoint(THRESHOLD, RECIPROCAL, 8);
    const offsetPos = destinationPoint(centerPos, 90, 0.3);
    const gsAlt = glideslopeAltitude(8, RWY_ELEVATION, GS_ANGLE);

    const ac = makeAircraft({
      position: offsetPos,
      altitude: gsAlt + 100, // Slightly above GS
      heading: ILS_COURSE,
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
      speed: 180,
      groundspeed: 180,
      targetSpeed: 180,
    });

    let landed = false;
    let missedApproach = false;
    const MAX_TICKS = 400;

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      if (ac.flightPhase !== 'landed' && !ac.onGround) {
        executor.execute(ac);
      }
      if (ac.flightPhase === 'landed' && ac.onGround) {
        physics.updateGroundRollout(ac, 1);
      } else if (!ac.onGround) {
        physics.updateAircraft(ac, LIGHT_WIND, 1);
      }

      if (ac.flightPhase === 'landed') { landed = true; break; }
      if (ac.flightPhase === 'missed') { missedApproach = true; break; }
    }

    if (missedApproach) {
      console.log('Aircraft went missed approach - something triggered instability check');
    }

    expect(landed).toBe(true);
  });

  it('traces the EXACT scenario: aircraft starts at 10nm, 3000ft, needs loc+gs capture', () => {
    // This is the scenario from the playtest
    const ac = aircraftOnCenterline(10, 3000, {
      speed: 220,
      groundspeed: 220,
      targetSpeed: 220,
    });

    let capturedLoc = false;
    let capturedGS = false;
    let landed = false;
    let missedApproach = false;
    let minDist = 999;
    let altAtMinDist = 0;
    const MAX_TICKS = 500;
    const log: string[] = [];

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      const dist = haversineDistance(ac.position, THRESHOLD);
      if (dist < minDist) {
        minDist = dist;
        altAtMinDist = ac.altitude;
      }

      // Log critical moments
      if (tick % 30 === 0 || dist < 2 || (ac.onLocalizer && !capturedLoc) || (ac.onGlideslope && !capturedGS)) {
        const gsAlt = glideslopeAltitude(dist, RWY_ELEVATION, GS_ANGLE);
        log.push(
          `T${tick}: dist=${dist.toFixed(2)}nm alt=${ac.altitude.toFixed(0)} tgtAlt=${ac.targetAltitude.toFixed(0)} ` +
          `gsAlt=${gsAlt.toFixed(0)} VS=${ac.verticalSpeed.toFixed(0)} spd=${ac.speed.toFixed(0)} ` +
          `phase=${ac.flightPhase} loc=${ac.onLocalizer} gs=${ac.onGlideslope} clr.approach=${ac.clearances.approach?.type ?? 'none'}`
        );
      }

      if (ac.onLocalizer && !capturedLoc) {
        capturedLoc = true;
        log.push(`>>> LOCALIZER CAPTURED at tick ${tick}, dist=${dist.toFixed(2)}nm`);
      }
      if (ac.onGlideslope && !capturedGS) {
        capturedGS = true;
        log.push(`>>> GLIDESLOPE CAPTURED at tick ${tick}, dist=${dist.toFixed(2)}nm`);
      }

      // Simulate tick
      if (ac.flightPhase !== 'landed' && !ac.onGround) {
        executor.execute(ac);
      }
      if (ac.flightPhase === 'landed' && ac.onGround) {
        physics.updateGroundRollout(ac, 1);
      } else if (!ac.onGround) {
        physics.updateAircraft(ac, LIGHT_WIND, 1);
      }

      if (ac.flightPhase === 'landed') {
        landed = true;
        log.push(`>>> LANDED at tick ${tick}, dist=${minDist.toFixed(3)}nm, alt=${altAtMinDist.toFixed(0)}`);
        break;
      }
      if (ac.flightPhase === 'missed') {
        missedApproach = true;
        log.push(`>>> MISSED APPROACH at tick ${tick}`);
        break;
      }
    }

    console.log('\n=== Full Pipeline Trace ===');
    for (const line of log) {
      console.log(line);
    }
    console.log(`minDist=${minDist.toFixed(3)}nm, altAtMinDist=${altAtMinDist.toFixed(0)}`);
    console.log('=== End Trace ===\n');

    expect(capturedLoc).toBe(true);
    expect(capturedGS).toBe(true);
    expect(landed).toBe(true);
  });
});
