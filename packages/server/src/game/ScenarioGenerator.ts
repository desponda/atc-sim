import type {
  AircraftState,
  AirportData,
  SessionConfig,
  STAR,
  Position,
  FlightPhase,
  FlightPlan,
} from '@atc-sim/shared';
import { destinationPoint, normalizeHeading, initialBearing } from '@atc-sim/shared';
import { AircraftManager } from '../engine/AircraftManager.js';
import { performanceDB } from '../data/PerformanceDB.js';

/** Airline ICAO codes and relative weights for KRIC traffic mix */
const AIRLINE_MIX = [
  { icao: 'AAL', weight: 14 },  // American
  { icao: 'DAL', weight: 14 },  // Delta
  { icao: 'UAL', weight: 10 },  // United
  { icao: 'SWA', weight: 10 },  // Southwest
  { icao: 'JBU', weight: 6 },   // JetBlue
  { icao: 'NKS', weight: 5 },   // Spirit
  { icao: 'MXY', weight: 5 },   // Breeze (hub at KRIC)
  { icao: 'FFT', weight: 3 },   // Frontier
  { icao: 'RPA', weight: 6 },   // Republic (regional for UAL/AAL/DAL)
  { icao: 'EDV', weight: 4 },   // Endeavor (regional for DAL)
  { icao: 'SKW', weight: 5 },   // SkyWest (regional)
  { icao: 'PDT', weight: 4 },   // Piedmont (regional for AAL)
  { icao: 'JIA', weight: 4 },   // PSA Airlines (regional for AAL)
  { icao: 'FDX', weight: 3 },   // FedEx cargo
  { icao: 'UPS', weight: 2 },   // UPS cargo
];

/** Aircraft types weighted by airline type */
const MAINLINE_TYPES = ['B738', 'A320', 'A21N', 'B737'];
const REGIONAL_TYPES = ['CRJ9', 'CRJ7', 'CRJ2', 'E75L', 'E170', 'E145'];
const CARGO_TYPES = ['B738']; // Fallback; real cargo uses larger types
const BIZJET_TYPES = ['C56X', 'CL30'];
const REGIONAL_AIRLINES = ['RPA', 'EDV', 'SKW', 'PDT', 'JIA'];
const CARGO_AIRLINES = ['FDX', 'UPS'];

/** VFR aircraft types (includes bizjets for N-number IFR traffic) */
const VFR_TYPES = ['C172', 'C182', 'SR22', 'C56X', 'CL30'];

/** VFR callsign prefixes (N-numbers) */
const VFR_PREFIXES = ['N'];

/** Density -> operations per hour */
const DENSITY_OPS: Record<string, number> = {
  light: 8,
  moderate: 16,
  heavy: 28,
};

/** Density -> initial aircraft count to pre-spawn */
const DENSITY_INITIAL: Record<string, number> = {
  light: 4,
  moderate: 7,
  heavy: 14,
};

/** Pre-spawn distance tiers (nm from airport) with altitude ranges */
const ARRIVAL_TIERS = [
  { minDist: 40, maxDist: 50, minAlt: 10000, maxAlt: 12000 },
  { minDist: 30, maxDist: 40, minAlt: 8000, maxAlt: 10000 },
  { minDist: 20, maxDist: 30, minAlt: 7000, maxAlt: 9000 },
  { minDist: 10, maxDist: 18, minAlt: 4000, maxAlt: 6000 },
];

/**
 * ScenarioGenerator spawns traffic into the simulation.
 */
export class ScenarioGenerator {
  private airportData: AirportData;
  private config: SessionConfig;
  private aircraftManager: AircraftManager;
  private flightNumberCounter = 100;
  private lastSpawnTick = 0;
  private usedCallsigns = new Set<string>();
  private hasPreSpawned = false;
  private vfrCounter = 0;

  constructor(
    airportData: AirportData,
    config: SessionConfig,
    aircraftManager: AircraftManager
  ) {
    this.airportData = airportData;
    this.config = config;
    this.aircraftManager = aircraftManager;
  }

