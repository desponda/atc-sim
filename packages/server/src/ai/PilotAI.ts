import type {
  AircraftState,
  ATCCommand,
  RadioTransmission,
  AirportData,
} from '@atc-sim/shared';
import { normalizeHeading, haversineDistance } from '@atc-sim/shared';
import type { WeatherConditions } from '../commands/CommandExecutor.js';
import { performanceDB } from '../data/PerformanceDB.js';
import { FlightPlanExecutor } from './FlightPlanExecutor.js';
import { RadioComms } from './RadioComms.js';

interface PendingCommand {
  aircraft: AircraftState;
  commands: ATCCommand[];
  executeAt: number; // simulation time to execute
}

/** Convert simulation time (ms) to a tick number (1 tick = 1000ms at 1Hz) */
function simTimeToTick(simTime: number): number {
  return Math.floor(simTime / 1000);
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
  /** IDs of aircraft that were just handed off this tick (not yet scored) */
  private newlyHandedOff = new Set<string>();
  /** IDs of aircraft whose handoff has already been scored */
  private handoffScored = new Set<string>();
  private airportData: AirportData | null = null;
  private atisLetter: string = 'A';
  private weather: WeatherConditions = { ceiling: null, visibility: 10 };

  setAirportData(data: AirportData): void {
    this.airportData = data;
    this.flightPlanExecutor.setAirportData(data);
  }

  setAtisLetter(letter: string): void {
    this.atisLetter = letter;
  }

  setWeather(weather: WeatherConditions): void {
    this.weather = weather;
  }

  /**
   * Enqueue an "unable" pilot response with a general radio delay.
   * The message is delivered via update() drain on subsequent ticks.
   */
  enqueueUnable(ac: AircraftState, reason: string, simTime: number): void {
    this.radioComms.unable(ac, reason, simTimeToTick(simTime));
  }

  /**
   * Queue an ATC command for delayed execution.
   * Enqueues the pilot readback in the RadioComms queue; drain via update().
   */
  issueCommand(
    ac: AircraftState,
    commands: ATCCommand[],
    simTime: number
  ): void {
    // 2-5 second response delay
    const delay = 2 + Math.random() * 3;
    this.pendingCommands.push({
      aircraft: ac,
      commands,
      executeAt: simTime + delay * 1000,
    });

    this.radioComms.readback(ac, commands, simTimeToTick(simTime));
  }

  /**
   * Generate initial contact transmission for a newly spawned aircraft.
   * The message is enqueued with a 3–6 tick delay; drain via update().
   * Returns true if the check-in was newly queued, false if already checked in.
   */
  generateInitialContact(ac: AircraftState, simTime: number = 0): boolean {
    if (this.checkedIn.has(ac.id)) return false;
    this.checkedIn.add(ac.id);
    this.radioComms.initialContact(ac, simTimeToTick(simTime), this.atisLetter);
    return true;
  }

  /**
   * Execute an automatic go-around for an aircraft (triggered by conflict detection).
   * Enqueues a go-around radio call with a 1–3 tick delay; drain via update().
   */
  executeGoAround(ac: AircraftState, reason: string, simTime: number = 0): void {
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

    // Return aircraft to approach frequency — clear any tower handoff state
    // so the aircraft is visible and controllable for re-vectoring
    ac.handingOff = false;
    ac.clearances.handoffFrequency = null;
    ac.clearances.handoffFacility = null;
    ac.radarHandoffState = undefined;
    ac.radarHandoffOfferedAt = undefined;
    this.handoffStartTimes.delete(ac.id);
    this.handoffComplete.delete(ac.id);
    this.newlyHandedOff.delete(ac.id);
    // Clear visual approach state
    ac.visualSight = undefined;
    ac.visualFollowTrafficCallsign = undefined;

    const perf = performanceDB.getOrDefault(ac.typeDesignator);
    ac.targetSpeed = perf.speed.vapp + 20;

    // Pass simTime converted to approximate ticks (RadioComms uses tick for scheduling)
    this.radioComms.goAround(ac, reason, simTime > 0 ? Math.floor(simTime / 1000) : 0);
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

  /** Get IDs of aircraft that were just handed off and haven't been scored yet */
  getNewlyHandedOffIds(): Set<string> {
    return this.newlyHandedOff;
  }

  /** Mark that scoring has been recorded for this handoff */
  acknowledgeHandoffScored(id: string): void {
    this.newlyHandedOff.delete(id);
    this.handoffScored.add(id);
  }

  /** Check if this aircraft was already scored at handoff time */
  wasHandoffScored(id: string): boolean {
    return this.handoffScored.has(id);
  }

  /** Clean up handoff scoring tracking when aircraft is removed */
  clearHandoffScored(id: string): void {
    this.handoffScored.delete(id);
    this.newlyHandedOff.delete(id);
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
    // Arrivals on approach/final stay until they land — they're just on
    // tower frequency, not gone from the airspace.  Departures and other
    // aircraft coast for 3 minutes then get removed.
    for (const ac of aircraft) {
      if (ac.handingOff) {
        const startTime = this.handoffStartTimes.get(ac.id);
        if (startTime) {
          if (ac.flightPhase === 'landed') {
            // Landed aircraft lifecycle is managed by AircraftManager.cleanup(),
            // which keeps them for a few ticks so the broadcast contains the
            // landed state.  Don't mark them for handoff removal here.
            continue;
          } else if (ac.flightPhase === 'approach' || ac.flightPhase === 'final') {
            // Arrivals on approach/final: keep them flying until they land.
            // Safety valve: force-remove after 2 minutes. At approach speed
            // (~140kts) from 5nm out, landing takes ~130s. If it hasn't
            // happened by 120s, something went wrong — clean up gracefully.
            if (simTime >= startTime + 120000) {
              this.handoffComplete.add(ac.id);
            }
          } else if (simTime >= startTime + 180000) {
            // Departures and others: coast for 3 minutes then remove
            this.handoffComplete.add(ac.id);
          }
        }
      }
    }

    // Process pending radar handoff offers — Center auto-accepts after 3-5s if criteria are met
    for (const ac of aircraft) {
      if (ac.radarHandoffState !== 'offered') continue;
      const offeredAt = ac.radarHandoffOfferedAt ?? simTime;
      const delay = 3000 + (ac.id.charCodeAt(0) % 3) * 1000; // 3-5s
      if (simTime - offeredAt < delay) continue;

      if (this.meetsRadarHandoffCriteria(ac)) {
        ac.radarHandoffState = 'accepted';
        this.radioComms.systemEvent(
          `\u2713 ${ac.callsign} — radar contact`,
          Math.floor(simTime / 1000)
        );
      } else {
        ac.radarHandoffState = 'rejected';
        ac.radarHandoffOfferedAt = simTime; // reuse as rejection timestamp
        this.radioComms.systemEvent(
          `\u2717 ${ac.callsign} — radar handoff rejected`,
          Math.floor(simTime / 1000)
        );
      }
    }
    // Clear rejected state after 5 seconds
    for (const ac of aircraft) {
      if (ac.radarHandoffState !== 'rejected') continue;
      if (simTime - (ac.radarHandoffOfferedAt ?? 0) >= 5000) {
        ac.radarHandoffState = undefined;
        ac.radarHandoffOfferedAt = undefined;
      }
    }

    // Process inbound handoff check-in delay.
    // After controller accepts an inbound handoff, aircraft checks in after
    // checkInDelayTicks countdown reaches zero.
    for (const ac of aircraft) {
      if (ac.inboundHandoff === 'accepted') {
        if (ac.checkInDelayTicks !== undefined && ac.checkInDelayTicks > 0) {
          // Decrement countdown
          ac.checkInDelayTicks--;
        } else if (ac.checkInDelayTicks === 0) {
          // Countdown reached zero — trigger check-in (enqueued with radio delay)
          ac.inboundHandoff = undefined;
          ac.checkInDelayTicks = undefined;
          this.generateInitialContact(ac, simTime);
        }
      }
      // If inboundHandoff === 'offered': do nothing — suppress check-in entirely
    }

    // Compute current tick once for use in sight query processing and drain
    const currentTick = simTimeToTick(simTime);

    // Process visual sight queries: after responseDelay ticks, resolve field/traffic response.
    for (const ac of aircraft) {
      if (!ac.visualSight || ac.visualSight.state !== 'queried') continue;
      if (currentTick < ac.visualSight.queriedAtTick + ac.visualSight.responseDelay) continue;

      const sightResult = this.canPilotSeeField(ac);
      if (sightResult === 'yes') {
        if (ac.visualSight.trafficCallsign) {
          ac.visualSight.state = 'trafficSighted';
          this.radioComms.sightResponse(ac, 'traffic', currentTick, ac.visualSight.trafficCallsign);
        } else {
          ac.visualSight.state = 'fieldSighted';
          this.radioComms.sightResponse(ac, 'field', currentTick);
        }
      } else if (sightResult === 'notYet') {
        // Weather is VFR but aircraft is not yet close enough — will auto-report when in range
        ac.visualSight.state = 'willReport';
        this.radioComms.sightResponse(ac, 'willReport', currentTick, ac.visualSight.trafficCallsign);
      } else {
        // IMC — can't see now or later without weather change
        ac.visualSight.state = 'negative';
        this.radioComms.sightResponse(ac, 'negative', currentTick, ac.visualSight.trafficCallsign);
      }
    }

    // Monitor 'willReport' aircraft: auto-report field/traffic in sight when in visual range.
    for (const ac of aircraft) {
      if (!ac.visualSight || ac.visualSight.state !== 'willReport') continue;
      const sightResult = this.canPilotSeeField(ac);
      if (sightResult !== 'yes') continue;
      // Pilot is now in range — auto-report
      if (ac.visualSight.trafficCallsign) {
        ac.visualSight.state = 'trafficSighted';
        this.radioComms.sightResponse(ac, 'traffic', currentTick, ac.visualSight.trafficCallsign);
      } else {
        ac.visualSight.state = 'fieldSighted';
        this.radioComms.sightResponse(ac, 'field', currentTick);
      }
    }

    // Run flight plan executor for each aircraft.
    // Handed-off aircraft still fly their approach/departure — handoff means
    // the controller no longer issues commands, not that the pilot stops flying.
    for (const ac of aircraft) {
      if (ac.flightPhase === 'landed' || ac.onGround) continue;
      this.flightPlanExecutor.execute(ac, aircraft);
    }

    // DA/MDA check for ILS/RNAV approaches: at minimums, either report visual or go missed.
    // This runs AFTER flightPlanExecutor so altitude is current.
    for (const ac of aircraft) {
      if (!ac.clearances.approach) continue;
      if (ac.clearances.approach.type === 'VISUAL') continue; // visual approaches skip this
      if (ac.flightPhase === 'landed' || ac.flightPhase === 'missed') continue;
      if (!ac.onGlideslope) continue; // only check once established on glideslope
      if (!this.airportData) continue;

      const runway = this.airportData.runways.find(r => r.id === ac.clearances.approach!.runway);
      if (!runway) continue;

      // Decision Altitude: ILS = runway elevation + 200ft AGL, RNAV = +400ft AGL
      const da = ac.clearances.approach.type === 'ILS'
        ? runway.elevation + 200
        : runway.elevation + 400;

      if (ac.altitude > da + 50) continue; // not yet at DA

      // Already has visual — let ILS/RNAV landing detection handle the rest
      const hasSight = ac.visualSight?.state === 'fieldSighted' || ac.visualSight?.state === 'trafficSighted';
      if (hasSight) continue;

      // Use approach DA/MDA as the ceiling threshold (not VFR 1000ft).
      // ILS Cat I: ceiling ≥ 200ft AGL, vis ≥ 0.5 SM.
      // RNAV:      ceiling ≥ 400ft AGL, vis ≥ 1 SM.
      const daAgl = ac.clearances.approach.type === 'ILS' ? 200 : 400;
      const minVis  = ac.clearances.approach.type === 'ILS' ? 0.5 : 1.0;
      const sightResult = this.canPilotSeeField(ac, daAgl, minVis);
      if (sightResult === 'yes') {
        // Auto-acquire visual at minimums — pilot reports "runway in sight"
        ac.visualSight = { state: 'fieldSighted', queriedAtTick: currentTick, responseDelay: 0 };
        this.radioComms.sightResponse(ac, 'runway', currentTick);
      } else {
        // No visual at minimums — mandatory missed approach
        this.executeGoAround(ac, 'runway not in sight at minimums', simTime);
      }
    }

    // Drain any radio messages whose delay has elapsed this tick
    const queued = this.radioComms.drainQueue(currentTick);
    transmissions.push(...queued);

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
          // FAA 7110.65: vectors cancel the STAR/SID — altitude restrictions,
          // speed restrictions, and lateral routing are all canceled.
          if (ac.clearances.descendViaSTAR) {
            ac.clearances.descendViaSTAR = false;
          }
          if (ac.clearances.climbViaSID) {
            ac.clearances.climbViaSID = false;
          }
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
          // Visual approach: wire up traffic following if applicable, then clear query state
          if (cmd.approachType === 'VISUAL') {
            if (ac.visualSight?.state === 'trafficSighted' && ac.visualSight.trafficCallsign) {
              ac.visualFollowTrafficCallsign = ac.visualSight.trafficCallsign;
            }
            ac.visualSight = undefined;
          }
          // FAA 7110.65 4-8-1: "issue approach clearance only after the aircraft
          // is assigned an altitude to maintain until established on a segment of
          // a published route or instrument approach procedure."
          if (cmd.maintainUntilEstablished) {
            ac.clearances.maintainUntilEstablished = cmd.maintainUntilEstablished;
            ac.targetAltitude = cmd.maintainUntilEstablished;
            ac.clearances.altitude = cmd.maintainUntilEstablished;
          } else if (ac.clearances.altitude !== null) {
            // No explicit maintain-until-established: use current assigned altitude.
            // Aircraft maintains this altitude until established on the localizer/FAC.
            ac.clearances.maintainUntilEstablished = ac.clearances.altitude;
            ac.targetAltitude = ac.clearances.altitude;
          } else {
            // No altitude assigned at all — maintain current altitude
            const currentAlt = Math.round(ac.altitude / 100) * 100;
            ac.clearances.maintainUntilEstablished = currentAlt;
            ac.targetAltitude = currentAlt;
            ac.clearances.altitude = currentAlt;
          }
          // Keep ATC-assigned heading so the aircraft continues flying the
          // intercept heading until the localizer is captured. The
          // FlightPlanExecutor will clear the heading once on the localizer.
          break;

        case 'direct':
          ac.clearances.directFix = cmd.fix;
          ac.clearances.heading = null; // Cancel heading assignment
          // Direct-to a fix shortcuts the procedure routing — cancel VNAV constraints.
          // The controller may re-issue DVS after the direct if they want VNAV to resume.
          ac.clearances.descendViaSTAR = false;
          ac.clearances.climbViaSID = false;
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

        case 'radarHandoff':
          ac.radarHandoffState = 'offered';
          ac.radarHandoffOfferedAt = simTime;
          break;

        case 'handoff':
          ac.clearances.handoffFrequency = cmd.frequency;
          ac.clearances.handoffFacility = cmd.facility;
          ac.handingOff = true;
          // Clear radar handoff state when actual handoff is issued
          ac.radarHandoffState = undefined;
          ac.radarHandoffOfferedAt = undefined;
          // Track handoff start time for sim-time-based clearing
          this.handoffStartTimes.set(ac.id, simTime);
          // Mark as newly handed off so scoring can count it this tick
          this.newlyHandedOff.add(ac.id);
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

          // Return to approach frequency — clear tower handoff so ATC can re-vector
          ac.handingOff = false;
          ac.clearances.handoffFrequency = null;
          ac.clearances.handoffFacility = null;
          ac.radarHandoffState = undefined;
          ac.radarHandoffOfferedAt = undefined;
          this.handoffStartTimes.delete(ac.id);
          this.handoffComplete.delete(ac.id);
          this.newlyHandedOff.delete(ac.id);
          // Clear visual approach state
          ac.visualSight = undefined;
          ac.visualFollowTrafficCallsign = undefined;

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
          // RON means the pilot takes own nav — STAR/SID VNAV constraints no longer apply
          ac.clearances.descendViaSTAR = false;
          ac.clearances.climbViaSID = false;
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

  /**
   * Determine whether a pilot can visually acquire the airport/traffic.
   * Returns:
   *   'yes'    — VFR conditions and within visual range (can see now)
   *   'notYet' — VFR conditions but too far away (will see when closer)
   *   'no'     — IMC conditions (will never see without weather change)
   */
  /**
   * @param minCeilingAgl  Minimum ceiling AGL for "visible" (default 1000 = VFR).
   *                       Pass the approach DA (200 for ILS, 400 for RNAV) when
   *                       checking visibility at minimums.
   * @param minVisibilitySm  Minimum visibility in SM (default 3 = VFR; 0.5 for ILS Cat I).
   */
  private canPilotSeeField(
    ac: AircraftState,
    minCeilingAgl = 1000,
    minVisibilitySm = 3,
  ): 'yes' | 'notYet' | 'no' {
    const { ceiling, visibility } = this.weather;

    // Below required ceiling or visibility — pilot cannot acquire visual
    if (ceiling !== null && ceiling < minCeilingAgl) return 'no';
    if (visibility < minVisibilitySm) return 'no';

    // Distance check: pilots can realistically see the airport within ~visibility nm
    // (1 SM ≈ 0.87 nm; use 0.85 as conservative factor)
    if (this.airportData) {
      const distToAirport = haversineDistance(ac.position, this.airportData.position);
      const visibilityNm = visibility * 0.85;
      if (distToAirport > visibilityNm) return 'notYet';
    }

    return 'yes';
  }

  private meetsRadarHandoffCriteria(ac: AircraftState): boolean {
    if (ac.flightPlan.squawk === '1200') return false;
    if (ac.transponder !== 'modeC') return false;
    if (ac.altitude < 8000 && ac.targetAltitude < 8000) return false;
    if (ac.category === 'arrival') return false;
    if (!this.airportData) return true;
    const distFromAirport = haversineDistance(ac.position, this.airportData.position);
    if (distFromAirport < 10) return false; // too close, not ready to hand off
    return true;
  }

  /** Clear all pending commands and queued radio transmissions */
  clear(): void {
    this.pendingCommands = [];
    this.handoffStartTimes.clear();
    this.checkedIn.clear();
    this.handoffComplete.clear();
    this.newlyHandedOff.clear();
    this.handoffScored.clear();
    this.radioComms.clearQueue();
  }
}
