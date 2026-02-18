import type {
  AircraftState,
  ATCCommand,
  ControllerCommand,
  RadioTransmission,
  AirportData,
  HandoffCommand,
  RequestTrafficSightCommand,
} from '@atc-sim/shared';
import { haversineDistance, initialBearing, headingDifference } from '@atc-sim/shared';
import { AircraftManager } from '../engine/AircraftManager.js';
import { PilotAI } from '../ai/PilotAI.js';
import { performanceDB } from '../data/PerformanceDB.js';

/** TRACON airspace vertical limits */
const TRACON_CEILING = 17000; // ft MSL - typical TRACON ceiling
const TRACON_FLOOR = 0; // ft MSL (surface for departures)
/** Approach gate: at least 5nm from runway threshold */
const APPROACH_GATE_NM = 5;
/** Minimum intercept distance: 2nm outside the approach gate */
const MIN_INTERCEPT_OUTSIDE_GATE_NM = 2;
/** Maximum localizer intercept angle (degrees) per FAA 7110.65 5-9-2 */
const MAX_INTERCEPT_ANGLE = 30;
/** Glideslope descent rate: approximately 300ft per nm at 3 degrees */
const GS_FT_PER_NM = 300;

export interface CommandResult {
  success: boolean;
  callsign: string;
  rawText: string;
  error?: string;
  readback?: RadioTransmission;
  /** True when the pilot should say "unable" on the radio (e.g. bad frequency) */
  pilotUnable?: boolean;
}

/** Weather conditions for validation */
export interface WeatherConditions {
  ceiling: number | null; // ft AGL, null = clear
  visibility: number;     // statute miles
}

/**
 * CommandExecutor validates and queues commands for pilot execution.
 */
export class CommandExecutor {
  private airportData: AirportData | null = null;
  private weather: WeatherConditions = { ceiling: null, visibility: 10 };

  constructor(
    private aircraftManager: AircraftManager,
    private pilotAI: PilotAI
  ) {}

  setAirportData(data: AirportData): void {
    this.airportData = data;
  }

  setWeather(weather: WeatherConditions): void {
    this.weather = weather;
  }

  /**
   * Execute a parsed controller command.
   * Validates feasibility, queues with pilot delay, and returns result.
   */
  execute(command: ControllerCommand, simTime: number): CommandResult {
    // Find target aircraft
    const ac = this.aircraftManager.getByCallsign(command.callsign);
    if (!ac) {
      return {
        success: false,
        callsign: command.callsign,
        rawText: command.rawText,
        error: `Aircraft ${command.callsign} not found`,
      };
    }

    // Validate each command (pass full list so approach can see sibling heading)
    for (const cmd of command.commands) {
      const validation = this.validate(ac, cmd, command.commands);
      if (!validation.valid) {
        return {
          success: false,
          callsign: command.callsign,
          rawText: command.rawText,
          error: validation.reason,
          pilotUnable: validation.pilotUnable,
        };
      }
    }

    // Radar handoff is an ATC-to-ATC data-link operation — execute immediately,
    // no pilot delay and no pilot radio readback.
    const hasRadarHandoff = command.commands.some(c => c.type === 'radarHandoff');
    if (hasRadarHandoff) {
      ac.radarHandoffState = 'offered';
      ac.radarHandoffOfferedAt = simTime;
      return { success: true, callsign: command.callsign, rawText: command.rawText };
    }

    // Sight query commands are executed inline (no pilot queue delay):
    // controller asks immediately, pilot response is handled in PilotAI.update() ticks.
    const hasSightQuery = command.commands.some(
      c => c.type === 'requestFieldSight' || c.type === 'requestTrafficSight'
    );
    if (hasSightQuery) {
      const currentTick = Math.floor(simTime / 1000);
      for (const cmd of command.commands) {
        if (cmd.type === 'requestFieldSight') {
          ac.visualSight = {
            state: 'queried',
            queriedAtTick: currentTick,
            responseDelay: 3 + Math.floor(Math.random() * 4), // 3–6 ticks
          };
        } else if (cmd.type === 'requestTrafficSight') {
          ac.visualSight = {
            state: 'queried',
            queriedAtTick: currentTick,
            responseDelay: 3 + Math.floor(Math.random() * 4),
            trafficCallsign: (cmd as RequestTrafficSightCommand).trafficCallsign,
          };
        }
      }
      return {
        success: true,
        callsign: command.callsign,
        rawText: command.rawText,
      };
    }

    // Queue with pilot AI (adds delay + enqueues readback in RadioComms queue)
    this.pilotAI.issueCommand(ac, command.commands, simTime);

    return {
      success: true,
      callsign: command.callsign,
      rawText: command.rawText,
      // readback is now deferred — delivered via pilotAI.update() drain
    };
  }

