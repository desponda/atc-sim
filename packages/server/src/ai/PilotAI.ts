import type {
  AircraftState,
  ATCCommand,
  RadioTransmission,
  AirportData,
} from '@atc-sim/shared';
import { normalizeHeading } from '@atc-sim/shared';
import { performanceDB } from '../data/PerformanceDB.js';
import { FlightPlanExecutor } from './FlightPlanExecutor.js';
import { RadioComms } from './RadioComms.js';

interface PendingCommand {
  aircraft: AircraftState;
  commands: ATCCommand[];
  executeAt: number; // simulation time to execute
}

/**
 * PilotAI manages AI behavior for each aircraft:
 * - Delayed command execution (2-5 sec pilot response time)
 * - Readback generation
 * - Compliance checking
 * - Flight plan following when no ATC override
 * - Initial contact radio calls when aircraft check in
 * - Handoff state tracking with coast/removal after delay
 */
export class PilotAI {
  private pendingCommands: PendingCommand[] = [];
  private flightPlanExecutor = new FlightPlanExecutor();
  private radioComms = new RadioComms();
  private handoffStartTimes = new Map<string, number>();
  /** Track aircraft IDs that have already checked in */
  private checkedIn = new Set<string>();
  /** IDs of aircraft that completed handoff and should be removed */
  private handoffComplete = new Set<string>();
  private airportData: AirportData | null = null;
  private atisLetter: string = 'A';

  setAirportData(data: AirportData): void {
    this.airportData = data;
    this.flightPlanExecutor.setAirportData(data);
  }

  setAtisLetter(letter: string): void {
    this.atisLetter = letter;
  }

  /**
   * Queue an ATC command for delayed execution.
   * Returns the pilot readback transmission.
   */
  issueCommand(
    ac: AircraftState,
    commands: ATCCommand[],
    simTime: number
  ): RadioTransmission {
    // 2-5 second response delay
    const delay = 2 + Math.random() * 3;
    this.pendingCommands.push({
      aircraft: ac,
      commands,
      executeAt: simTime + delay * 1000,
    });

    return this.radioComms.readback(ac, commands);
  }

  /**
   * Generate initial contact transmission for a newly spawned aircraft.
   * Returns null if the aircraft has already checked in.
   */
  generateInitialContact(ac: AircraftState): RadioTransmission | null {
    if (this.checkedIn.has(ac.id)) return null;
    this.checkedIn.add(ac.id);
    return this.radioComms.initialContact(ac, this.atisLetter);
  }

  /**
   * Execute an automatic go-around for an aircraft (triggered by conflict detection).
   * Returns a radio transmission announcing the go-around.
   */
  executeGoAround(ac: AircraftState, reason: string): RadioTransmission {
    // Determine runway heading from the approach clearance
    let runwayHeading = ac.heading;
    let missedApproachAlt = 2000;

    if (ac.clearances.approach && this.airportData) {
      const runway = this.airportData.runways.find(
        r => r.id === ac.clearances.approach!.runway
      );
      if (runway) {
        runwayHeading = runway.heading;
        missedApproachAlt = runway.elevation + 2000;

        // Check for a defined missed approach altitude from approach procedure
        const approach = this.airportData.approaches.find(
          a => a.runway === ac.clearances.approach!.runway
        );
        if (approach && approach.missedApproachLegs.length > 0) {
          // Use the first altitude constraint from the missed approach
          for (const leg of approach.missedApproachLegs) {
            if (leg.altitudeConstraint) {
              const alt = leg.altitudeConstraint.type === 'at'
                ? leg.altitudeConstraint.altitude
                : leg.altitudeConstraint.type === 'atOrAbove'
                  ? leg.altitudeConstraint.altitude
                  : leg.altitudeConstraint.type === 'between'
                    ? leg.altitudeConstraint.max
                    : leg.altitudeConstraint.altitude;
              missedApproachAlt = alt;
              break;
            }
          }
        }
      }
    }

    // Execute the go-around
    ac.clearances.approach = null;
    ac.onLocalizer = false;
    ac.onGlideslope = false;
    ac.flightPhase = 'missed';
    ac.targetAltitude = missedApproachAlt;
    ac.targetHeading = normalizeHeading(runwayHeading);
    ac.clearances.heading = null;
    ac.clearances.turnDirection = null;

    const perf = performanceDB.getOrDefault(ac.typeDesignator);
    ac.targetSpeed = perf.speed.vapp + 20;

    return this.radioComms.goAround(ac, reason);
  }