  /**
   * Possibly spawn new traffic based on elapsed ticks and density.
   * Call this each tick. timeScale is used to compress spawn intervals so
   * that higher time-scale values produce proportionally more traffic per tick.
   */
  update(tickCount: number, timeScale: number): AircraftState | null {
    // Pre-spawn aircraft on first call
    if (!this.hasPreSpawned) {
      this.hasPreSpawned = true;
      this.preSpawnTraffic();
      this.lastSpawnTick = tickCount;
      return null;
    }

    const opsPerHour = DENSITY_OPS[this.config.density] || 16;
    // Interval in ticks: seconds-between-spawns divided by timeScale.
    // At 28 ops/hour, 1x: 3600/28 = ~129 ticks
    // At 28 ops/hour, 4x: 3600/28/4 = ~32 ticks
    const intervalTicks = Math.max(1, Math.round((3600 / opsPerHour) / timeScale));

    if (tickCount - this.lastSpawnTick < intervalTicks) {
      return null;
    }

    this.lastSpawnTick = tickCount;

    const scenarioType = this.config.scenarioType;

    // VFR traffic chance: only in mixed scenarios, lower for heavy density
    if (scenarioType === 'mixed') {
      const vfrChance = this.config.density === 'heavy' ? 0.05 : 0.15;
      if (Math.random() < vfrChance) {
        return this.spawnVFR();
      }
    }

    // Respect scenario type: only spawn the appropriate category
    let isArrival: boolean;
    if (scenarioType === 'arrivals') {
      isArrival = true;
    } else if (scenarioType === 'departures') {
      isArrival = false;
    } else {
      isArrival = Math.random() < 0.6; // Mixed: 60% arrivals
    }

    if (isArrival) {
      return this.spawnArrival();
    } else {
      return this.spawnDeparture();
    }
  }

  /**
   * Pre-spawn a batch of aircraft at session start, staggered at different
   * distances and altitudes to create an immediately populated scope.
   */
  private preSpawnTraffic(): void {
    const count = DENSITY_INITIAL[this.config.density] || 7;
    const scenarioType = this.config.scenarioType;

    // Decide arrival/departure split
    let arrivalCount: number;
    let departureCount: number;
    if (scenarioType === 'arrivals') {
      arrivalCount = count;
      departureCount = 0;
    } else if (scenarioType === 'departures') {
      arrivalCount = 0;
      departureCount = count;
    } else {
      arrivalCount = Math.ceil(count * 0.65);
      departureCount = count - arrivalCount;
    }

    // Spawn arrivals at staggered distances
    for (let i = 0; i < arrivalCount; i++) {
      const tier = ARRIVAL_TIERS[i % ARRIVAL_TIERS.length];
      this.spawnArrivalAtDistance(tier);
    }

    // Spawn departures at various climb-out points
    for (let i = 0; i < departureCount; i++) {
      this.spawnDepartureClimbout(i);
    }

    // Add 1-2 VFR targets for realism (only in mixed scenarios)
    let vfrCount = 0;
    if (scenarioType === 'mixed') {
      vfrCount = Math.random() < 0.5 ? 1 : 2;
      for (let i = 0; i < vfrCount; i++) {
        this.spawnVFR();
      }
    }

    console.log(
      `[ScenarioGenerator] Pre-spawned ${arrivalCount} arrivals, ${departureCount} departures, ${vfrCount} VFR`
    );
  }

  /**
   * Spawn an arrival at a specific distance tier from the airport.
   */
  private spawnArrivalAtDistance(tier: {
    minDist: number;
    maxDist: number;
    minAlt: number;
    maxAlt: number;
  }): AircraftState {
    const { callsign, typeDesignator } = this.generateCallsign();

    const star = this.pickStar();

    // Get STAR entry position or generate one at the tier distance
    const starEntry = this.getStarEntryPosition(star);
    const bearingFromAirport = initialBearing(this.airportData.position, starEntry);

    // Place aircraft at random distance within tier along the bearing from airport
    const dist = tier.minDist + Math.random() * (tier.maxDist - tier.minDist);
    const position = destinationPoint(this.airportData.position, bearingFromAirport, dist);

    // Altitude within tier range (round to 1000)
    const altSteps = Math.floor((tier.maxAlt - tier.minAlt) / 1000);
    const altitude = tier.minAlt + Math.floor(Math.random() * (altSteps + 1)) * 1000;

    const speed = altitude > 10000 ? 280 : 250;

    // Heading toward airport
    const bearing = initialBearing(position, this.airportData.position);

    const route = star.commonLegs
      .filter(l => l.fix)
      .map(l => l.fix!.id);

    const flightPlan: FlightPlan = {
      departure: 'ZZZZ',
      arrival: this.airportData.icao,
      cruiseAltitude: 35000,
      route,
      sid: null,
      star: star.name,
      runway: this.pickArrivalRunway(),
      squawk: this.aircraftManager.nextSquawk(),
    };

    const ac = this.aircraftManager.spawnAircraft({
      callsign,
      typeDesignator,
      position,
      altitude,
      heading: normalizeHeading(bearing),
      speed,
      flightPlan,
      category: 'arrival',
      flightPhase: 'descent',
    });

    // Set targetAltitude to current altitude so the aircraft maintains its
    // altitude until ATC issues a descent instruction or VNAV takes over.
    ac.targetAltitude = altitude;
    if (star.commonLegs.length > 0) {
      // STAR with altitude constraints: let VNAV manage the descent.
      // clearances.altitude is left null so auto-descent and VNAV both work.
      ac.clearances.descendViaSTAR = true;
      ac.clearances.procedure = star.name;
    } else {
      // No STAR constraints: hold altitude until ATC clears descent.
      ac.clearances.altitude = altitude;
    }

    return ac;
  }

