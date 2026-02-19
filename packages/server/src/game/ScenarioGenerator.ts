import type {
  AircraftState,
  AirportData,
  SessionConfig,
  SID,
  STAR,
  Position,
  FlightPhase,
  FlightPlan,
} from '@atc-sim/shared';
import { destinationPoint, normalizeHeading, initialBearing, haversineDistance } from '@atc-sim/shared';
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

/** Common origin/destination airports with positions for bearing computation */
const COMMON_AIRPORTS = [
  { icao: 'KJFK', lat: 40.64, lon: -73.78 },
  { icao: 'KEWR', lat: 40.69, lon: -74.17 },
  { icao: 'KLGA', lat: 40.78, lon: -73.87 },
  { icao: 'KBOS', lat: 42.36, lon: -71.01 },
  { icao: 'KATL', lat: 33.64, lon: -84.43 },
  { icao: 'KORD', lat: 41.97, lon: -87.91 },
  { icao: 'KDFW', lat: 32.90, lon: -97.04 },
  { icao: 'KDCA', lat: 38.85, lon: -77.04 },
  { icao: 'KFLL', lat: 26.07, lon: -80.15 },
  { icao: 'KMCO', lat: 28.43, lon: -81.31 },
  { icao: 'KDEN', lat: 39.86, lon: -104.67 },
  { icao: 'KIAH', lat: 29.98, lon: -95.34 },
  { icao: 'KCLT', lat: 35.21, lon: -80.94 },
  { icao: 'KPHL', lat: 39.87, lon: -75.24 },
  { icao: 'KBWI', lat: 39.18, lon: -76.67 },
  { icao: 'KBDL', lat: 41.94, lon: -72.68 },
  { icao: 'KRDU', lat: 35.88, lon: -78.79 },
  { icao: 'KMIA', lat: 25.79, lon: -80.29 },
];

/** VFR aircraft types (includes bizjets for N-number IFR traffic) */
const VFR_TYPES = ['C172', 'C182', 'SR22', 'C56X', 'CL30'];

/** VFR callsign prefixes (N-numbers) */
const VFR_PREFIXES = ['N'];

/** Density -> operations per hour (steady state) */
const DENSITY_OPS: Record<string, number> = {
  light: 10,
  moderate: 24,
  heavy: 36,
};

/** How many aircraft to spawn in the warm-up phase before settling into normal rate */
const WARM_UP_COUNT: Record<string, number> = {
  light: 2,
  moderate: 3,
  heavy: 5,
};

/** Seconds between spawns during warm-up — spaced to avoid simultaneous STAR merges */
const WARM_UP_INTERVAL_SECS: Record<string, number> = {
  light: 120,
  moderate: 90,
  heavy: 60,
};

/**
 * ScenarioGenerator spawns traffic into the simulation.
 */
/** Minimum seconds between departure spawns to prevent immediate conflicts */
const MIN_DEPARTURE_SEPARATION_SECS = 120;

export class ScenarioGenerator {
  private airportData: AirportData;
  private config: SessionConfig;
  private aircraftManager: AircraftManager;
  private lastSpawnTick = 0;
  private lastDepartureTick = -9999; // far in the past so first departure spawns freely
  private usedCallsigns = new Set<string>();
  private currentTick = 0; // updated at start of update(); used by spawn helpers
  private totalSpawned = 0;
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
    this.currentTick = tickCount;
    const warmupCount = WARM_UP_COUNT[this.config.density] ?? 3;
    const warmupIntervalSecs = WARM_UP_INTERVAL_SECS[this.config.density] ?? 50;
    const opsPerHour = DENSITY_OPS[this.config.density] || 16;

    // Warm-up phase: first few aircraft spawn on a shorter interval to ease the
    // player in; after that, settle into the normal density-based rate.
    const inWarmup = this.totalSpawned < warmupCount;
    const intervalSecs = inWarmup ? warmupIntervalSecs : (3600 / opsPerHour);
    const intervalTicks = Math.max(1, Math.round(intervalSecs / timeScale));

