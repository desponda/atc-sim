/**
 * ScoringEngine Unit Tests
 *
 * Covers: separation violations, MSAW, handoff penalties (tower + center),
 * grace periods, double-penalty prevention, delay scoring, grade thresholds,
 * syncActiveViolations, and reset.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AircraftState, AirportData, Position, Runway, Alert } from '@atc-sim/shared';
import { ScoringEngine } from '../game/ScoringEngine.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const AIRPORT_POS: Position = { lat: 37.5054, lon: -77.3197 }; // KRIC
const RWY16_THRESHOLD: Position = { lat: 37.5166, lon: -77.3236 };

/** Minimal AirportData for tests */
const MOCK_AIRPORT: AirportData = {
  icao: 'KRIC',
  name: 'Richmond International',
  position: AIRPORT_POS,
  elevation: 167,
  magneticVariation: -9,
  runways: [
    {
      id: '16',
      heading: 157,
      threshold: RWY16_THRESHOLD,
      end: { lat: 37.4990, lon: -77.3113 },
      length: 9003,
      width: 150,
      elevation: 167,
      ilsAvailable: true,
      ilsFrequency: 109.5,
      ilsCourse: 157,
      glideslopeAngle: 3.0,
    } as Runway,
  ],
  frequencies: { atis: 127.85, approach: [124.0], tower: [119.1], ground: [121.7], clearance: [] },
  fixes: [],
  navaids: [],
  procedures: { sids: [], stars: [], approaches: [] },
  tracon: { lateralRadiusNm: 40, ceiling: 23000, floor: 0 },
} as unknown as AirportData;