  private validate(
    ac: AircraftState,
    cmd: ATCCommand,
    allCmds: ATCCommand[] = []
  ): { valid: boolean; reason?: string; pilotUnable?: boolean } {
    const perf = performanceDB.getOrDefault(ac.typeDesignator);

    switch (cmd.type) {
      case 'altitude': {
        if (cmd.altitude < 0 || cmd.altitude > perf.ceiling) {
          return {
            valid: false,
            reason: `Unable, ${cmd.altitude}ft is outside operating limits`,
          };
        }
        // Enforce TRACON airspace ceiling
        const traconCeiling = this.airportData?.tracon?.ceiling ?? TRACON_CEILING;
        if (cmd.altitude > traconCeiling) {
          const fl = Math.round(traconCeiling / 100);
          return {
            valid: false,
            reason: `Unable, ${cmd.altitude}ft exceeds TRACON airspace ceiling FL${fl}. Hand off to Center first.`,
          };
        }
        break;
      }
      case 'heading': {
        if (cmd.heading < 1 || cmd.heading > 360) {
          return {
            valid: false,
            reason: `Invalid heading ${cmd.heading}`,
          };
        }
        break;
      }
      case 'speed': {
        if (cmd.speed !== null) {
          if (cmd.speed < perf.speed.vminFlaps || cmd.speed > perf.speed.vmo) {
            return {
              valid: false,
              reason: `Unable, speed ${cmd.speed}kt is outside limits (${perf.speed.vminFlaps}-${perf.speed.vmo})`,
            };
          }
        }
        break;
      }
      case 'approach': {
        if (this.airportData) {
          const runway = this.airportData.runways.find(
            r => r.id === cmd.runway
          );
          if (!runway) {
            return {
              valid: false,
              reason: `Runway ${cmd.runway} not found`,
            };
          }
          if (cmd.approachType === 'ILS' && !runway.ilsAvailable) {
            return {
              valid: false,
              reason: `No ILS available for runway ${cmd.runway}`,
            };
          }

          // FAA 7110.65 5-9-1: Distance check - aircraft must be far enough out
          const distToThreshold = haversineDistance(ac.position, runway.threshold);
          const minDist = APPROACH_GATE_NM + MIN_INTERCEPT_OUTSIDE_GATE_NM; // ~7nm

          if (cmd.approachType !== 'VISUAL' && distToThreshold < APPROACH_GATE_NM) {
            return {
              valid: false,
              reason: `${ac.callsign} is inside the approach gate (${distToThreshold.toFixed(1)}nm from threshold). Must be at least ${APPROACH_GATE_NM}nm out.`,
            };
          }

          // FAA 7110.65 5-9-2: Intercept angle check for ILS/RNAV vectors to final.
          // If this clearance includes a heading command (compound: "r130, ci16"),
          // use that new heading as the intercept heading — it hasn't been applied
          // to the aircraft yet but it IS the controller's intended intercept heading.
          if (cmd.approachType === 'ILS' || cmd.approachType === 'RNAV') {
            const locCourse = runway.ilsCourse ?? runway.heading;
            const siblingHeading = allCmds.find(c => c.type === 'heading');
            const effectiveHeading = siblingHeading
              ? (siblingHeading as { heading: number }).heading
              : (ac.clearances.heading ?? ac.heading);
            const interceptAngle = Math.abs(headingDifference(effectiveHeading, locCourse));

            // Reject only extreme angles (> 90°) where the aircraft is clearly
            // not on any reasonable intercept heading. The FlightPlanExecutor
            // will handle the actual intercept geometry.
            if (distToThreshold < 20 && interceptAngle > 90) {
              return {
                valid: false,
                reason: `Intercept angle is ${Math.round(interceptAngle)}°. Aircraft heading is not compatible with localizer intercept.`,
              };
            }
          }

          // FAA 7110.65 5-9-1: Altitude check for precision approaches.
          if (cmd.approachType === 'ILS') {
            const gsAltAtPosition = runway.elevation + (distToThreshold * GS_FT_PER_NM);

            // Reject if impossibly high for glideslope intercept
            if (ac.altitude > gsAltAtPosition + 3000 && distToThreshold < 8) {
              return {
                valid: false,
                reason: `${ac.callsign} is at ${Math.round(ac.altitude)}ft, glideslope at this distance is ~${Math.round(gsAltAtPosition)}ft. Descend aircraft before clearing approach.`,
              };
            }

            // FAA 7110.65 5-9-2: When vectoring aircraft above the glideslope,
            // controller MUST issue a "maintain X until established" restriction.
            // A sibling altitude command (e.g. "dm 3000 ci16") satisfies this.
            const siblingAlt = allCmds.find(c => c.type === 'altitude');
            if (ac.altitude > gsAltAtPosition + 500 && !cmd.maintainUntilEstablished && !siblingAlt) {
              const suggestedAlt = Math.round((ac.clearances.altitude ?? ac.altitude) / 100) * 100;
              return {
                valid: false,
                reason: `Altitude restriction required per 7110.65 5-9-2. Include: "maintain ${suggestedAlt} until established, cleared ILS runway ${cmd.runway}"`,
              };
            }
            // If a sibling altitude command is present, apply it as maintainUntilEstablished
            if (siblingAlt && !cmd.maintainUntilEstablished) {
              cmd.maintainUntilEstablished = (siblingAlt as { altitude: number }).altitude;
            }
          }

          // Visual approach weather check per FAA 7110.65 7-4-2/7-4-3:
          // Airport must be VFR: ceiling >= 1000ft AGL, visibility >= 3 SM
          if (cmd.approachType === 'VISUAL') {
            const isIMC = (this.weather.ceiling !== null && this.weather.ceiling < 1000) ||
                          this.weather.visibility < 3;
            if (isIMC) {
              const ceilStr = this.weather.ceiling !== null ? `${this.weather.ceiling}ft` : 'clear';
              return {
                valid: false,
                reason: `Unable visual approach. Weather below VFR minimums (ceiling ${ceilStr}, visibility ${this.weather.visibility}SM). Need ceiling 1000ft+ and visibility 3SM+.`,
              };
            }
            // Gate: aircraft must have field or traffic in sight before cv<rwy>
            const sight = ac.visualSight;
            if (!sight || (sight.state !== 'fieldSighted' && sight.state !== 'trafficSighted')) {
              const hint = sight?.state === 'queried'
                ? `Waiting for ${ac.callsign} to respond — try again shortly.`
                : `Use "rfs" to ask ${ac.callsign} to report field in sight, or "rts <callsign>" for traffic in sight.`;
              return {
                valid: false,
                reason: `${ac.callsign} has not reported field or traffic in sight. ${hint}`,
              };
            }
          }
        }
        break;
      }
      case 'descendViaSTAR': {
        if (ac.category !== 'arrival' && ac.category !== 'overflight') {
          return {
            valid: false,
            reason: `${ac.callsign} is a departure — use "climb via the SID" instead`,
          };
        }
        if (!ac.flightPlan.star) {
          return {
            valid: false,
            reason: `${ac.callsign} has no STAR assigned — issue a direct or altitude clearance instead`,
          };
        }
        break;
      }
      case 'climbViaSID': {
        if (ac.category !== 'departure') {
          return {
            valid: false,
            reason: `${ac.callsign} is an arrival — use "descend via the STAR" instead`,
          };
        }
        if (!ac.flightPlan.sid) {
          return {
            valid: false,
            reason: `${ac.callsign} has no SID assigned — issue a direct or altitude clearance instead`,
          };
        }
        break;
      }
      case 'radarHandoff': {
        if (ac.handingOff) {
          return { valid: false, reason: `${ac.callsign} already handed off` };
        }
        if (ac.radarHandoffState === 'offered' || ac.radarHandoffState === 'accepted') {
          return { valid: false, reason: `Radar handoff already ${ac.radarHandoffState} for ${ac.callsign}` };
        }
        break;
      }
      case 'requestFieldSight': {
        if (ac.category !== 'arrival' && ac.category !== 'overflight') {
          return { valid: false, reason: `${ac.callsign} is not an arrival` };
        }
        if (ac.clearances.approach?.type === 'VISUAL') {
          return { valid: false, reason: `${ac.callsign} is already cleared for visual approach` };
        }
        if (ac.visualSight?.state === 'queried') {
          return { valid: false, reason: `${ac.callsign} is already reporting field in sight — wait for response` };
        }
        if (ac.visualSight?.state === 'fieldSighted') {
          return { valid: false, reason: `${ac.callsign} already has field in sight — clear for visual approach` };
        }
        break;
      }
      case 'requestTrafficSight': {
        if (ac.category !== 'arrival' && ac.category !== 'overflight') {
          return { valid: false, reason: `${ac.callsign} is not an arrival` };
        }
        if (ac.clearances.approach?.type === 'VISUAL') {
          return { valid: false, reason: `${ac.callsign} is already cleared for visual approach` };
        }
        const traffic = this.aircraftManager.getByCallsign(cmd.trafficCallsign);
        if (!traffic) {
          return { valid: false, reason: `Traffic ${cmd.trafficCallsign} not found` };
        }
        if (ac.visualSight?.state === 'queried') {
          return { valid: false, reason: `${ac.callsign} is already looking for traffic — wait for response` };
        }
        if (ac.visualSight?.state === 'trafficSighted') {
          return { valid: false, reason: `${ac.callsign} already has traffic in sight — clear for visual approach` };
        }
        break;
      }
      case 'handoff': {
        if (ac.handingOff) {
          return {
            valid: false,
            reason: `${ac.callsign} is already being handed off`,
          };
        }
        // Gate: center/departure handoffs require prior radar handoff acceptance
        const facilityFromCmd = cmd.facility;
        const facilityNeedsRadarHandoff = facilityFromCmd === 'center' || facilityFromCmd === 'departure';
        if (facilityNeedsRadarHandoff && ac.radarHandoffState !== 'accepted') {
          return {
            valid: false,
            reason: `Radar handoff not accepted for ${ac.callsign}. Click data block to initiate radar handoff first.`,
          };
        }
        // Resolve facility from frequency when not explicitly stated
        if (cmd.facility === null) {
          const resolved = this.resolveFacility(cmd.frequency);
          if (!resolved) {
            return {
              valid: false,
              reason: `Unable, ${cmd.frequency.toFixed(2)} is not a recognized frequency`,
              pilotUnable: true,
            };
          }
          cmd.facility = resolved;
        }
        break;
      }
    }

    // If aircraft has landed, most commands are invalid
    if (ac.flightPhase === 'landed') {
      return { valid: false, reason: `${ac.callsign} has landed` };
    }

    // If aircraft is being handed off, reject further commands
    if (ac.handingOff && cmd.type !== 'handoff') {
      return { valid: false, reason: `${ac.callsign} has been handed off` };
    }

    return { valid: true };
  }

  /** Look up which facility a frequency belongs to using airport data */
  private resolveFacility(freq: number): HandoffCommand['facility'] {
    if (!this.airportData) return null;
    const freqs = this.airportData.frequencies;
    // Match within ±0.05 MHz to allow for minor float imprecision
    const near = (list: number[]) => list.some(f => Math.abs(f - freq) < 0.05);
    if (near(freqs.tower)) return 'tower';
    if (near(freqs.ground)) return 'ground';
    if (near(freqs.center)) return 'center';
    if (near(freqs.departure)) return 'departure';
    if (near(freqs.approach)) return 'approach';
    return null;
  }
}
