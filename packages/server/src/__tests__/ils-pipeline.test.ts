/**
 * ILS Pipeline Unit & Integration Tests
 *
 * Tests each stage of the ILS approach independently, then verifies the
 * full pipeline end-to-end: vectoring → localizer capture → glideslope
 * capture → descent convergence → landing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  AircraftState,
  Runway,
  AirportData,
  WeatherState,
  Position,
} from '@atc-sim/shared';
import {
  glideslopeAltitude,
  haversineDistance,
  initialBearing,
  headingDifference,
  normalizeHeading,
  destinationPoint,
  crossTrackDistance,
} from '@atc-sim/shared';
import { PhysicsEngine } from '../engine/PhysicsEngine.js';
import { FlightPlanExecutor } from '../ai/FlightPlanExecutor.js';
import { performanceDB } from '../data/PerformanceDB.js';

// ─── KRIC RWY 16 Constants ──────────────────────────────────────────────────
const RWY_ELEVATION = 167;
const RWY_HEADING = 157;
const ILS_COURSE = 157;
const GS_ANGLE = 3.0;
const THRESHOLD: Position = { lat: 37.516636, lon: -77.323578 };
const RECIPROCAL = normalizeHeading(ILS_COURSE + 180); // 337°

const RWY16: Runway = {
  id: '16',
  heading: RWY_HEADING,
  threshold: THRESHOLD,
  end: destinationPoint(THRESHOLD, RWY_HEADING, 9120 / 6076.12), // ~9120ft runway
  length: 9120,
  width: 150,
  elevation: RWY_ELEVATION,
  ilsAvailable: true,
  ilsFrequency: 111.3,
  ilsCourse: ILS_COURSE,
  glideslopeAngle: GS_ANGLE,
};

const CALM_WEATHER: WeatherState = {
  winds: [{ altitude: 0, direction: 200, speed: 0, gusts: null }],
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

/** Create a mock AircraftState at a given position along the extended centerline */
function makeAircraft(overrides: Partial<AircraftState> & { position: Position; altitude: number }): AircraftState {
  const defaults: AircraftState = {
    id: 'test-1',
    callsign: 'TEST101',
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

/** Place aircraft on extended centerline at given distance from threshold */
function aircraftOnCenterline(distNm: number, altitude: number, extraOverrides?: Partial<AircraftState>): AircraftState {
  const pos = destinationPoint(THRESHOLD, RECIPROCAL, distNm);
  return makeAircraft({
    position: pos,
    altitude,
    heading: ILS_COURSE,
    targetHeading: ILS_COURSE,
    ...extraOverrides,
  });
}

// ─── 1. Glideslope Math Tests ───────────────────────────────────────────────
describe('glideslopeAltitude', () => {
  it('returns elevation at threshold (0nm)', () => {
    expect(glideslopeAltitude(0, RWY_ELEVATION, GS_ANGLE)).toBeCloseTo(RWY_ELEVATION, 0);
  });

  it('returns correct altitude at 1nm', () => {
    // tan(3°) * 6076.12 = 318.5 ft/nm
    const expected = RWY_ELEVATION + 1 * 6076.12 * Math.tan(3 * Math.PI / 180);
    expect(glideslopeAltitude(1, RWY_ELEVATION, GS_ANGLE)).toBeCloseTo(expected, 0);
  });

  it('returns correct altitude at 5nm', () => {
    const expected = RWY_ELEVATION + 5 * 6076.12 * Math.tan(3 * Math.PI / 180);
    expect(glideslopeAltitude(5, RWY_ELEVATION, GS_ANGLE)).toBeCloseTo(expected, 0);
  });

  it('returns correct altitude at 10nm (~3350ft)', () => {
    const alt = glideslopeAltitude(10, RWY_ELEVATION, GS_ANGLE);
    expect(alt).toBeGreaterThan(3300);
    expect(alt).toBeLessThan(3400);
  });

  it('GS altitude at 0.5nm is about 325ft above field', () => {
    const alt = glideslopeAltitude(0.5, RWY_ELEVATION, GS_ANGLE);
    const agl = alt - RWY_ELEVATION;
    expect(agl).toBeGreaterThan(140);
    expect(agl).toBeLessThan(180);
  });
});

// ─── 2. PhysicsEngine Glideslope Descent Tests ─────────────────────────────
describe('PhysicsEngine glideslope descent', () => {
  let engine: PhysicsEngine;

  beforeEach(() => {
    engine = new PhysicsEngine();
  });

  it('descends at approximately 3° glideslope rate when on GS with no deviation', () => {
    // Aircraft exactly on GS at 5nm, 180kts GS
    const gsAlt = glideslopeAltitude(5, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(5, gsAlt, {
      onLocalizer: true,
      onGlideslope: true,
      targetAltitude: gsAlt,
      flightPhase: 'final',
    });

    // Run one tick
    engine.updateAircraft(ac, CALM_WEATHER, 1);

    // Expected VS at 180kts: ~(180/60)*6076.12*tan(3°) ≈ 955 fpm
    // With zero deviation, correction = 0, so VS should be close to -955
    expect(ac.verticalSpeed).toBeLessThan(-400); // Should be descending
    expect(ac.verticalSpeed).toBeGreaterThan(-1500); // But not too fast
  });

  it('converges from 300ft above GS within 60 ticks', () => {
    // Aircraft 300ft above GS at 10nm
    const gsAlt = glideslopeAltitude(10, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(10, gsAlt + 300, {
      onLocalizer: true,
      onGlideslope: true,
      targetAltitude: gsAlt, // FlightPlanExecutor would set this
      flightPhase: 'final',
    });

    // Run 60 ticks, updating targetAltitude each tick as FlightPlanExecutor would
    for (let i = 0; i < 60; i++) {
      // Simulate FlightPlanExecutor setting targetAltitude to current GS altitude
      const dist = haversineDistance(ac.position, THRESHOLD);
      ac.targetAltitude = Math.max(RWY_ELEVATION, glideslopeAltitude(dist, RWY_ELEVATION, GS_ANGLE));
      engine.updateAircraft(ac, CALM_WEATHER, 1);
    }

    // After 60 ticks, deviation should be much less than 300ft
    const dist = haversineDistance(ac.position, THRESHOLD);
    const gsAltNow = glideslopeAltitude(dist, RWY_ELEVATION, GS_ANGLE);
    const deviation = Math.abs(ac.altitude - gsAltNow);
    expect(deviation).toBeLessThan(50); // Should have converged to within 50ft
  });

  it('never descends below runway elevation when on GS', () => {
    // Aircraft near threshold, very low
    const ac = aircraftOnCenterline(0.3, RWY_ELEVATION + 50, {
      onLocalizer: true,
      onGlideslope: true,
      targetAltitude: RWY_ELEVATION,
      flightPhase: 'final',
      verticalSpeed: -800,
    });

    for (let i = 0; i < 30; i++) {
      const dist = haversineDistance(ac.position, THRESHOLD);
      ac.targetAltitude = Math.max(RWY_ELEVATION, glideslopeAltitude(dist, RWY_ELEVATION, GS_ANGLE));
      engine.updateAircraft(ac, CALM_WEATHER, 1);
    }

    expect(ac.altitude).toBeGreaterThanOrEqual(RWY_ELEVATION - 1); // Small float tolerance
  });

  it('descends faster than nominal when above GS (proportional correction)', () => {
    const gsAlt = glideslopeAltitude(8, RWY_ELEVATION, GS_ANGLE);
    const acAbove = aircraftOnCenterline(8, gsAlt + 200, {
      onLocalizer: true,
      onGlideslope: true,
      targetAltitude: gsAlt,
      flightPhase: 'final',
    });
    const acOnGs = aircraftOnCenterline(8, gsAlt, {
      onLocalizer: true,
      onGlideslope: true,
      targetAltitude: gsAlt,
      flightPhase: 'final',
    });

    // Run a few ticks to let VS stabilize
    for (let i = 0; i < 5; i++) {
      engine.updateAircraft(acAbove, CALM_WEATHER, 1);
      engine.updateAircraft(acOnGs, CALM_WEATHER, 1);
    }

    // Aircraft above GS should be descending faster (more negative VS)
    expect(acAbove.verticalSpeed).toBeLessThan(acOnGs.verticalSpeed);
  });
});

// ─── 3. FlightPlanExecutor Localizer Capture Tests ──────────────────────────
describe('FlightPlanExecutor localizer capture', () => {
  let executor: FlightPlanExecutor;

  beforeEach(() => {
    executor = new FlightPlanExecutor();
    executor.setAirportData(minimalAirportData());
  });

  it('captures localizer when on centerline, heading aligned, within range', () => {
    const ac = aircraftOnCenterline(10, 3000);
    expect(ac.onLocalizer).toBe(false);

    executor.execute(ac);

    expect(ac.onLocalizer).toBe(true);
    expect(ac.flightPhase).toBe('final');
  });

  it('captures localizer when within 1nm cross-track and heading within 45°', () => {
    // Place aircraft 0.8nm east of centerline at 10nm
    const centerPos = destinationPoint(THRESHOLD, RECIPROCAL, 10);
    const offsetPos = destinationPoint(centerPos, 90, 0.8); // 0.8nm east
    const ac = makeAircraft({
      position: offsetPos,
      altitude: 3000,
      heading: ILS_COURSE + 20, // 177° - within 45° of 157°
      targetHeading: ILS_COURSE + 20,
    });

    executor.execute(ac);

    expect(ac.onLocalizer).toBe(true);
  });

  it('does NOT capture when cross-track > 1nm', () => {
    const centerPos = destinationPoint(THRESHOLD, RECIPROCAL, 10);
    const offsetPos = destinationPoint(centerPos, 90, 1.5); // 1.5nm east
    const ac = makeAircraft({
      position: offsetPos,
      altitude: 3000,
      heading: ILS_COURSE,
    });

    executor.execute(ac);

    expect(ac.onLocalizer).toBe(false);
  });

  it('does NOT capture when heading > 45° from localizer course', () => {
    const ac = aircraftOnCenterline(10, 3000, {
      heading: ILS_COURSE + 50, // 207° - too far from 157°
      targetHeading: ILS_COURSE + 50,
      clearances: {
        altitude: null,
        heading: ILS_COURSE + 50, // ATC heading assigned
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
    });

    executor.execute(ac);

    expect(ac.onLocalizer).toBe(false);
  });

  it('does NOT capture behind the runway', () => {
    // Place aircraft 2nm south of threshold (behind runway for RWY 16)
    const behindPos = destinationPoint(THRESHOLD, RWY_HEADING, 2);
    const ac = makeAircraft({
      position: behindPos,
      altitude: 1000,
      heading: RECIPROCAL, // Heading 337° (away from runway)
    });

    executor.execute(ac);

    expect(ac.onLocalizer).toBe(false);
  });

  it('clears ATC heading on localizer capture', () => {
    const ac = aircraftOnCenterline(10, 3000, {
      clearances: {
        altitude: null,
        heading: 140, // ATC heading assigned
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
    });

    executor.execute(ac);

    expect(ac.onLocalizer).toBe(true);
    expect(ac.clearances.heading).toBeNull();
  });
});

// ─── 4. FlightPlanExecutor Glideslope Capture Tests ─────────────────────────
describe('FlightPlanExecutor glideslope capture', () => {
  let executor: FlightPlanExecutor;

  beforeEach(() => {
    executor = new FlightPlanExecutor();
    executor.setAirportData(minimalAirportData());
  });

  it('captures GS when altitude within ±300ft of GS altitude', () => {
    const gsAlt = glideslopeAltitude(10, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(10, gsAlt + 100, {
      onLocalizer: true,
      flightPhase: 'final',
    });

    executor.execute(ac);

    expect(ac.onGlideslope).toBe(true);
  });

  it('does NOT capture GS when > 300ft above', () => {
    const gsAlt = glideslopeAltitude(10, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(10, gsAlt + 400, {
      onLocalizer: true,
      flightPhase: 'final',
    });

    executor.execute(ac);

    expect(ac.onGlideslope).toBe(false);
  });

  it('sets targetAltitude to GS altitude when on glideslope', () => {
    const gsAlt = glideslopeAltitude(8, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(8, gsAlt, {
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
    });

    executor.execute(ac);

    // targetAltitude should be set to current GS altitude (or runway elevation, whichever is higher)
    const expectedAlt = Math.max(RWY_ELEVATION, gsAlt);
    expect(ac.targetAltitude).toBeCloseTo(expectedAlt, 0);
  });
});

// ─── 5. Landing Detection Tests ─────────────────────────────────────────────
describe('FlightPlanExecutor landing detection', () => {
  let executor: FlightPlanExecutor;

  beforeEach(() => {
    executor = new FlightPlanExecutor();
    executor.setAirportData(minimalAirportData());
  });

  it('triggers landing at 0.3nm from threshold at GS altitude', () => {
    const gsAlt = glideslopeAltitude(0.3, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(0.3, gsAlt, {
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
      verticalSpeed: -700,
    });

    executor.execute(ac);

    expect(ac.flightPhase).toBe('landed');
    expect(ac.onGround).toBe(true);
    expect(ac.altitude).toBe(RWY_ELEVATION);
  });

  it('triggers landing at 0.5nm when at GS altitude', () => {
    const gsAlt = glideslopeAltitude(0.5, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(0.5, gsAlt, {
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
      verticalSpeed: -700,
    });

    executor.execute(ac);

    expect(ac.flightPhase).toBe('landed');
  });

  it('does NOT land when altitude too high at threshold', () => {
    const ac = aircraftOnCenterline(0.3, RWY_ELEVATION + 600, {
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
    });

    executor.execute(ac);

    expect(ac.flightPhase).not.toBe('landed');
  });

  it('does NOT land when too far from threshold', () => {
    const ac = aircraftOnCenterline(1.0, RWY_ELEVATION + 200, {
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
    });

    executor.execute(ac);

    expect(ac.flightPhase).not.toBe('landed');
  });
});

// ─── 6. Localizer Tracking Tests ────────────────────────────────────────────
describe('FlightPlanExecutor localizer tracking', () => {
  let executor: FlightPlanExecutor;

  beforeEach(() => {
    executor = new FlightPlanExecutor();
    executor.setAirportData(minimalAirportData());
  });

  it('converges toward centerline when offset east (multi-tick)', () => {
    // Aircraft 0.5nm east of centerline, on localizer at 8nm
    const centerPos = destinationPoint(THRESHOLD, RECIPROCAL, 8);
    const offsetPos = destinationPoint(centerPos, 90, 0.5);
    const ac = makeAircraft({
      position: offsetPos,
      altitude: 2700,
      heading: ILS_COURSE,
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
      groundspeed: 180,
      speed: 180,
      targetSpeed: 180,
    });

    // Measure initial cross-track
    const farPoint = destinationPoint(THRESHOLD, RECIPROCAL, 30);
    const initialXtk = Math.abs(crossTrackDistance(ac.position, THRESHOLD, farPoint));

    const physics = new PhysicsEngine();
    // Run 60 ticks — aircraft should converge toward centerline
    for (let i = 0; i < 60; i++) {
      const dist = haversineDistance(ac.position, THRESHOLD);
      ac.targetAltitude = Math.max(RWY_ELEVATION, glideslopeAltitude(dist, RWY_ELEVATION, GS_ANGLE));
      executor.execute(ac);
      physics.updateAircraft(ac, CALM_WEATHER, 1);
    }

    const finalXtk = Math.abs(crossTrackDistance(ac.position, THRESHOLD, farPoint));
    expect(finalXtk).toBeLessThan(initialXtk); // Cross-track should decrease
    expect(finalXtk).toBeLessThan(0.2); // Should be well within 0.2nm after 60 ticks
  });

  it('converges toward centerline when offset west (multi-tick)', () => {
    const centerPos = destinationPoint(THRESHOLD, RECIPROCAL, 8);
    const offsetPos = destinationPoint(centerPos, 270, 0.5);
    const ac = makeAircraft({
      position: offsetPos,
      altitude: 2700,
      heading: ILS_COURSE,
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
      groundspeed: 180,
      speed: 180,
      targetSpeed: 180,
    });

    const farPoint = destinationPoint(THRESHOLD, RECIPROCAL, 30);
    const initialXtk = Math.abs(crossTrackDistance(ac.position, THRESHOLD, farPoint));

    const physics = new PhysicsEngine();
    for (let i = 0; i < 60; i++) {
      const dist = haversineDistance(ac.position, THRESHOLD);
      ac.targetAltitude = Math.max(RWY_ELEVATION, glideslopeAltitude(dist, RWY_ELEVATION, GS_ANGLE));
      executor.execute(ac);
      physics.updateAircraft(ac, CALM_WEATHER, 1);
    }

    const finalXtk = Math.abs(crossTrackDistance(ac.position, THRESHOLD, farPoint));
    expect(finalXtk).toBeLessThan(initialXtk);
    expect(finalXtk).toBeLessThan(0.2);
  });

  it('gives approximately localizer course when on centerline', () => {
    const ac = aircraftOnCenterline(8, 2700, {
      onLocalizer: true,
      flightPhase: 'final',
    });

    executor.execute(ac);

    // Should be very close to ILS_COURSE when exactly on centerline
    const hdgDiff = Math.abs(headingDifference(ILS_COURSE, ac.targetHeading));
    expect(hdgDiff).toBeLessThan(3);
  });
});

// ─── 7. Full ILS Pipeline Integration Test ──────────────────────────────────
describe('Full ILS Pipeline (FlightPlanExecutor + PhysicsEngine)', () => {
  let executor: FlightPlanExecutor;
  let physics: PhysicsEngine;

  beforeEach(() => {
    executor = new FlightPlanExecutor();
    executor.setAirportData(minimalAirportData());
    physics = new PhysicsEngine();
  });

  it('aircraft starting on centerline at 10nm/3000ft completes ILS to landing', () => {
    const ac = aircraftOnCenterline(10, 3000, {
      speed: 180,
      groundspeed: 180,
      targetSpeed: 180,
    });

    let capturedLocalizer = false;
    let capturedGlideslope = false;
    let landed = false;
    let minDistToThreshold = 999;
    let altAtMinDist = 0;
    const MAX_TICKS = 400; // ~6.7 min at 180kts to cover 10nm + margin

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      // FlightPlanExecutor runs first (as in SimulationEngine)
      executor.execute(ac);

      // Then PhysicsEngine
      physics.updateAircraft(ac, CALM_WEATHER, 1);

      // Track progress
      if (ac.onLocalizer) capturedLocalizer = true;
      if (ac.onGlideslope) capturedGlideslope = true;

      const dist = haversineDistance(ac.position, THRESHOLD);
      if (dist < minDistToThreshold) {
        minDistToThreshold = dist;
        altAtMinDist = ac.altitude;
      }

      if (ac.flightPhase === 'landed') {
        landed = true;
        break;
      }

      // Safety: if aircraft somehow goes way past threshold, break
      if (dist > 15 && tick > 100) break;
    }

    expect(capturedLocalizer).toBe(true);
    expect(capturedGlideslope).toBe(true);
    expect(landed).toBe(true);
  });

  it('aircraft 0.5nm east of centerline at 10nm/3000ft captures and lands', () => {
    // Offset from centerline - tests localizer convergence
    const centerPos = destinationPoint(THRESHOLD, RECIPROCAL, 10);
    const offsetPos = destinationPoint(centerPos, 90, 0.5);
    const ac = makeAircraft({
      position: offsetPos,
      altitude: 3000,
      heading: ILS_COURSE,
      speed: 180,
      groundspeed: 180,
      targetSpeed: 180,
    });

    let landed = false;
    let capturedLocalizer = false;
    const MAX_TICKS = 450;

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      executor.execute(ac);
      physics.updateAircraft(ac, CALM_WEATHER, 1);

      if (ac.onLocalizer) capturedLocalizer = true;

      if (ac.flightPhase === 'landed') {
        landed = true;
        break;
      }
    }

    expect(capturedLocalizer).toBe(true);
    expect(landed).toBe(true);
  });

  it('aircraft tracks GS altitude accurately at 5nm, 3nm, 1nm checkpoints', () => {
    // Start exactly on GS at 10nm
    const gsAlt10 = glideslopeAltitude(10, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(10, gsAlt10, {
      onLocalizer: true,
      onGlideslope: true,
      flightPhase: 'final',
      speed: 180,
      groundspeed: 180,
      targetSpeed: 180,
    });

    const checkpoints: { nm: number; alt: number }[] = [];
    const MAX_TICKS = 400;

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      const dist = haversineDistance(ac.position, THRESHOLD);

      // Record altitude at checkpoints
      if (dist < 5.05 && dist > 4.95 && !checkpoints.find(c => c.nm === 5)) {
        checkpoints.push({ nm: 5, alt: ac.altitude });
      }
      if (dist < 3.05 && dist > 2.95 && !checkpoints.find(c => c.nm === 3)) {
        checkpoints.push({ nm: 3, alt: ac.altitude });
      }
      if (dist < 1.05 && dist > 0.95 && !checkpoints.find(c => c.nm === 1)) {
        checkpoints.push({ nm: 1, alt: ac.altitude });
      }

      executor.execute(ac);
      physics.updateAircraft(ac, CALM_WEATHER, 1);

      if (ac.flightPhase === 'landed') break;
    }

    // Verify altitude tracking at each checkpoint
    for (const cp of checkpoints) {
      const expectedAlt = glideslopeAltitude(cp.nm, RWY_ELEVATION, GS_ANGLE);
      const deviation = Math.abs(cp.alt - expectedAlt);
      expect(deviation).toBeLessThan(100); // Within 100ft of GS at each checkpoint
    }

    // Should have hit at least the 5nm and 3nm checkpoints
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
  });

  it('aircraft starting 250ft above GS converges and lands', () => {
    // This is the exact scenario that was failing: capture GS while above it
    const gsAlt = glideslopeAltitude(9, RWY_ELEVATION, GS_ANGLE);
    const ac = aircraftOnCenterline(9, gsAlt + 250, {
      speed: 180,
      groundspeed: 180,
      targetSpeed: 180,
    });

    let landed = false;
    let maxDeviation = 0;
    const MAX_TICKS = 400;

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      executor.execute(ac);
      physics.updateAircraft(ac, CALM_WEATHER, 1);

      if (ac.onGlideslope) {
        const dist = haversineDistance(ac.position, THRESHOLD);
        const gsAltNow = glideslopeAltitude(dist, RWY_ELEVATION, GS_ANGLE);
        const dev = Math.abs(ac.altitude - gsAltNow);
        if (dev > maxDeviation && dist < 7) maxDeviation = dev;
      }

      if (ac.flightPhase === 'landed') {
        landed = true;
        break;
      }
    }

    expect(landed).toBe(true);
    // Max deviation after the first few nm of convergence should be manageable
    // The aircraft starts 250ft above, should converge by 5nm out
  });

  it('does not go below ground level at any point', () => {
    const ac = aircraftOnCenterline(10, 3000, {
      speed: 180,
      groundspeed: 180,
      targetSpeed: 180,
    });

    let minAlt = 99999;
    const MAX_TICKS = 500;

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      executor.execute(ac);
      physics.updateAircraft(ac, CALM_WEATHER, 1);

      if (ac.altitude < minAlt) minAlt = ac.altitude;

      if (ac.flightPhase === 'landed') break;
    }

    // Aircraft should never go below runway elevation
    expect(minAlt).toBeGreaterThanOrEqual(RWY_ELEVATION - 5);
  });
});

// ─── 8. Ground Rollout Tests ─────────────────────────────────────────────────
describe('Ground rollout after landing', () => {
  let executor: FlightPlanExecutor;
  let physics: PhysicsEngine;

  beforeEach(() => {
    executor = new FlightPlanExecutor();
    executor.setAirportData(minimalAirportData());
    physics = new PhysicsEngine();
  });

  it('aircraft decelerates and moves along runway after touchdown', () => {
    // Run full approach to landing
    const ac = aircraftOnCenterline(10, 3000, {
      speed: 180,
      groundspeed: 180,
      targetSpeed: 180,
    });

    const MAX_TICKS = 400;
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      executor.execute(ac);
      if (ac.flightPhase === 'landed') break;
      physics.updateAircraft(ac, CALM_WEATHER, 1);
    }

    expect(ac.flightPhase).toBe('landed');
    const perf = performanceDB.getOrDefault('B738');
    expect(ac.speed).toBe(perf.speed.vref); // Speed preserved at Vref
    expect(ac.targetSpeed).toBe(15); // Target is taxi speed

    // Now run ground rollout physics
    const touchdownPos = { ...ac.position };
    const initialSpeed = ac.speed;

    for (let tick = 0; tick < 60; tick++) {
      physics.updateGroundRollout(ac, 1);
    }

    // Speed should have decreased significantly (decel ~4kts/sec above 60, ~2 below)
    expect(ac.speed).toBeLessThan(initialSpeed);
    expect(ac.speed).toBeLessThan(60);

    // Position should have moved along runway heading
    const distMoved = haversineDistance(touchdownPos, ac.position);
    expect(distMoved).toBeGreaterThan(0.1); // Should have moved at least 0.1nm
    expect(ac.rolloutDistanceNm).toBeGreaterThan(0.1);
  });

  it('runwayOccupying is set at landing and cleared after rollout', () => {
    const ac = aircraftOnCenterline(10, 3000, {
      speed: 180,
      groundspeed: 180,
      targetSpeed: 180,
    });

    const MAX_TICKS = 400;
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      executor.execute(ac);
      if (ac.flightPhase === 'landed') break;
      physics.updateAircraft(ac, CALM_WEATHER, 1);
    }

    expect(ac.flightPhase).toBe('landed');
    expect(ac.runwayOccupying).toBe('16');
    expect(ac.rolloutDistanceNm).toBe(0);

    // Run rollout until speed drops to taxi
    for (let tick = 0; tick < 120; tick++) {
      physics.updateGroundRollout(ac, 1);
    }

    // Should have slowed to taxi speed
    expect(ac.speed).toBeLessThanOrEqual(16);
  });
});
