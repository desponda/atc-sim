import type {
  AircraftState,
  ATCCommand,
  ControllerCommand,
  RadioTransmission,
  AirportData,
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

    // Validate each command
    for (const cmd of command.commands) {
      const validation = this.validate(ac, cmd);
      if (!validation.valid) {
        return {
          success: false,
          callsign: command.callsign,
          rawText: command.rawText,
          error: validation.reason,
        };
      }
    }

    // Queue with pilot AI (adds delay + generates readback)
    const readback = this.pilotAI.issueCommand(ac, command.commands, simTime);

    return {
      success: true,
      callsign: command.callsign,
      rawText: command.rawText,
      readback,
    };
  }

  private validate(
    ac: AircraftState,
    cmd: ATCCommand
  ): { valid: boolean; reason?: string } {
    const perf = performanceDB.getOrDefault(ac.typeDesignator);

    switch (cmd.type) {
      case 'altitude': {
        if (cmd.altitude < 0 || cmd.altitude > perf.ceiling) {
          return {
            valid: false,
            reason: `Unable, ${cmd.altitude}ft is outside operating limits`,
          };
        }
        // Note: TRACON ceiling is advisory. Controllers may issue altitudes above
        // the TRACON ceiling when coordinating with center or for initial descent
        // instructions. The aircraft performance ceiling check above is sufficient.
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
          // Use the assigned heading if the aircraft is still turning, since
          // that reflects the intercept heading the controller intended.
          if (cmd.approachType === 'ILS' || cmd.approachType === 'RNAV') {
            const locCourse = runway.ilsCourse ?? runway.heading;
            const effectiveHeading = ac.clearances.heading ?? ac.heading;
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
          // If the aircraft is above the glideslope, automatically imply
          // "maintain until established" — the FlightPlanExecutor handles
          // glideslope intercept from above (line 443). Only reject if
          // absurdly high (> 3000ft above GS within 8nm — clearly an error).
          if (cmd.approachType === 'ILS') {
            const gsAltAtPosition = runway.elevation + (distToThreshold * GS_FT_PER_NM);
            if (ac.altitude > gsAltAtPosition + 3000 && distToThreshold < 8) {
              return {
                valid: false,
                reason: `${ac.callsign} is at ${Math.round(ac.altitude)}ft, glideslope at this distance is ~${Math.round(gsAltAtPosition)}ft. Descend aircraft before clearing approach.`,
              };
            }
            // Auto-apply maintain-until-established when aircraft is above GS
            if (ac.altitude > gsAltAtPosition + 500 && !cmd.maintainUntilEstablished) {
              cmd.maintainUntilEstablished = ac.clearances.altitude ?? Math.round(ac.altitude / 100) * 100;
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
          }
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
}