  /**
   * Spawn a departure already climbing out.
   */
  private spawnDepartureClimbout(index: number): AircraftState {
    const { callsign, typeDesignator } = this.generateCallsign();

    const runway = this.pickDepartureRunway();
    const rwyData = this.airportData.runways.find(r => r.id === runway);
    const heading = rwyData?.heading ?? 160;

    // Stagger departures at different distances (3-12nm) and altitudes
    const dist = 3 + index * 3 + Math.random() * 2;
    const startPos = destinationPoint(this.airportData.position, heading, dist);
    const altitude = 1500 + Math.min(index * 1500, 6000) + Math.floor(Math.random() * 5) * 100;

    const sid = this.pickSid();
    const route = sid
      ? sid.commonLegs.filter(l => l.fix).map(l => l.fix!.id)
      : [];

    const flightPlan: FlightPlan = {
      departure: this.airportData.icao,
      arrival: 'ZZZZ',
      cruiseAltitude: 35000,
      route,
      sid: sid?.name ?? null,
      star: null,
      runway,
      squawk: this.aircraftManager.nextSquawk(),
    };

    const ac = this.aircraftManager.spawnAircraft({
      callsign,
      typeDesignator,
      position: startPos,
      altitude,
      heading,
      speed: altitude > 3000 ? 230 : 200,
      flightPlan,
      category: 'departure',
      flightPhase: 'departure',
    });

    // Set departure target altitude so they climb
    ac.targetAltitude = Math.min(flightPlan.cruiseAltitude, 10000);
    if (sid) {
      ac.clearances.climbViaSID = true;
      ac.clearances.procedure = sid.name;
    }

    return ac;
  }

  private spawnArrival(): AircraftState {
    const { callsign, typeDesignator } = this.generateCallsign();

    // Pick a STAR and its entry fix
    const star = this.pickStar();
    const entryFix = this.getStarEntryPosition(star);

    // Entry altitude 10000-15000 (realistic STAR entry altitudes)
    const altitude = 10000 + Math.floor(Math.random() * 6) * 1000;
    const speed = altitude > 10000 ? 280 : 250;

    // Heading toward airport
    const bearing = initialBearing(entryFix, this.airportData.position);

    // Build route from STAR legs
    const route = star.commonLegs
      .filter(l => l.fix)
      .map(l => l.fix!.id);

    const flightPlan: FlightPlan = {
      departure: 'ZZZZ', // Unknown origin
      arrival: this.airportData.icao,
      cruiseAltitude: 35000,
      route,
      sid: null,
      star: star.name,
      runway: this.pickArrivalRunway(),
      squawk: this.aircraftManager.nextSquawk(),
    };

    return this.aircraftManager.spawnAircraft({
      callsign,
      typeDesignator,
      position: entryFix,
      altitude,
      heading: normalizeHeading(bearing),
      speed,
      flightPlan,
      category: 'arrival',
      flightPhase: 'descent',
    });
  }

  private spawnDeparture(): AircraftState {
    const { callsign, typeDesignator } = this.generateCallsign();

    // Departures start at the airport, ready for takeoff
    const runway = this.pickDepartureRunway();
    const rwyData = this.airportData.runways.find(r => r.id === runway);
    const heading = rwyData?.heading ?? 160;

    // Spawn at the runway threshold at airport elevation
    const startPos = rwyData
      ? rwyData.threshold
      : this.airportData.position;
    const altitude = rwyData?.elevation ?? this.airportData.elevation;

    const sid = this.pickSid();
    const route = sid
      ? sid.commonLegs.filter(l => l.fix).map(l => l.fix!.id)
      : [];

    const flightPlan: FlightPlan = {
      departure: this.airportData.icao,
      arrival: 'ZZZZ',
      cruiseAltitude: 35000,
      route,
      sid: sid?.name ?? null,
      star: null,
      runway,
      squawk: this.aircraftManager.nextSquawk(),
    };

    const ac = this.aircraftManager.spawnAircraft({
      callsign,
      typeDesignator,
      position: startPos,
      altitude,
      heading,
      speed: 0,
      flightPlan,
      category: 'departure',
      flightPhase: 'departure',
    });

    // Ground departure: aircraft is on the runway ready for takeoff
    ac.onGround = true;
    ac.targetAltitude = Math.min(flightPlan.cruiseAltitude, 10000);
    ac.targetSpeed = 0;
    if (sid) {
      ac.clearances.climbViaSID = true;
      ac.clearances.procedure = sid.name;
    }

    return ac;
  }