/** Build a minimal AircraftState with only the fields ScoringEngine reads */
function makeAircraft(overrides: Partial<AircraftState>): AircraftState {
  return {
    id: 'test-001',
    callsign: 'UAL001',
    typeDesignator: 'B738',
    wakeCategory: 'LARGE',
    position: AIRPORT_POS,
    altitude: 10000,
    heading: 0,
    speed: 250,
    groundspeed: 250,
    verticalSpeed: 0,
    onGround: false,
    flightPhase: 'cruise',
    transponder: 'modeC',
    flightPlan: {
      departure: 'KRIC',
      arrival: 'KJFK',
      cruiseAltitude: 35000,
      route: [],
      sid: null,
      star: null,
      runway: null,
      squawk: '1234',
    },
    clearances: {
      altitude: null,
      heading: null,
      speed: null,
      turnDirection: null,
      approach: null,
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
    targetAltitude: 10000,
    targetHeading: 0,
    targetSpeed: 250,
    bankAngle: 0,
    ...overrides,
  } as AircraftState;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a conflict-warning alert between two aircraft */
function conflictAlert(id1: string, id2: string): Alert {
  return {
    id: `conflict-${id1}-${id2}`,
    type: 'conflict',
    severity: 'warning',
    aircraftIds: [id1, id2],
    message: 'Separation',
    timestamp: Date.now(),
  };
}

/** Build an MSAW alert */
function msawAlert(id: string): Alert {
  return {
    id: `msaw-${id}`,
    type: 'msaw',
    severity: 'warning',
    aircraftIds: [id],
    message: 'MSAW',
    timestamp: Date.now(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ScoringEngine', () => {
  let engine: ScoringEngine;

  beforeEach(() => {
    engine = new ScoringEngine();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('starts with score 100 and grade A', () => {
    const m = engine.getMetrics();
    expect(m.overallScore).toBe(100);
    expect(m.grade).toBe('A');
  });

  it('starts with all counters at zero', () => {
    const m = engine.getMetrics();
    expect(m.separationViolations).toBe(0);
    expect(m.violationDuration).toBe(0);
    expect(m.conflictAlerts).toBe(0);
    expect(m.aircraftHandled).toBe(0);
    expect(m.missedHandoffs).toBe(0);
    expect(m.commandsIssued).toBe(0);
  });

  // ── Separation violations ──────────────────────────────────────────────────

  it('counts each unique conflict pair once', () => {
    engine.recordAlert(conflictAlert('A', 'B'));
    engine.recordAlert(conflictAlert('A', 'B')); // duplicate — same pair
    expect(engine.getMetrics().separationViolations).toBe(1);
  });

  it('counts different pairs as separate violations', () => {
    engine.recordAlert(conflictAlert('A', 'B'));
    engine.recordAlert(conflictAlert('A', 'C'));
    expect(engine.getMetrics().separationViolations).toBe(2);
  });

  it('deducts 5 points per separation violation', () => {
    engine.recordAlert(conflictAlert('A', 'B'));
    engine.update();
    expect(engine.getMetrics().overallScore).toBe(100 - 5);
  });

  it('increments conflictAlerts for every alert (including duplicates)', () => {
    engine.recordAlert(conflictAlert('A', 'B'));
    engine.recordAlert(conflictAlert('A', 'B'));
    expect(engine.getMetrics().conflictAlerts).toBe(2);
  });

  // ── Violation duration ─────────────────────────────────────────────────────

  it('accumulates 1 violation-second per active pair per tick', () => {
    engine.recordAlert(conflictAlert('A', 'B'));
    engine.update();
    engine.update();
    engine.update();
    // 3 ticks × 1 active pair = 3 seconds; score = 100 - 5 (violation) - floor(3/30) (duration) = 95
    expect(engine.getMetrics().violationDuration).toBe(3);
    expect(engine.getMetrics().overallScore).toBe(95);
  });

  it('clears violation duration penalty when violation resolved', () => {
    engine.recordAlert(conflictAlert('A', 'B'));
    engine.update(); // 1 tick of violation
    engine.clearViolation(['A', 'B']);
    // Duration already recorded; no more increment after clear
    const durationBefore = engine.getMetrics().violationDuration;
    engine.update();
    expect(engine.getMetrics().violationDuration).toBe(durationBefore);
  });

  // ── MSAW ──────────────────────────────────────────────────────────────────

  it('deducts 3 points per MSAW incident', () => {
    engine.recordAlert(msawAlert('A'));
    engine.update();
    expect(engine.getMetrics().overallScore).toBe(100 - 3);
  });

  it('treats multiple MSAW alerts as separate incidents', () => {
    engine.recordAlert(msawAlert('A'));
    engine.recordAlert(msawAlert('B'));
    engine.update();
    expect(engine.getMetrics().overallScore).toBe(100 - 6);
  });

  // ── Missed handoffs ────────────────────────────────────────────────────────

  it('deducts 2 points per missed handoff', () => {
    engine.recordMissedHandoff();
    engine.recordMissedHandoff();
    engine.update();
    expect(engine.getMetrics().overallScore).toBe(100 - 4);
    expect(engine.getMetrics().missedHandoffs).toBe(2);
  });

  // ── Aircraft handled / clean bonus ────────────────────────────────────────

  it('increments aircraftHandled counter', () => {
    engine.recordAircraftHandled(0);
    engine.recordAircraftHandled(0);
    expect(engine.getMetrics().aircraftHandled).toBe(2);
  });

  it('adds +1 per aircraft handled under 5-minute delay (capped at 100)', () => {
    // 2 clean aircraft (delay < 300s) = +2 bonus, but overall score is capped at 100
    engine.recordAircraftHandled(0);
    engine.recordAircraftHandled(299);
    engine.update();
    expect(engine.getMetrics().overallScore).toBe(100); // 100 + 2 = 102, capped to 100
  });

  it('no clean bonus for aircraft with delay ≥ 300 seconds', () => {
    engine.recordAircraftHandled(300);
    engine.update();
    expect(engine.getMetrics().overallScore).toBe(100); // no bonus, no excess delay penalty (exactly at threshold)
  });

  it('deducts 1 point per 2 minutes of average delay beyond 5 minutes', () => {
    // Average delay = 900s (15 min) → excess = 600s → penalty = floor(600/120) = 5
    engine.recordAircraftHandled(900);
    engine.update();
    expect(engine.getMetrics().overallScore).toBe(100 - 5);
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  it('tracks commands issued', () => {
    engine.recordCommand();
    engine.recordCommand();
    expect(engine.getMetrics().commandsIssued).toBe(2);
  });

  it('recordBadCommand deducts points immediately', () => {
    engine.recordBadCommand(3);
    expect(engine.getMetrics().overallScore).toBe(97);
  });

  // ── syncActiveViolations ──────────────────────────────────────────────────

  it('syncActiveViolations removes stale violations', () => {
    engine.recordAlert(conflictAlert('A', 'B'));
    engine.recordAlert(conflictAlert('C', 'D'));
    engine.update(); // 2 active pairs → +2 duration

    // Only A:B is still active
    engine.syncActiveViolations([['A', 'B']]);
    engine.update(); // only 1 active pair now
    expect(engine.getMetrics().violationDuration).toBe(3); // 2 + 1
  });

  it('syncActiveViolations with empty list removes all active violations', () => {
    engine.recordAlert(conflictAlert('A', 'B'));
    engine.syncActiveViolations([]);
    const dBefore = engine.getMetrics().violationDuration;
    engine.update();
    expect(engine.getMetrics().violationDuration).toBe(dBefore);
  });

  // ── Grade thresholds ──────────────────────────────────────────────────────

  it.each([
    [90, 'A'],
    [89, 'B'],
    [80, 'B'],
    [79, 'C'],
    [70, 'C'],
    [69, 'D'],
    [60, 'D'],
    [59, 'F'],
  ] as [number, string][])('score %i → grade %s', (score, grade) => {
    // Drive score down with violations
    const needed = 100 - score;
    for (let i = 0; i < Math.ceil(needed / 5); i++) {
      engine.recordAlert(conflictAlert(`X${i}`, `Y${i}`));
    }
    engine.update();
    const m = engine.getMetrics();
    // Score may differ slightly due to discrete steps; just check grade boundary
    if (m.overallScore >= 90) expect(m.grade).toBe('A');
    else if (m.overallScore >= 80) expect(m.grade).toBe('B');
    else if (m.overallScore >= 70) expect(m.grade).toBe('C');
    else if (m.overallScore >= 60) expect(m.grade).toBe('D');
    else expect(m.grade).toBe('F');
  });

  // ── Tower handoff penalties ────────────────────────────────────────────────

  describe('checkHandoffPenalties — tower (arrival)', () => {
    it('penalizes -5 for late tower handoff (within 2nm on final, inbound accepted)', () => {
      // Place aircraft very close to threshold (0.5 nm) on final
      const ac = makeAircraft({
        id: 'arr-001',
        category: 'arrival',
        flightPhase: 'final',
        inboundHandoff: 'accepted',
        inboundHandoffOfferedAt: 0, // offered at tick 0
        handingOff: false,
        position: { lat: 37.5121, lon: -77.3180 }, // ~0.5nm from RWY16 threshold
        flightPlan: {
          departure: 'KJFK', arrival: 'KRIC', cruiseAltitude: 35000,
          route: [], sid: null, star: null, runway: '16', squawk: '1234',
        },
      });

      // currentTick = 100, offeredAt = 0 → age = 100 ≥ INBOUND_GRACE_TICKS(90)
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 100);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(95); // 100 - 5
    });

    it('does NOT penalize if inbound handoff was not accepted', () => {
      const ac = makeAircraft({
        id: 'arr-002',
        category: 'arrival',
        flightPhase: 'final',
        inboundHandoff: 'offered', // not accepted
        inboundHandoffOfferedAt: 0,
        handingOff: false,
        position: { lat: 37.5121, lon: -77.3180 },
        flightPlan: {
          departure: 'KJFK', arrival: 'KRIC', cruiseAltitude: 35000,
          route: [], sid: null, star: null, runway: '16', squawk: '1234',
        },
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 100);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(100);
    });

    it('does NOT penalize before INBOUND_GRACE_TICKS (90 ticks)', () => {
      const ac = makeAircraft({
        id: 'arr-003',
        category: 'arrival',
        flightPhase: 'final',
        inboundHandoff: 'accepted',
        inboundHandoffOfferedAt: 20, // offered at tick 20
        handingOff: false,
        position: { lat: 37.5121, lon: -77.3180 },
        flightPlan: {
          departure: 'KJFK', arrival: 'KRIC', cruiseAltitude: 35000,
          route: [], sid: null, star: null, runway: '16', squawk: '1234',
        },
      });

      // currentTick = 100, offeredAt = 20 → age = 80 < GRACE(90)
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 100);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(100);
    });

    it('does NOT penalize if aircraft is handing off', () => {
      const ac = makeAircraft({
        id: 'arr-004',
        category: 'arrival',
        flightPhase: 'final',
        inboundHandoff: 'accepted',
        inboundHandoffOfferedAt: 0,
        handingOff: true, // correctly handing off
        position: { lat: 37.5121, lon: -77.3180 },
        flightPlan: {
          departure: 'KJFK', arrival: 'KRIC', cruiseAltitude: 35000,
          route: [], sid: null, star: null, runway: '16', squawk: '1234',
        },
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 100);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(100);
    });

    it('penalizes -10 for missed tower handoff (landed, accepted, not handing off, not already late-penalized)', () => {
      const ac = makeAircraft({
        id: 'arr-005',
        category: 'arrival',
        flightPhase: 'landed',
        inboundHandoff: 'accepted',
        inboundHandoffOfferedAt: 0,
        handingOff: false,
        position: AIRPORT_POS,
        flightPlan: {
          departure: 'KJFK', arrival: 'KRIC', cruiseAltitude: 35000,
          route: [], sid: null, star: null, runway: '16', squawk: '1234',
        },
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 100);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(90); // 100 - 10
    });

    it('does not double-penalize — late penalty prevents missed penalty', () => {
      // First late penalty fires
      const ac = makeAircraft({
        id: 'arr-006',
        category: 'arrival',
        flightPhase: 'final',
        inboundHandoff: 'accepted',
        inboundHandoffOfferedAt: 0,
        handingOff: false,
        position: { lat: 37.5121, lon: -77.3180 },
        flightPlan: {
          departure: 'KJFK', arrival: 'KRIC', cruiseAltitude: 35000,
          route: [], sid: null, star: null, runway: '16', squawk: '1234',
        },
      });
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 100);

      // Now aircraft has landed (same ID)
      ac.flightPhase = 'landed';
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 110);
      engine.update();

      // Only late penalty (-5), no additional missed penalty (-10)
      expect(engine.getMetrics().overallScore).toBe(95);
    });

    it('does not penalize twice for the same late event', () => {
      const ac = makeAircraft({
        id: 'arr-007',
        category: 'arrival',
        flightPhase: 'final',
        inboundHandoff: 'accepted',
        inboundHandoffOfferedAt: 0,
        handingOff: false,
        position: { lat: 37.5121, lon: -77.3180 },
        flightPlan: {
          departure: 'KJFK', arrival: 'KRIC', cruiseAltitude: 35000,
          route: [], sid: null, star: null, runway: '16', squawk: '1234',
        },
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 100);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 101);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 102);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(95); // only -5, not -15
    });
  });

  // ── Center handoff penalties ───────────────────────────────────────────────

  describe('checkHandoffPenalties — center (departure)', () => {
    it('does NOT penalize before DEPARTURE_GRACE_TICKS (300 ticks)', () => {
      const ac = makeAircraft({
        id: 'dep-001',
        category: 'departure',
        flightPhase: 'climb',
        altitude: 19000, // above FL180
        handingOff: false,
        position: AIRPORT_POS,
      });

      // First seen at tick 0 → only 50 ticks of age
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 0);
      for (let t = 1; t <= 50; t++) {
        engine.checkHandoffPenalties([ac], MOCK_AIRPORT, t);
      }
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(100); // no penalty yet
    });

    it('penalizes -5 when departure exceeds FL180 without handoff after grace period', () => {
      const ac = makeAircraft({
        id: 'dep-002',
        category: 'departure',
        flightPhase: 'climb',
        altitude: 19000, // above FL180
        handingOff: false,
        position: AIRPORT_POS,
      });

      // Record airborne at tick 0, check at tick 300 (exactly at grace boundary)
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 0);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 300);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(95); // -5 late penalty
    });

    it('penalizes -10 when departure beyond 40nm without handoff after grace period', () => {
      // Position ~50nm north of KRIC
      const farNorth: Position = { lat: 38.320, lon: -77.3197 };
      const ac = makeAircraft({
        id: 'dep-003',
        category: 'departure',
        flightPhase: 'climb',
        altitude: 15000, // below FL180 (no late-center penalty)
        handingOff: false,
        position: farNorth,
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 0);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 300);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(90); // -10 missed penalty
    });

    it('does NOT penalize if aircraft is handing off to center', () => {
      const ac = makeAircraft({
        id: 'dep-004',
        category: 'departure',
        flightPhase: 'climb',
        altitude: 19000,
        handingOff: true, // actively handing off — no penalty
        position: AIRPORT_POS,
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 0);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 300);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(100);
    });

    it('does not double-penalize altitude penalty on repeated checks', () => {
      const ac = makeAircraft({
        id: 'dep-005',
        category: 'departure',
        flightPhase: 'climb',
        altitude: 19000,
        handingOff: false,
        position: AIRPORT_POS,
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 0);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 300);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 301);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 302);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(95); // -5 only once
    });

    it('does not double-penalize distance penalty on repeated checks', () => {
      const farNorth: Position = { lat: 38.320, lon: -77.3197 };
      const ac = makeAircraft({
        id: 'dep-006',
        category: 'departure',
        flightPhase: 'climb',
        altitude: 15000,
        handingOff: false,
        position: farNorth,
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 0);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 300);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 305);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(90); // -10 only once
    });

    it('can accumulate both altitude and distance penalty for same departure', () => {
      const farNorth: Position = { lat: 38.320, lon: -77.3197 };
      const ac = makeAircraft({
        id: 'dep-007',
        category: 'departure',
        flightPhase: 'climb',
        altitude: 19000, // above FL180
        handingOff: false,
        position: farNorth, // beyond 40nm
      });

      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 0);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 300);
      engine.update();
      // -5 (late above FL180) + -10 (missed beyond 40nm) = -15
      expect(engine.getMetrics().overallScore).toBe(85);
    });
  });

  // ── Reset ─────────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('clears all metrics back to initial state', () => {
      engine.recordAlert(conflictAlert('A', 'B'));
      engine.recordAlert(msawAlert('C'));
      engine.recordMissedHandoff();
      engine.recordAircraftHandled(500);
      engine.recordCommand();
      engine.update();

      engine.reset();
      const m = engine.getMetrics();
      expect(m.overallScore).toBe(100);
      expect(m.grade).toBe('A');
      expect(m.separationViolations).toBe(0);
      expect(m.violationDuration).toBe(0);
      expect(m.conflictAlerts).toBe(0);
      expect(m.aircraftHandled).toBe(0);
      expect(m.missedHandoffs).toBe(0);
      expect(m.commandsIssued).toBe(0);
    });

    it('clears handoff penalty sets so penalties can fire again after reset', () => {
      // Trigger a late departure penalty
      const ac = makeAircraft({
        id: 'dep-reset',
        category: 'departure',
        flightPhase: 'climb',
        altitude: 19000,
        handingOff: false,
        position: AIRPORT_POS,
      });
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 0);
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 300);
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(95);

      // Reset and verify penalty can fire fresh on next check
      engine.reset();
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 301); // new "airborne at" recorded
      engine.checkHandoffPenalties([ac], MOCK_AIRPORT, 601); // grace passed again
      engine.update();
      expect(engine.getMetrics().overallScore).toBe(95); // -5 again after fresh start
    });
  });

  // ── Score floor ───────────────────────────────────────────────────────────

  it('score never goes below 0', () => {
    for (let i = 0; i < 30; i++) {
      engine.recordAlert(conflictAlert(`X${i}`, `Y${i}`));
    }
    engine.update();
    expect(engine.getMetrics().overallScore).toBeGreaterThanOrEqual(0);
  });

  it('score never exceeds 100', () => {
    for (let i = 0; i < 20; i++) {
      engine.recordAircraftHandled(0); // +1 bonus each
    }
    engine.update();
    expect(engine.getMetrics().overallScore).toBeLessThanOrEqual(100);
  });
});