  /** Get the set of aircraft IDs that have completed handoff and should be removed */
  getHandoffCompleteIds(): Set<string> {
    return this.handoffComplete;
  }

  /** Acknowledge removal of a handed-off aircraft */
  clearHandoffComplete(id: string): void {
    this.handoffComplete.delete(id);
    this.checkedIn.delete(id);
    this.handoffStartTimes.delete(id);
  }

  /**
   * Update all aircraft AI for one tick.
   * Process pending commands and run flight plan executor.
   */
  update(aircraft: AircraftState[], simTime: number): RadioTransmission[] {
    const transmissions: RadioTransmission[] = [];

    // Process pending commands that have matured
    const stillPending: PendingCommand[] = [];
    for (const pending of this.pendingCommands) {
      if (simTime >= pending.executeAt) {
        // Check aircraft still exists
        const ac = aircraft.find(a => a.id === pending.aircraft.id);
        if (ac) {
          this.executeCommands(ac, pending.commands, simTime);
        }
      } else {
        stillPending.push(pending);
      }
    }
    this.pendingCommands = stillPending;

    // Handle handoff timing: coast briefly then mark for removal.
    // Aircraft that land are removed immediately; otherwise coast 45 seconds.
    for (const ac of aircraft) {
      if (ac.handingOff) {
        const startTime = this.handoffStartTimes.get(ac.id);
        if (startTime) {
          // Remove immediately if landed after handoff
          if (ac.flightPhase === 'landed') {
            this.handoffComplete.add(ac.id);
          } else if (simTime >= startTime + 180000) {
            // Coast for 3 minutes then remove (enough for a full approach)
            this.handoffComplete.add(ac.id);
          }
        }
      }
    }

    // Run flight plan executor for each aircraft.
    // Handed-off aircraft still fly their approach/departure — handoff means
    // the controller no longer issues commands, not that the pilot stops flying.
    for (const ac of aircraft) {
      if (ac.flightPhase === 'landed' || ac.onGround) continue;
      this.flightPlanExecutor.execute(ac);
    }

    return transmissions;
  }