  /**
   * Spawn a VFR aircraft transiting the airspace.
   */
  private spawnVFR(): AircraftState {
    const typeDesignator = pickRandom(VFR_TYPES);

    // Generate N-number callsign
    this.vfrCounter++;
    const nNumber = `N${1000 + this.vfrCounter}${pickRandom(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K'])}`;
    this.usedCallsigns.add(nNumber);

    // VFR altitudes: 3500, 4500, or 5500 (odd thousands + 500 for VFR eastbound,
    // even thousands + 500 for westbound)
    const vfrAltitudes = [3500, 4500, 5500];
    const altitude = pickRandom(vfrAltitudes);

    // Spawn on random edge of airspace at 25-40nm
    const entryBearing = Math.random() * 360;
    const entryDist = 25 + Math.random() * 15;
    const position = destinationPoint(this.airportData.position, entryBearing, entryDist);

    // Fly roughly across the airspace (not directly at airport, offset by 5-20nm)
    const exitBearing = normalizeHeading(entryBearing + 150 + Math.random() * 60);
    const exitDist = 30 + Math.random() * 10;
    const exitPoint = destinationPoint(this.airportData.position, exitBearing, exitDist);
    const heading = initialBearing(position, exitPoint);

    const perf = performanceDB.get(typeDesignator);
    const speed = perf?.speed.typicalCruiseIAS ?? 120;

    const flightPlan: FlightPlan = {
      departure: 'ZZZZ',
      arrival: 'ZZZZ',
      cruiseAltitude: altitude,
      route: [], // VFR - no route
      sid: null,
      star: null,
      runway: null,
      squawk: '1200', // Standard VFR squawk
    };

    return this.aircraftManager.spawnAircraft({
      callsign: nNumber,
      typeDesignator,
      position,
      altitude,
      heading: normalizeHeading(heading),
      speed,
      flightPlan,
      category: 'vfr',
      flightPhase: 'cruise',
    });
  }

  private generateCallsign(): { callsign: string; typeDesignator: string } {
    // Pick airline based on weighted mix
    const airline = this.pickAirline();
    let callsign: string;
    do {
      this.flightNumberCounter++;
      callsign = `${airline}${this.flightNumberCounter}`;
    } while (this.usedCallsigns.has(callsign));
    this.usedCallsigns.add(callsign);

    // Pick aircraft type
    let typeDesignator: string;
    if (CARGO_AIRLINES.includes(airline)) {
      typeDesignator = pickRandom(CARGO_TYPES);
    } else if (REGIONAL_AIRLINES.includes(airline)) {
      typeDesignator = pickRandom(REGIONAL_TYPES);
    } else {
      typeDesignator = pickRandom(MAINLINE_TYPES);
    }

    // Ensure we have performance data
    if (!performanceDB.get(typeDesignator)) {
      typeDesignator = performanceDB.randomType();
    }

    return { callsign, typeDesignator };
  }

  private pickAirline(): string {
    const totalWeight = AIRLINE_MIX.reduce((sum, a) => sum + a.weight, 0);
    let r = Math.random() * totalWeight;
    for (const entry of AIRLINE_MIX) {
      r -= entry.weight;
      if (r <= 0) return entry.icao;
    }
    return AIRLINE_MIX[0].icao;
  }

  private pickStar(): STAR {
    const stars = this.airportData.stars;
    if (stars.length === 0) {
      // Fallback: create a minimal STAR
      return {
        name: 'DIRECT',
        runways: [],
        commonLegs: [],
        enrouteTransitions: [],
        runwayTransitions: [],
      };
    }
    return pickRandom(stars);
  }

  private pickSid() {
    const sids = this.airportData.sids;
    if (sids.length === 0) return null;
    return pickRandom(sids);
  }

  private getStarEntryPosition(star: STAR): Position {
    // Use the first fix of the STAR as the entry point
    if (star.commonLegs.length > 0 && star.commonLegs[0].fix) {
      return star.commonLegs[0].fix.position;
    }

    // Fallback: random point on airspace boundary at ~40nm
    const bearing = Math.random() * 360;
    return destinationPoint(this.airportData.position, bearing, 40);
  }

  private pickArrivalRunway(): string {
    const arrivals = this.config.runwayConfig.arrivalRunways;
    if (arrivals.length > 0) return pickRandom(arrivals);
    if (this.airportData.runways.length > 0) return this.airportData.runways[0].id;
    return '16';
  }

  private pickDepartureRunway(): string {
    const departures = this.config.runwayConfig.departureRunways;
    if (departures.length > 0) return pickRandom(departures);
    if (this.airportData.runways.length > 0) return this.airportData.runways[0].id;
    return '16';
  }
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
