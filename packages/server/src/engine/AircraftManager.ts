import type {
  AircraftState,
  AircraftPerformance,
  FlightPlan,
  Clearances,
  Position,
  FlightPhase,
  WakeCategory,
} from '@atc-sim/shared';
import { haversineDistance } from '@atc-sim/shared';
import { v4 as uuid } from 'uuid';
import { performanceDB } from '../data/PerformanceDB.js';

/** Default airspace radius in nm - aircraft beyond this are removed */
const AIRSPACE_RADIUS_NM = 80;

/** Create default clearances */
function defaultClearances(): Clearances {
  return {
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
  };
}

/**
 * AircraftManager handles aircraft lifecycle: spawn, track, remove.
 */
export class AircraftManager {
  private aircraft = new Map<string, AircraftState>();
  private airportCenter: Position = { lat: 37.5052, lon: -77.3197 };
  private squawkCounter = 1200;

  setAirportCenter(pos: Position): void {
    this.airportCenter = pos;
  }

  /** Spawn a new aircraft with given parameters */
  spawnAircraft(params: {
    callsign: string;
    typeDesignator: string;
    position: Position;
    altitude: number;
    heading: number;
    speed: number;
    flightPlan: FlightPlan;
    category: 'arrival' | 'departure' | 'overflight' | 'vfr';
    flightPhase: FlightPhase;
  }): AircraftState {
    const perf = performanceDB.getOrDefault(params.typeDesignator);
    const id = uuid();

    const clearances = defaultClearances();

    const ac: AircraftState = {
      id,
      callsign: params.callsign,
      typeDesignator: params.typeDesignator,
      wakeCategory: perf.wakeCategory,
      position: { ...params.position },
      altitude: params.altitude,
      heading: params.heading,
      speed: params.speed,
      groundspeed: params.speed, // will be corrected on first tick
      verticalSpeed: 0,
      onGround: false,
      flightPhase: params.flightPhase,
      transponder: 'modeC',
      flightPlan: params.flightPlan,
      clearances,
      currentFixIndex: 0,
      onLocalizer: false,
      onGlideslope: false,
      handingOff: false,
      category: params.category,
      historyTrail: [],
      targetAltitude: params.altitude,
      targetHeading: params.heading,
      targetSpeed: params.speed,
      bankAngle: 0,
    };

    this.aircraft.set(id, ac);
    return ac;
  }

  /** Get aircraft by ID */
  getById(id: string): AircraftState | undefined {
    return this.aircraft.get(id);
  }

  /** Get aircraft by callsign (case-insensitive, partial match) */
  getByCallsign(callsign: string): AircraftState | undefined {
    const upper = callsign.toUpperCase();
    // Exact match first
    for (const ac of this.aircraft.values()) {
      if (ac.callsign.toUpperCase() === upper) return ac;
    }
    // Partial match
    for (const ac of this.aircraft.values()) {
      if (ac.callsign.toUpperCase().includes(upper)) return ac;
    }
    return undefined;
  }

  /** Get all aircraft */
  getAll(): AircraftState[] {
    return Array.from(this.aircraft.values());
  }

  /** Remove aircraft by ID */
  remove(id: string): void {
    this.aircraft.delete(id);
  }

  /** Remove aircraft that have left the airspace or landed */
  cleanup(): string[] {
    const removed: string[] = [];
    for (const [id, ac] of this.aircraft) {
      // Remove landed aircraft after a delay
      if (ac.flightPhase === 'landed') {
        removed.push(id);
        this.aircraft.delete(id);
        continue;
      }

      // Remove aircraft that have left the airspace
      const dist = haversineDistance(ac.position, this.airportCenter);
      if (dist > AIRSPACE_RADIUS_NM) {
        removed.push(id);
        this.aircraft.delete(id);
        continue;
      }
    }
    return removed;
  }

  /** Generate a unique squawk code */
  nextSquawk(): string {
    this.squawkCounter++;
    if (this.squawkCounter > 7777) this.squawkCounter = 1201;
    // Ensure valid octal (no digit > 7)
    let sq = this.squawkCounter;
    while (hasInvalidOctalDigit(sq)) {
      sq++;
      if (sq > 7777) sq = 1201;
    }
    this.squawkCounter = sq;
    return String(sq).padStart(4, '0');
  }

  /** Get count of aircraft */
  get count(): number {
    return this.aircraft.size;
  }

  /** Clear all aircraft */
  clear(): void {
    this.aircraft.clear();
  }
}

function hasInvalidOctalDigit(n: number): boolean {
  const s = String(n);
  for (const c of s) {
    if (parseInt(c) > 7) return true;
  }
  return false;
}