  /**
   * Execute commands on an aircraft (after pilot delay).
   */
  private executeCommands(ac: AircraftState, commands: ATCCommand[], simTime: number = 0): void {
    for (const cmd of commands) {
      switch (cmd.type) {
        case 'altitude':
          ac.clearances.altitude = cmd.altitude;
          ac.targetAltitude = cmd.altitude;
          break;

        case 'heading':
          ac.clearances.heading = cmd.heading;
          ac.clearances.turnDirection = cmd.turnDirection;
          ac.targetHeading = cmd.heading;
          break;

        case 'speed':
          ac.clearances.speed = cmd.speed;
          if (cmd.speed !== null) {
            ac.targetSpeed = cmd.speed;
          } else {
            // Resume normal speed
            const perf = performanceDB.getOrDefault(ac.typeDesignator);
            if (ac.altitude < 10000) {
              ac.targetSpeed = perf.speed.vmaxBelow10k;
            } else {
              ac.targetSpeed = perf.speed.typicalCruiseIAS;
            }
          }
          break;

        case 'approach':
          ac.clearances.approach = {
            type: cmd.approachType,
            runway: cmd.runway,
          };
          ac.flightPhase = 'approach';
          // Set maintain-until-established altitude if specified
          if (cmd.maintainUntilEstablished) {
            ac.clearances.maintainUntilEstablished = cmd.maintainUntilEstablished;
            ac.targetAltitude = cmd.maintainUntilEstablished;
            ac.clearances.altitude = cmd.maintainUntilEstablished;
          } else {
            // Clear stale altitude clearance so glideslope/approach can
            // control altitude once established on the localizer.
            ac.clearances.altitude = null;
          }
          // Keep ATC-assigned heading so the aircraft continues flying the
          // intercept heading until the localizer is captured. The
          // FlightPlanExecutor will clear the heading once on the localizer.
          break;

        case 'direct':
          ac.clearances.directFix = cmd.fix;
          ac.clearances.heading = null; // Cancel heading assignment
          break;

        case 'hold':
          ac.clearances.holdFix = cmd.fix;
          break;

        case 'descendViaSTAR':
          ac.clearances.descendViaSTAR = true;
          ac.clearances.altitude = null; // Let VNAV control altitude
          break;

        case 'climbViaSID':
          ac.clearances.climbViaSID = true;
          ac.clearances.altitude = null;
          break;

        case 'handoff':
          ac.clearances.handoffFrequency = cmd.frequency;
          ac.handingOff = true;
          // Track handoff start time for sim-time-based clearing
          this.handoffStartTimes.set(ac.id, simTime);
          break;

        case 'goAround': {
          // Determine runway heading from the approach clearance
          let runwayHeading = ac.heading;
          let missedApproachAlt = 3000;

          if (ac.clearances.approach && this.airportData) {
            const runway = this.airportData.runways.find(
              r => r.id === ac.clearances.approach!.runway
            );
            if (runway) {
              runwayHeading = runway.heading;
              missedApproachAlt = runway.elevation + 2000;

              // Check for defined missed approach altitude
              const approach = this.airportData.approaches.find(
                a => a.runway === ac.clearances.approach!.runway
              );
              if (approach && approach.missedApproachLegs.length > 0) {
                for (const leg of approach.missedApproachLegs) {
                  if (leg.altitudeConstraint) {
                    const alt = leg.altitudeConstraint.type === 'at'
                      ? leg.altitudeConstraint.altitude
                      : leg.altitudeConstraint.type === 'atOrAbove'
                        ? leg.altitudeConstraint.altitude
                        : leg.altitudeConstraint.type === 'between'
                          ? leg.altitudeConstraint.max
                          : leg.altitudeConstraint.altitude;
                    missedApproachAlt = alt;
                    break;
                  }
                }
              }
            }
          }

          ac.clearances.approach = null;
          ac.onLocalizer = false;
          ac.onGlideslope = false;
          ac.flightPhase = 'missed';
          ac.targetAltitude = missedApproachAlt;
          ac.targetHeading = normalizeHeading(runwayHeading);
          ac.clearances.heading = null;
          ac.clearances.turnDirection = null;

          const goPerf = performanceDB.getOrDefault(ac.typeDesignator);
          ac.targetSpeed = goPerf.speed.vapp + 20;
          break;
        }

        case 'expectApproach':
          ac.clearances.expectedApproach = {
            type: cmd.approachType,
            runway: cmd.runway,
          };
          break;

        case 'expectRunway':
          // Just informational
          break;

        case 'cancelApproach':
          ac.clearances.approach = null;
          ac.onLocalizer = false;
          ac.onGlideslope = false;
          if (ac.flightPhase === 'final' || ac.flightPhase === 'approach') {
            ac.flightPhase = 'descent';
          }
          break;

        case 'resumeOwnNavigation':
          ac.clearances.heading = null;
          ac.clearances.turnDirection = null;
          break;

        case 'sid':
          ac.flightPlan.sid = cmd.name;
          ac.clearances.procedure = cmd.name;
          break;

        case 'star':
          ac.flightPlan.star = cmd.name;
          ac.clearances.procedure = cmd.name;
          break;
      }
    }
  }

  /** Clear all pending commands */
  clear(): void {
    this.pendingCommands = [];
    this.handoffStartTimes.clear();
    this.checkedIn.clear();
    this.handoffComplete.clear();
  }
}