    if (tickCount - this.lastSpawnTick < intervalTicks) {
      return null;
    }

    this.lastSpawnTick = tickCount;

    const scenarioType = this.config.scenarioType;

    // VFR traffic chance: only in mixed scenarios, lower for heavy density
    if (scenarioType === 'mixed' && !inWarmup) {
      const vfrChance = this.config.density === 'heavy' ? 0.05 : 0.15;
      if (Math.random() < vfrChance) {
        const vfr = this.spawnVFR();
        this.totalSpawned++;
        return vfr;
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

    // Enforce minimum departure separation to prevent simultaneous takeoffs.
    // If a departure is due but the runway hasn't cleared yet, spawn an arrival
    // instead (or skip if arrivals-only scenario is not applicable).
    const minDepTicks = Math.max(1, Math.round(MIN_DEPARTURE_SEPARATION_SECS / timeScale));
    if (!isArrival && tickCount - this.lastDepartureTick < minDepTicks) {
      if (scenarioType === 'departures') {
        return null; // Wait for runway to clear
      }
      isArrival = true; // Swap to an arrival instead
    }

    const ac = isArrival ? this.spawnArrival() : this.spawnDeparture();
    if (!isArrival && ac) {
      this.lastDepartureTick = tickCount;
    }
    if (ac) this.totalSpawned++;
    return ac;
  }

  /**
   * Spawn an arrival at a specific distance tier from the airport.
   * Used by the playtest harness; not called during normal gameplay.
   */
  spawnArrivalAtDistance(tier: {
    minDist: number;
    maxDist: number;
    minAlt: number;
    maxAlt: number;
  }): AircraftState {
    const { callsign, typeDesignator } = this.generateCallsign();

    const star = this.pickStar();

    // Get STAR entry position or generate one at the tier distance
    const { position: starEntry, transitionName } = this.pickStarTransition(star);
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

    const arrivalRunway = this.pickArrivalRunway();
    const route = this.getStarRoute(star, arrivalRunway, transitionName);

    const flightPlan: FlightPlan = {
      departure: pickRandom(COMMON_AIRPORTS).icao,
      arrival: this.airportData.icao,
      cruiseAltitude: 35000,
      route,
      sid: null,
      star: star.name,
      runway: arrivalRunway,
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

    // Set targetAltitude and clearances.altitude to spawn altitude.
    // clearances.altitude represents the altitude center assigned before
    // handing off to approach — visible on flight strips and data blocks.
    ac.targetAltitude = altitude;
    ac.clearances.altitude = altitude;
    if (route.length > 0) {
      // STAR has navigable legs: let VNAV manage altitude constraints
      ac.clearances.descendViaSTAR = true;
      ac.clearances.procedure = star.name;
    }

    // Center pre-offers handoff for all arrivals — controller must accept
    // before the aircraft checks in on approach frequency.
    ac.inboundHandoff = 'offered';
    ac.inboundHandoffOfferedAt = this.currentTick;

    return ac;
  }

  private spawnArrival(): AircraftState | null {
    // 35% chance of a vectored arrival from a non-STAR direction (N/NE/E/SE)
    // to fill in the eastern semicircle not covered by KRIC's three STARs (SW/W/NW).
    if (Math.random() < 0.35) {
      return this.spawnVectoredArrival();
    }

    const { callsign, typeDesignator } = this.generateCallsign();

    // Pick a STAR, avoiding STARs with traffic too close to the entry fix
    const star = this.pickDeconflictedStar();
    if (!star) return this.spawnVectoredArrival(); // All STARs congested — vector in instead

    // Pick enroute transition randomly (gives KELCE *or* NEAVL for DUCXS5, etc.)
    const { position: entryFix, transitionName } = this.pickStarTransition(star);

    // Entry altitude 8000-12000 (realistic TRACON handoff altitudes for KRIC area)
    const altitude = 8000 + Math.floor(Math.random() * 3) * 1000;
    const speed = altitude > 10000 ? 280 : 250;

    // Heading toward airport
    const bearing = initialBearing(entryFix, this.airportData.position);

    const arrivalRunway = this.pickArrivalRunway();

    // Build full route: enroute transition legs + common legs + runway transition legs
    const route = this.getStarRoute(star, arrivalRunway, transitionName);

    const flightPlan: FlightPlan = {
      departure: pickRandom(COMMON_AIRPORTS).icao,
      arrival: this.airportData.icao,
      cruiseAltitude: 35000,
      route,
      sid: null,
      star: star.name,
      runway: arrivalRunway,
      squawk: this.aircraftManager.nextSquawk(),
    };

    const ac = this.aircraftManager.spawnAircraft({
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

    // Center-assigned altitude: visible on flight strips and data blocks
    ac.targetAltitude = altitude;
    ac.clearances.altitude = altitude;
    if (route.length > 0) {
      // STAR has navigable legs: let VNAV manage altitude constraints
      ac.clearances.descendViaSTAR = true;
      ac.clearances.procedure = star.name;
    }

    // Set expected approach based on session preference so the data tag and
    // briefing reflect what approach type the controller intends to use.
    ac.clearances.expectedApproach = this.resolveExpectedApproach(arrivalRunway);

    // Center pre-offers handoff for all arrivals — controller must accept
    // before the aircraft checks in on approach frequency.
    ac.inboundHandoff = 'offered';
    ac.inboundHandoffOfferedAt = this.currentTick;

    return ac;
  }

  /**
   * Spawn a vectored arrival from a direction not covered by published STARs.
   * KRIC STARs cover SW/W/NW — this fills in N/NE/E/SE/S.
   * Tries up to 4 positions; returns null if no clear slot is found.
   */
  private spawnVectoredArrival(): AircraftState | null {
    // Bearing ranges not served by KRIC STARs (approx SW=200-250, W=260-290, NW=300-350)
    // Fill: N (350-020), NE (020-080), E (080-140), S/SE (140-200)
    const nonStarSectors: [number, number][] = [
      [350, 20],
      [20, 80],
      [80, 140],
      [140, 200],
    ];

    const existing = this.aircraftManager.getAll();
    const MIN_SPAWN_SEPARATION_NM = 15;

    let position: ReturnType<typeof destinationPoint> | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const [minB, maxB] = pickRandom(nonStarSectors);
      const span = maxB > minB ? maxB - minB : maxB + 360 - minB;
      const bearing = normalizeHeading(minB + Math.random() * span);
      const dist = 35 + Math.random() * 10; // 35-45nm
      const candidate = destinationPoint(this.airportData.position, bearing, dist);
      const tooClose = existing.some(ac => haversineDistance(ac.position, candidate) < MIN_SPAWN_SEPARATION_NM);
      if (!tooClose) {
        position = candidate;
        break;
      }
    }
    if (!position) return null; // No clear spawn slot this cycle

    const { callsign, typeDesignator } = this.generateCallsign();
    const altitude = 8000 + Math.floor(Math.random() * 5) * 1000; // 8000-12000
    const heading = initialBearing(position, this.airportData.position);
    const arrivalRunway = this.pickArrivalRunway();

    const flightPlan: FlightPlan = {
      departure: pickRandom(COMMON_AIRPORTS).icao,
      arrival: this.airportData.icao,
      cruiseAltitude: 35000,
      route: [], // No STAR — controller will vector to final
      sid: null,
      star: null,
      runway: arrivalRunway,
      squawk: this.aircraftManager.nextSquawk(),
    };

    const ac = this.aircraftManager.spawnAircraft({
      callsign,
      typeDesignator,
      position,
      altitude,
      heading: normalizeHeading(heading),
      speed: altitude > 10000 ? 280 : 250,
      flightPlan,
      category: 'arrival',
      flightPhase: 'descent',
    });

    ac.targetAltitude = altitude;
    ac.clearances.altitude = altitude;

    // Set expected approach based on session preference.
    ac.clearances.expectedApproach = this.resolveExpectedApproach(arrivalRunway);

    // Center pre-offers handoff for all arrivals — controller must accept
    // before the aircraft checks in on approach frequency.
    ac.inboundHandoff = 'offered';
    ac.inboundHandoffOfferedAt = this.currentTick;

    return ac;
  }

  private spawnDeparture(): AircraftState {
    const { callsign, typeDesignator } = this.generateCallsign();

    // Departures start at the airport, ready for takeoff
    const runway = this.pickDepartureRunway();
    const rwyData = this.airportData.runways.find(r => r.id === runway);
    // Use actual geographic bearing (threshold→end) so the departure heading
    // matches the rendered runway line exactly, eliminating centerline offset.
    const heading = rwyData
      ? initialBearing(rwyData.threshold, rwyData.end)
      : 160;

    // Spawn at the runway threshold at airport elevation
    const startPos = rwyData
      ? rwyData.threshold
      : this.airportData.position;
    const altitude = rwyData?.elevation ?? this.airportData.elevation;

    // Pick destination first, then choose SID based on direction of flight
    const dest = pickRandom(COMMON_AIRPORTS);
    const destBearing = initialBearing(this.airportData.position, { lat: dest.lat, lon: dest.lon });
    const sid = this.pickSidForDirection(destBearing);
    const route = sid
      ? this.getSidRoute(sid, runway)
      : [];

    const flightPlan: FlightPlan = {
      departure: this.airportData.icao,
      arrival: dest.icao,
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
    ac.targetSpeed = 0;
    // Use SID top altitude if defined, else default to airport elevation + 4000ft
    // rounded to nearest 1000 (works for both sea-level and mountainous airports)
    const airportElev = this.airportData.elevation ?? 0;
    const defaultTopAlt = Math.round((airportElev + 4000) / 1000) * 1000;
    const sidTopAlt = sid?.topAltitude ?? defaultTopAlt;
    ac.targetAltitude = Math.min(flightPlan.cruiseAltitude, sidTopAlt);
    // Pre-assign initial climb altitude (from clearance delivery) so the data
    // block shows it and the pilot includes it in their check-in call.
    ac.clearances.altitude = ac.targetAltitude;
    if (sid) {
      ac.clearances.climbViaSID = true;
      ac.clearances.procedure = sid.name;
      // Extract VA/VI/VD departure legs for initial heading guidance
      const rwyTrans = sid.runwayTransitions.find(
        t => t.name === `RW${runway}` || t.name === runway
      );
      if (rwyTrans) {
        const depLegs = rwyTrans.legs
          .filter(l => (l.legType === 'VA' || l.legType === 'VI' || l.legType === 'VD') && l.course !== undefined)
          .map(l => {
            const ac = l.altitudeConstraint;
            const altConstraint = ac
              ? (ac.type === 'between' ? ac.min : ac.altitude)
              : undefined;
            return {
              legType: l.legType as 'VA' | 'VI' | 'VD',
              course: l.course!,
              altConstraint,
              turnDirection: l.turnDirection,
            };
          });
        if (depLegs.length > 0) {
          ac.sidLegs = depLegs;
          ac.sidLegIdx = 0;
        }
      }
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
    // Generate realistic-looking flight numbers: pick from random ranges to avoid
    // sequential clusters (e.g. 101,102,103). Use ranges typical for airline ops.
    const ranges = [[100, 999], [1000, 9999]] as const;
    const useShort = Math.random() < 0.7; // 70% chance of 3-digit
    const [lo, hi] = useShort ? ranges[0] : ranges[1];
    let attempts = 0;
    do {
      const num = lo + Math.floor(Math.random() * (hi - lo + 1));
      callsign = `${airline}${num}`;
      attempts++;
    } while (this.usedCallsigns.has(callsign) && attempts < 200);
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

  /**
   * Pick a STAR that won't create an immediate conflict.
   * Checks two things:
   *  1. No aircraft (any STAR or vectored) within 15nm of this STAR's entry fix.
   *  2. The inner approach corridor (within 30nm of airport) has fewer than 3 arrivals,
   *     so all STARs merging at the same common fix don't stack up simultaneously.
   */
  private pickDeconflictedStar(): STAR | null {
    const stars = this.airportData.stars;
    if (stars.length === 0) return null;

    const existing = this.aircraftManager.getAll();
    const arrivals = existing.filter(ac => ac.category === 'arrival');
    const MIN_ENTRY_SPACING_NM = 15;
    const APPROACH_CORRIDOR_NM = 30;
    const MAX_CORRIDOR_ARRIVALS = 2;

    // Don't spawn if the approach corridor is already saturated.
    // All KRIC STARs share a common path — adding more just creates merge conflicts.
    const corridorCount = arrivals.filter(
      ac => haversineDistance(ac.position, this.airportData.position) < APPROACH_CORRIDOR_NM
    ).length;
    if (corridorCount >= MAX_CORRIDOR_ARRIVALS) return null;

    // Shuffle STARs to avoid always picking the same one
    const shuffled = [...stars].sort(() => Math.random() - 0.5);

    for (const star of shuffled) {
      const entryFix = this.getStarEntryPosition(star);
      let tooClose = false;

      // Check against ALL arrivals (not just same-STAR) near the entry fix
      for (const ac of arrivals) {
        const dist = haversineDistance(ac.position, entryFix);
        if (dist < MIN_ENTRY_SPACING_NM) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) return star;
    }

    // All STARs congested — skip this spawn cycle
    return null;
  }

  private pickSid() {
    const sids = this.airportData.sids;
    if (sids.length === 0) return null;
    return pickRandom(sids);
  }

  /**
   * Get the terminal (last) fix position of a SID.
   * Checks commonLegs in reverse, then falls back to the last fix in any runway transition.
   */
  private getSidTerminalPosition(sid: SID): Position | null {
    // Check commonLegs in reverse for the last fix with a position
    for (let i = sid.commonLegs.length - 1; i >= 0; i--) {
      if (sid.commonLegs[i].fix) {
        return sid.commonLegs[i].fix!.position;
      }
    }
    // Fallback: check runway transitions
    for (const trans of sid.runwayTransitions) {
      for (let i = trans.legs.length - 1; i >= 0; i--) {
        if (trans.legs[i].fix) {
          return trans.legs[i].fix!.position;
        }
      }
    }
    return null;
  }

  /**
   * Pick the SID whose terminal fix bearing best matches the destination bearing.
   */
  private pickSidForDirection(destBearing: number): SID | null {
    const sids = this.airportData.sids;
    if (sids.length === 0) return null;

    let bestSid: SID | null = null;
    let bestDiff = Infinity;

    for (const sid of sids) {
      const termPos = this.getSidTerminalPosition(sid);
      if (!termPos) continue;
      const sidBearing = initialBearing(this.airportData.position, termPos);
      const diff = Math.abs(((destBearing - sidBearing + 540) % 360) - 180);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSid = sid;
      }
    }

    return bestSid ?? pickRandom(sids);
  }

  /** Extract route fixes from a SID, falling back to runway transitions if commonLegs is empty */
  private getSidRoute(sid: SID, runway: string): string[] {
    const route = sid.commonLegs.filter(l => l.fix).map(l => l.fix!.id);
    if (route.length > 0) return route;
    const rwyTrans = sid.runwayTransitions.find(
      t => t.name === `RW${runway}` || t.name === runway
    );
    if (rwyTrans) return rwyTrans.legs.filter(l => l.fix).map(l => l.fix!.id);
    return [];
  }

  /**
   * Randomly pick an enroute transition from a STAR and return the entry position
   * and transition name. Falls back to commonLegs[0] if no enroute transitions exist.
   */
  private pickStarTransition(star: STAR): { position: Position; transitionName: string | null } {
    if (star.enrouteTransitions.length > 0) {
      const trans = pickRandom(star.enrouteTransitions);
      const firstLeg = trans.legs.find(l => l.fix);
      if (firstLeg?.fix) {
        return { position: firstLeg.fix.position, transitionName: trans.name };
      }
    }
    // Fallback to first commonLeg fix
    if (star.commonLegs.length > 0 && star.commonLegs[0].fix) {
      return { position: star.commonLegs[0].fix.position, transitionName: null };
    }
    // Last resort: random point at ~40nm
    const bearing = Math.random() * 360;
    return { position: destinationPoint(this.airportData.position, bearing, 40), transitionName: null };
  }

  /** Legacy single-position getter used by spawnArrivalAtDistance */
  private getStarEntryPosition(star: STAR): Position {
    return this.pickStarTransition(star).position;
  }

  /**
   * Build the ordered list of route fix IDs for a STAR.
   * Combines enroute transition legs → common legs → runway transition legs,
   * deduplicating any fix that appears at the join point between sections.
   */
  private getStarRoute(star: STAR, runway: string, transitionName?: string | null): string[] {
    // Resolve the selected enroute transition (if any)
    const enrouteTrans = transitionName
      ? star.enrouteTransitions.find(t => t.name === transitionName) ?? null
      : star.enrouteTransitions.length === 1 ? star.enrouteTransitions[0] : null;

    const enrouteLegs = enrouteTrans
      ? enrouteTrans.legs.filter(l => l.fix).map(l => l.fix!.id)
      : [];

    const commonLegs = star.commonLegs.filter(l => l.fix).map(l => l.fix!.id);

    // Find matching runway transition
    const rwyTrans = star.runwayTransitions.find(
      t => t.name === `RW${runway}` || t.name === runway
    );
    const rwyLegs = rwyTrans ? rwyTrans.legs.filter(l => l.fix).map(l => l.fix!.id) : [];

    // Merge: enroute → common → runway, deduplicating shared boundary fixes
    const dedupAppend = (base: string[], next: string[]): string[] => {
      if (next.length === 0) return base;
      const start = base.length > 0 && next[0] === base[base.length - 1] ? 1 : 0;
      return [...base, ...next.slice(start)];
    };

    let route = enrouteLegs;
    route = dedupAppend(route, commonLegs);
    route = dedupAppend(route, rwyLegs);
    return route;
  }

  private pickArrivalRunway(): string {
    const arrivals = this.config.runwayConfig.arrivalRunways;
    if (arrivals.length > 0) return pickRandom(arrivals);
    if (this.airportData.runways.length > 0) return this.airportData.runways[0].id;
    return '16';
  }

  /**
   * Resolve the expected approach type for a given runway based on current weather.
   * In VMC (ceiling ≥ 1000, vis ≥ 3): visual approaches are valid — controller assigns
   * approach type via radio during the session, so we default to VISUAL here.
   * In IMC: use best available instrument approach (ILS if available, else RNAV).
   */
  private resolveExpectedApproach(runwayId: string): { type: 'ILS' | 'RNAV' | 'VISUAL'; runway: string } {
    const wx = this.config.weather;
    const ceiling = wx.ceiling ?? Infinity;
    const vis = wx.visibility;
    const rwy = this.airportData.runways.find(r => r.id === runwayId);

    // VMC — visual approaches valid, controller assigns type via radio
    if (ceiling >= 1000 && vis >= 3) {
      return { type: 'VISUAL', runway: runwayId };
    }
    // IMC — best available instrument approach
    if (rwy?.ilsAvailable) {
      return { type: 'ILS', runway: runwayId };
    }
    return { type: 'RNAV', runway: runwayId };
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
