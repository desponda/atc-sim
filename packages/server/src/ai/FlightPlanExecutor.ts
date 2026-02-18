import type {
  AircraftState,
  AircraftPerformance,
  AirportData,
  Runway,
  STAR,
  SID,
  ProcedureLeg,
  AltitudeConstraint,
  SpeedConstraint,
  Position,
} from '@atc-sim/shared';
import {
  haversineDistance,
  initialBearing,
  headingDifference,
  normalizeHeading,
  glideslopeAltitude,
  destinationPoint,
  crossTrackDistance,
} from '@atc-sim/shared';
import { performanceDB } from '../data/PerformanceDB.js';

/**
 * FlightPlanExecutor handles LNAV/VNAV: fix-to-fix navigation,
 * altitude/speed restrictions, ILS intercept and tracking.
 */
export class FlightPlanExecutor {
  private airportData: AirportData | null = null;

  setAirportData(data: AirportData): void {
    this.airportData = data;
  }

  /**
   * Execute one tick of flight plan following for an aircraft.
   * Updates target heading/altitude/speed based on flight plan and clearances.
   * allAircraft is used for visual separation when following traffic.
   */
  execute(ac: AircraftState, allAircraft?: AircraftState[]): void {
    // If heading is assigned by ATC, don't follow LNAV
    const hasAtcHeading = ac.clearances.heading !== null;

    // Missed approach procedure: climb on runway heading, then follow missed approach legs
    if (ac.flightPhase === 'missed') {
      this.executeMissedApproach(ac);
      return;
    }

    // ILS approach tracking takes priority
    if (ac.clearances.approach) {
      this.executeApproach(ac, allAircraft);
      return;
    }

    // Holding pattern
    if (ac.clearances.holdFix) {
      this.executeHold(ac);
      return;
    }

    // Direct-to fix
    if (ac.clearances.directFix) {
      this.executeDirect(ac);
      return;
    }

    // Follow route/procedure if no ATC heading override
    if (!hasAtcHeading) {
      // Execute SID departure legs (VA/VI/VD) before transitioning to route navigation
      if (ac.category === 'departure' && ac.sidLegs && (ac.sidLegIdx ?? 0) < ac.sidLegs.length) {
        this.executeSIDDepartureLeg(ac);
      } else {
        this.executeRouteNavigation(ac);
      }
    }

    // Apply VNAV from procedure constraints
    if (ac.clearances.descendViaSTAR || ac.clearances.climbViaSID) {
      this.executeVNAV(ac);
    }

    // Automatic pilot speed management (when no ATC speed assignment)
    this.manageDefaultSpeed(ac);
  }

  /**
   * Pilots automatically manage their speed when not given an ATC speed assignment.
   * - Below 10,000ft: 250kt max (FAA regulation 14 CFR 91.117)
   * - Arrivals slow to ~210kt when within 20nm and descending
   * - Arrivals slow to approach speed within ~10nm
   * - Departures accelerate after passing 3000ft AGL
   * - GA aircraft fly much slower (typically 100-150kt)
   */
  private manageDefaultSpeed(ac: AircraftState): void {
    // If ATC has assigned a speed, respect it
    if (ac.clearances.speed !== null) return;
    // If on approach/final, the approach executor handles speed
    if (ac.flightPhase === 'final' || ac.flightPhase === 'approach') return;

    const perf = performanceDB.getOrDefault(ac.typeDesignator);
    const isGA = ac.wakeCategory === 'SMALL' && perf.speed.vmo < 200;
    const distToAirport = this.airportData
      ? haversineDistance(ac.position, this.airportData.position)
      : 99;

    // Skip proximity-based decel if the aircraft is NOT heading toward the airport
    // (e.g. on downwind, passing abeam the field).  Aircraft heading more than 90°
    // away from the bearing to the airport are tracked outbound or crosswind — only
    // enforce the 250kt below-10k rule for them.
    if (this.airportData && ac.category === 'arrival') {
      const bearingToAirport = initialBearing(ac.position, this.airportData.position);
      const angleOff = Math.abs(headingDifference(ac.heading, bearingToAirport));
      if (angleOff > 90) {
        // Heading away from / abeam the field — just cap at 250kt
        if (ac.altitude < 10000 && ac.targetSpeed > 250) ac.targetSpeed = 250;
        return;
      }
    }

    if (isGA) {
      // GA aircraft: cruise at typical speed (usually 100-150kt)
      ac.targetSpeed = Math.min(perf.speed.typicalCruiseIAS, perf.speed.vmo);
      return;
    }

    if (ac.category === 'arrival') {
      // Begin decelerating to 250kt before reaching 10,000ft.
      // At 1.5 kt/sec decel, 280→250kt takes ~20s = ~600ft at 1800 fpm descent.
      // Starting at 11,500ft gives comfortable margin for the 10k crossing.
      if (ac.altitude < 11500) {
        const limit = Math.min(perf.speed.vmaxBelow10k, 250);
        if (ac.targetSpeed > limit) {
          ac.targetSpeed = limit;
        }
      }

      // Distance-based deceleration profile below 10,000ft.
      // Rule of thumb: 1nm per 10kt of speed reduction needed.
      // 250→160kt = 90kt = ~9nm, so controllers start slowing by 20-30nm.
      // Profile: 230 by 30nm, 210 by 20nm, 190 by 15nm, 180 by 10nm.
      if (ac.altitude < 10000) {
        let maxSpd: number;
        // Realistic TRACON speed profile (refs: FAA TRACON SOPs, SKYbrary):
        //   downwind: 210-230kt | base/intercept: ~185kt | short final: vapp
        // The approach executor handles speeds once cleared for approach.
        if (distToAirport > 30) {
          maxSpd = 250;
        } else if (distToAirport > 20) {
          maxSpd = 230;
        } else if (distToAirport > 15) {
          maxSpd = 220; // downwind/close-in downwind
        } else if (distToAirport > 10) {
          maxSpd = 210; // late downwind / base turn
        } else {
          // Within 10nm without approach clearance (e.g. still on downwind):
          // 190kt is realistic for base/intercept before approach clearance.
          maxSpd = 190;
        }
        // Never ask for less than a safe maneuvering speed
        maxSpd = Math.max(maxSpd, perf.speed.vapp + 20);
        if (ac.targetSpeed > maxSpd) {
          ac.targetSpeed = maxSpd;
        }
      }
    } else if (ac.category === 'departure') {
      const aglAltitude = ac.altitude - (this.airportData?.elevation ?? 0);

      if (aglAltitude < 3000) {
        // Low-altitude initial climb: keep speed moderate (flaps/gear zone)
        ac.targetSpeed = Math.min(ac.targetSpeed, 200);
      } else if (ac.altitude < 10000) {
        // Above 3000ft AGL and below 10,000ft: actively target 250kt.
        // This accelerates from the slow initial climb speed up to the
        // speed limit, so the aircraft arrives at 10,000ft at exactly 250kt.
        ac.targetSpeed = Math.min(perf.speed.vmaxBelow10k, 250);
      }
    }
  }

  private executeDirect(ac: AircraftState): void {
    if (!ac.clearances.directFix || !this.airportData) return;

    const fix = this.findFix(ac.clearances.directFix);
    if (!fix) return;

    const bearing = initialBearing(ac.position, fix);
    const distance = haversineDistance(ac.position, fix);

    ac.targetHeading = normalizeHeading(bearing);

    // Check if we've reached the fix (within 1nm)
    if (distance < 1.0) {
      ac.clearances.directFix = null;
      // Advance to next fix in route if applicable
      this.advanceToNextFix(ac);
    }
  }

  /**
   * Execute holding pattern at the cleared hold fix.
   * Standard right-hand racetrack pattern with 1-minute legs.
   */
  private executeHold(ac: AircraftState): void {
    // If holdFix was cleared, clean up holdingState and return
    if (!ac.clearances.holdFix) {
      ac.holdingState = undefined;
      return;
    }

    const fixPos = this.findFix(ac.clearances.holdFix);
    if (!fixPos) return;

    const distToFix = haversineDistance(ac.position, fixPos);

    if (!ac.holdingState) {
      // Not yet holding — fly toward the fix first
      if (distToFix > 1.5) {
        const bearingToFix = initialBearing(ac.position, fixPos);
        ac.targetHeading = normalizeHeading(bearingToFix);
        return;
      }

      // Reached the fix — initialize holding state
      // Inbound course: bearing FROM fix TO airport (hold on approach side)
      const airportPos = this.airportData?.position;
      const inboundCourse = airportPos
        ? normalizeHeading(initialBearing(fixPos, airportPos))
        : normalizeHeading(ac.heading); // fallback: current heading as inbound

      ac.holdingState = {
        phase: 'turning_outbound',
        inboundCourse,
        legStartTime: Date.now(),
        fixPosition: fixPos,
      };
    }

    const hs = ac.holdingState;
    const outboundCourse = normalizeHeading(hs.inboundCourse + 180);

    switch (hs.phase) {
      case 'turning_outbound': {
        // Turn to outbound heading (right-hand turn)
        ac.targetHeading = outboundCourse;
        const hdgDiff = Math.abs(headingDifference(ac.heading, outboundCourse));
        if (hdgDiff < 10) {
          hs.phase = 'outbound';
          hs.legStartTime = Date.now();
        }
        break;
      }

      case 'outbound': {
        // Fly outbound heading for 60 seconds (1-minute leg)
        ac.targetHeading = outboundCourse;
        const elapsed = (Date.now() - hs.legStartTime) / 1000;
        if (elapsed >= 60) {
          hs.phase = 'turning_inbound';
          hs.legStartTime = Date.now();
        }
        break;
      }

      case 'turning_inbound': {
        // Turn to inbound heading (right-hand turn)
        ac.targetHeading = normalizeHeading(hs.inboundCourse);
        const hdgDiff = Math.abs(headingDifference(ac.heading, hs.inboundCourse));
        if (hdgDiff < 10) {
          hs.phase = 'inbound';
          hs.legStartTime = Date.now();
        }
        break;
      }

      case 'inbound': {
        // Fly toward the fix
        const bearingToFix = initialBearing(ac.position, hs.fixPosition);
        ac.targetHeading = normalizeHeading(bearingToFix);
        const dist = haversineDistance(ac.position, hs.fixPosition);
        if (dist < 1.5) {
          hs.phase = 'turning_outbound';
          hs.legStartTime = Date.now();
        }
        break;
      }
    }
  }

  private executeRouteNavigation(ac: AircraftState): void {
    const route = ac.flightPlan.route;
    if (route.length === 0 || ac.currentFixIndex >= route.length) return;

    // Departures: track the runway centerline during initial climb (< 400ft AGL).
    // Simply holding runway heading isn't enough — crosswind pushes the ground
    // track off the centerline. Use the same proportional XTK correction as the
    // ILS localizer tracker so the departure stays on the extended centerline.
    if (ac.category === 'departure' && this.airportData) {
      if (ac.altitude < this.airportData.elevation + 400) {
        const runway = this.airportData.runways.find(r => r.id === ac.flightPlan.runway);
        if (runway) {
          // Use runway.end as the centerline reference — same points the MapLayer uses
          // to draw the runway, so XTK is measured against the exact visual centerline.
          const runwayBearing = initialBearing(runway.threshold, runway.end);
          const signedXtk = crossTrackDistance(ac.position, runway.threshold, runway.end);
          // 30°/nm gain, clamped to ±20° — aggressive enough to fight crosswind
          const correctionAngle = Math.max(-20, Math.min(20, -signedXtk * 30));
          ac.targetHeading = normalizeHeading(runwayBearing + correctionAngle);
        }
        return;
      }
    }

    const targetFixId = route[ac.currentFixIndex];
    const fix = this.findFix(targetFixId);
    if (!fix) {
      // Skip unfound fix
      ac.currentFixIndex++;
      return;
    }

    const bearing = initialBearing(ac.position, fix);
    const distance = haversineDistance(ac.position, fix);

    // Always navigate toward the next fix — the physics engine's turn rate
    // limits how fast the aircraft can bank, so large course corrections are
    // handled gracefully. Restricting heading updates caused aircraft to overshoot
    // fixes when the next leg required a turn > 45°, producing circular paths.
    if (distance > 0.1) {
      ac.targetHeading = normalizeHeading(bearing);
    }

    // Fly-by turn anticipation: start turning ~1nm before fix
    const turnAnticipation = ac.speed > 200 ? 1.5 : 0.8;
    if (distance < turnAnticipation) {
      this.advanceToNextFix(ac);
    }
  }

  private advanceToNextFix(ac: AircraftState): void {
    ac.currentFixIndex++;
    // If we've completed the route, stay on current heading
  }

  /**
   * Execute the current SID departure leg (VA/VI/VD).
   * VA: fly course until altitude constraint; VI: fly course until aligned with next fix; VD: fly course until alt.
   */
  private executeSIDDepartureLeg(ac: AircraftState): void {
    if (!ac.sidLegs || ac.sidLegIdx === undefined) return;
    const leg = ac.sidLegs[ac.sidLegIdx];
    if (!leg) return;

    // Apply turn direction if specified (for the initial turn)
    if (leg.turnDirection) {
      ac.clearances.turnDirection = leg.turnDirection;
    }
    ac.targetHeading = normalizeHeading(leg.course);

    switch (leg.legType) {
      case 'VA':
      case 'VD': {
        // Fly course until altitude constraint is met (altitude is ft MSL)
        const alt = leg.altConstraint;
        if (alt === undefined || ac.altitude >= alt) {
          ac.clearances.turnDirection = null;
          ac.sidLegIdx++;
        }
        break;
      }
      case 'VI': {
        // Fly course until we're aligned enough with the next route fix to hand off to route nav
        const nextFix = ac.flightPlan.route[ac.currentFixIndex];
        if (nextFix) {
          const fixPos = this.findFix(nextFix);
          if (fixPos) {
            const bearingToFix = normalizeHeading(initialBearing(ac.position, fixPos));
            const hdgDiff = headingDifference(ac.heading, bearingToFix);
            // Transition when bearing to fix is within 60° of heading, and at least 3nm from airport
            const distToAirport = this.airportData
              ? haversineDistance(ac.position, this.airportData.position)
              : 0;
            if (Math.abs(hdgDiff) < 60 && distToAirport > 3) {
              ac.clearances.turnDirection = null;
              ac.sidLegIdx++;
            }
          }
        } else {
          // No route fix — just advance
          ac.sidLegIdx++;
        }
        break;
      }
    }
  }

  /**
   * Execute missed approach procedure.
   * If missed approach legs are defined in the approach procedure, follow them.
   * Otherwise, climb to 3000ft AGL on runway heading, then hold.
   */
  private executeMissedApproach(ac: AircraftState): void {
    if (!this.airportData) return;

    // If ATC has given a heading or altitude, defer to those
    if (ac.clearances.heading !== null) return;
    if (ac.clearances.altitude !== null) {
      ac.targetAltitude = ac.clearances.altitude;
    }

    // Find the approach procedure for the runway the aircraft was approaching
    const rwyId = ac.flightPlan.runway;
    if (!rwyId) {
      // No runway assigned, default: climb to 3000ft on current heading
      if (ac.targetAltitude < this.airportData.elevation + 3000) {
        ac.targetAltitude = this.airportData.elevation + 3000;
      }
      return;
    }

    const approach = this.airportData.approaches.find(a => a.runway === rwyId);
    const runway = this.airportData.runways.find(r => r.id === rwyId);

    if (approach && approach.missedApproachLegs.length > 0) {
      // Follow missed approach legs
      // For simplicity, find the first fix in the missed approach and fly to it
      for (const leg of approach.missedApproachLegs) {
        if (leg.fix) {
          const fix = this.findFix(leg.fix.id);
          if (fix) {
            const bearing = initialBearing(ac.position, fix);
            const distance = haversineDistance(ac.position, fix);

            // Only start turning to the fix after reaching a safe altitude
            // (at least 500ft above field)
            if (ac.altitude > this.airportData.elevation + 500) {
              ac.targetHeading = normalizeHeading(bearing);
            }

            // Apply altitude constraint from the leg
            if (leg.altitudeConstraint && ac.clearances.altitude === null) {
              const constraintAlt = leg.altitudeConstraint.type === 'at'
                ? leg.altitudeConstraint.altitude
                : leg.altitudeConstraint.type === 'atOrAbove'
                  ? leg.altitudeConstraint.altitude
                  : leg.altitudeConstraint.type === 'between'
                    ? leg.altitudeConstraint.max
                    : leg.altitudeConstraint.altitude;
              ac.targetAltitude = Math.max(ac.targetAltitude, constraintAlt);
            }

            // When close to the fix, transition to holding
            if (distance < 1.5) {
              // Reached the missed approach fix, hold here
              ac.clearances.holdFix = leg.fix.id;
              // Transition to descent phase so ATC can re-vector
              ac.flightPhase = 'descent';
            }
            break;
          }
        }

        // If leg has a course-to-altitude type, just climb on the specified course
        if (leg.legType === 'CA' || leg.legType === 'VA') {
          if (leg.course !== undefined) {
            ac.targetHeading = normalizeHeading(leg.course);
          }
          if (leg.altitudeConstraint && ac.clearances.altitude === null) {
            const alt = leg.altitudeConstraint.type === 'at'
              ? leg.altitudeConstraint.altitude
              : leg.altitudeConstraint.type === 'atOrAbove'
                ? leg.altitudeConstraint.altitude
                : leg.altitudeConstraint.type === 'between'
                  ? leg.altitudeConstraint.max
                  : leg.altitudeConstraint.altitude;
            ac.targetAltitude = Math.max(ac.targetAltitude, alt);

            // Once at the altitude, transition
            if (ac.altitude >= alt - 100) {
              ac.flightPhase = 'descent';
            }
          }
          break;
        }
      }
    } else {
      // No missed approach legs defined: default procedure
      // Climb to 3000ft AGL on runway heading, then transition to descent for re-vectoring
      const defaultMissedAlt = this.airportData.elevation + 3000;
      if (ac.clearances.altitude === null) {
        ac.targetAltitude = Math.max(ac.targetAltitude, defaultMissedAlt);
      }

      // Fly runway heading
      if (runway) {
        ac.targetHeading = normalizeHeading(runway.heading);
      }

      // Once at missed approach altitude, transition to descent for ATC re-vectoring
      if (ac.altitude >= defaultMissedAlt - 100) {
        ac.flightPhase = 'descent';
      }
    }
  }

  private executeApproach(ac: AircraftState, allAircraft?: AircraftState[]): void {
    if (!ac.clearances.approach || !this.airportData) return;

    const runway = this.airportData.runways.find(
      r => r.id === ac.clearances.approach!.runway
    );
    if (!runway) return;

    switch (ac.clearances.approach.type) {
      case 'ILS':
        this.executeILS(ac, runway);
        break;
      case 'RNAV':
        this.executeRNAV(ac, runway);
        break;
      case 'VISUAL':
        this.executeVisual(ac, runway, allAircraft);
        break;
    }
  }

  private executeILS(ac: AircraftState, runway: Runway): void {
    // Use the true bearing from actual coordinates — ilsCourse/heading are magnetic,
    // but all geo functions (destinationPoint, crossTrackDistance) require true bearings.
    // This matches how snapToRunwayCenterline() already handles the same issue.
    const locCourse = initialBearing(runway.threshold, runway.end);
    const thresholdPos = runway.threshold;
    const distToThreshold = haversineDistance(ac.position, thresholdPos);
    const bearingToThreshold = initialBearing(ac.position, thresholdPos);

    // Localizer deviation: angular offset between the localizer course and the
    // bearing from the aircraft to the threshold. When the aircraft is exactly
    // on the extended centerline inbound, this is 0.
    const locDev = headingDifference(locCourse, bearingToThreshold);

    if (!ac.onLocalizer) {
      const hasAtcHeading = ac.clearances.heading !== null;

      // Cross-track distance from the extended centerline.
      const reciprocal = normalizeHeading(locCourse + 180);
      const farPoint = destinationPoint(thresholdPos, reciprocal, 30);
      const signedXtk = crossTrackDistance(ac.position, farPoint, thresholdPos);
      const xtk = Math.abs(signedXtk);

      // Use actual aircraft heading for capture — the aircraft should be
      // physically pointing toward the beam before it establishes, not just
      // have an old ATC clearance that happens to be within range.
      const headingToLoc = Math.abs(headingDifference(ac.heading, locCourse));

      // Ensure the aircraft is on the inbound side of the runway.
      const bearingFromThreshold = initialBearing(thresholdPos, ac.position);
      const angleFromReciprocal = Math.abs(headingDifference(reciprocal, bearingFromThreshold));
      const isInFront = angleFromReciprocal < 120;

      // Capture criteria: established on localizer.
      // Threshold is 0.3nm (not 1.5nm) to avoid a large position jump at capture —
      // the snap in PhysicsEngine only corrects residuals ≤ 0.3nm, so capture
      // must happen when the aircraft is already close to the beam.
      if (xtk < 0.3 && headingToLoc < 45 && distToThreshold < 35 && isInFront) {
        ac.onLocalizer = true;
        ac.flightPhase = 'final';
        ac.clearances.heading = null;
        ac.clearances.turnDirection = null;
        if (ac.clearances.maintainUntilEstablished !== null) {
          ac.clearances.maintainUntilEstablished = null;
          ac.clearances.altitude = null;
        }
      } else if (!isInFront) {
        // Aircraft is behind the runway — fly toward a point well ahead on the
        // approach side only when no ATC heading is assigned.
        if (!hasAtcHeading) {
          const entryPt = destinationPoint(thresholdPos, reciprocal, 15);
          ac.targetHeading = normalizeHeading(initialBearing(ac.position, entryPt));
        }
      } else {
        // ARM mode: steer proportionally toward the localizer to prevent
        // overshoot at capture.  When ATC has assigned an intercept heading,
        // start overriding it within 2nm of the beam so the aircraft rolls out
        // before crossing the centerline (simulates LOC ARM → LOC CAPTURE).
        // Beyond 2nm, only steer if no ATC heading is assigned.
        if (!hasAtcHeading || xtk < 2.0) {
          if (xtk > 0.05) {
            // atan2-based intercept: at 0.5nm → 27°, at 1nm → 45°→30° capped.
            // Gives a heading clearly aimed at the beam rather than the runway.
            const interceptMag = Math.min(30, (Math.atan2(xtk, 1) * 180) / Math.PI);
            const interceptAngle = signedXtk > 0 ? -interceptMag : interceptMag;
            ac.targetHeading = normalizeHeading(locCourse + interceptAngle);
          } else {
            ac.targetHeading = normalizeHeading(locCourse);
          }
          // Clear any ATC turn direction so PhysicsEngine uses the shortest-path
          // turn rather than the controller-assigned direction (which could cause
          // a 357° turn when ARM only needs a small heading change).
          ac.clearances.turnDirection = null;
        }
        // If xtk >= 2nm and ATC heading assigned: let the aircraft fly the
        // assigned heading — the ARM window will take over when it gets close.
      }
    }

    if (ac.onLocalizer) {
      // Safety valve: if the aircraft has drifted more than 0.5nm off-centerline
      // after capture (e.g. due to a high intercept angle during the rollout),
      // un-capture and let the ARM mode steer it back.
      const reciprocalCheck = normalizeHeading(locCourse + 180);
      const farPointCheck = destinationPoint(thresholdPos, reciprocalCheck, 30);
      const xtkCheck = Math.abs(crossTrackDistance(ac.position, farPointCheck, thresholdPos));
      if (xtkCheck > 0.5 && distToThreshold > 3) {
        ac.onLocalizer = false;
        ac.onGlideslope = false;
        ac.flightPhase = 'approach';
        // Fall through — the !ac.onLocalizer block above already ran, so ARM
        // mode will take effect next tick.
      }
    }

    if (ac.onLocalizer) {
      // Once established, PhysicsEngine.snapToLocalizerCenterline() snaps the
      // aircraft's position onto the beam rail every tick — exact, zero error.
      // All that's needed here is to hold the localizer course heading.  Wind
      // drift is automatically handled: the physics engine computes actual ground
      // track (heading + wind), the snap corrects any lateral displacement, and
      // the net effect is the aircraft flies the correct wind-crab angle without
      // us computing it explicitly.
      ac.targetHeading = locCourse;

      // Glideslope
      const gsAngle = runway.glideslopeAngle ?? 3.0;
      const gsAlt = glideslopeAltitude(distToThreshold, runway.elevation, gsAngle);

      if (!ac.onGlideslope) {
        // Glideslope capture: aircraft within ±300ft of GS altitude
        if (ac.altitude <= gsAlt + 300 && ac.altitude >= gsAlt - 300 && distToThreshold < 20) {
          ac.onGlideslope = true;
        }
        // Below GS: hold level until GS descends to meet us
        if (ac.altitude < gsAlt - 300 && distToThreshold < 15) {
          ac.targetAltitude = Math.round(ac.altitude / 100) * 100;
          if (gsAlt <= ac.altitude + 200) {
            ac.onGlideslope = true;
          }
        }
        // Above GS: always descend toward it (no dead zone).
        // Target slightly below current GS to anticipate the closing distance.
        if (ac.altitude > gsAlt + 300 && distToThreshold < 25) {
          const closingNmPerSec = (ac.groundspeed || 180) / 3600;
          const futureDistNm = Math.max(0.5, distToThreshold - closingNmPerSec * 15);
          const futureGsAlt = glideslopeAltitude(futureDistNm, runway.elevation, gsAngle);
          ac.targetAltitude = Math.max(runway.elevation + 100, Math.round(futureGsAlt / 100) * 100);
        }

        // Fallback: if within 5nm and still not on GS, force-capture.
        // This handles edge cases where the aircraft slipped through the normal
        // capture windows (e.g., was slightly out of the ±300ft band during
        // a rapid descent, or GS convergence from below was too slow).
        if (!ac.onGlideslope && distToThreshold < 5 && ac.altitude < gsAlt + 500) {
          ac.onGlideslope = true;
        }

        // Speed reduction even before GS capture — aircraft on localizer close
        // to the field should be slowing regardless of glideslope status.
        if (distToThreshold < 10) {
          const perfFallback = performanceDB.getOrDefault(ac.typeDesignator);
          ac.targetSpeed = Math.min(ac.targetSpeed, perfFallback.speed.vapp + 20);
        }
      }

      if (ac.onGlideslope) {
        // Track the glideslope all the way down — a real ILS GS naturally
        // intercepts the runway at the touchdown zone (~1000ft past threshold).
        // The proportional controller in PhysicsEngine keeps VS around ~700 FPM
        // on a 3° path at approach speed, which is stable and realistic.
        ac.targetAltitude = Math.max(runway.elevation, gsAlt);

        // Progressive speed reduction on approach
        const perf = performanceDB.getOrDefault(ac.typeDesignator);
        if (distToThreshold < 10) {
          ac.targetSpeed = Math.min(ac.targetSpeed, perf.speed.vapp + 10);
        }
        if (distToThreshold < 6) {
          ac.targetSpeed = perf.speed.vapp;
        }
        if (distToThreshold < 2) {
          ac.targetSpeed = perf.speed.vref;
        }
      }

      // Unstable approach check: only when NOT on glideslope. On glideslope,
      // the proportional controller may momentarily push VS past -1200 to
      // correct deviations — that is normal convergence, not instability.
      // Off glideslope, a steep dive below 1000ft AGL is genuinely unstable.
      const aglForStability = ac.altitude - runway.elevation;
      if (!ac.onGlideslope && aglForStability < 1000 && ac.verticalSpeed < -1500) {
        ac.clearances.approach = null;
        ac.onLocalizer = false;
        ac.onGlideslope = false;
        ac.flightPhase = 'missed';
        ac.targetAltitude = runway.elevation + 3000;
        ac.targetHeading = initialBearing(runway.threshold, runway.end); // true bearing
        ac.clearances.heading = null;
        ac.clearances.turnDirection = null;
        const perf = performanceDB.getOrDefault(ac.typeDesignator);
        ac.targetSpeed = perf.speed.vapp + 20;
        return;
      }

      // Landing detection: aircraft is close to the runway and at a realistic
      // altitude for that distance.  On a 3° glideslope the aircraft is ~320ft
      // above field at 0.5nm and ~160ft at 0.25nm, so we accept any altitude
      // that is at or below the glideslope (+ small margin) at that distance.
      //
      // Also handle the case where aircraft has flown very close to or slightly
      // past the threshold — at that point it should land if at a low enough
      // altitude, regardless of precise GS tracking.
      const gsAtDist = glideslopeAltitude(distToThreshold, runway.elevation, runway.glideslopeAngle ?? 3.0);
      const landingAltThreshold = gsAtDist + 100; // generous margin for one-tick-lag altitude offset
      const closeEnoughToLand = distToThreshold <= 0.5;
      const lowEnoughToLand = ac.altitude <= landingAltThreshold && ac.altitude < runway.elevation + 500;
      // Absolute fallback: if within 0.15nm of threshold and below 200ft AGL,
      // land unconditionally — the aircraft is essentially at the runway.
      const absolutelyAtRunway = distToThreshold <= 0.15 && ac.altitude < runway.elevation + 200;
      if ((closeEnoughToLand && lowEnoughToLand) || absolutelyAtRunway) {
        const perf2 = performanceDB.getOrDefault(ac.typeDesignator);
        ac.flightPhase = 'landed';
        ac.onGround = true;
        ac.altitude = runway.elevation;
        ac.verticalSpeed = 0;
        ac.speed = perf2.speed.vref;
        ac.groundspeed = perf2.speed.vref;
        ac.targetSpeed = 15;
        // Use true bearing so the rollout direction matches the geographic runway
        // (same convention as snapToRunwayCenterline which uses initialBearing).
        const trueRunwayHeading = initialBearing(runway.threshold, runway.end);
        ac.heading = trueRunwayHeading;
        ac.targetHeading = trueRunwayHeading;
        ac.runwayOccupying = runway.id;
        ac.rolloutDistanceNm = 0;
        ac.clearances.approach = null;
        ac.onGlideslope = false;
        ac.onLocalizer = false;
      }
    }
  }

  private executeRNAV(ac: AircraftState, runway: Runway): void {
    const thresholdPos = runway.threshold;
    const distToThreshold = haversineDistance(ac.position, thresholdPos);
    const bearingToThreshold = initialBearing(ac.position, thresholdPos);

    ac.targetHeading = normalizeHeading(bearingToThreshold);

    if (distToThreshold < 10) {
      ac.flightPhase = 'final';
      const gsAlt = glideslopeAltitude(distToThreshold, runway.elevation, 3.0);
      ac.targetAltitude = Math.max(runway.elevation, gsAlt);

      const perf = performanceDB.getOrDefault(ac.typeDesignator);
      if (distToThreshold < 8) {
        ac.targetSpeed = perf.speed.vapp;
      }
    }

    // Landing detection: within 0.5nm and at realistic altitude
    const gsAtDistRnav = glideslopeAltitude(distToThreshold, runway.elevation, 3.0);
    const rnavLandingAlt = gsAtDistRnav + 100;
    const rnavCloseEnough = distToThreshold <= 0.5;
    const rnavLowEnough = ac.altitude <= rnavLandingAlt && ac.altitude < runway.elevation + 500;
    const rnavAbsolutelyAtRunway = distToThreshold <= 0.15 && ac.altitude < runway.elevation + 200;
    if ((rnavCloseEnough && rnavLowEnough) || rnavAbsolutelyAtRunway) {
      const perf2 = performanceDB.getOrDefault(ac.typeDesignator);
      ac.flightPhase = 'landed';
      ac.onGround = true;
      ac.altitude = runway.elevation;
      ac.verticalSpeed = 0;
      ac.speed = perf2.speed.vref;
      ac.groundspeed = perf2.speed.vref;
      ac.targetSpeed = 15;
      ac.heading = runway.heading;
      ac.targetHeading = runway.heading;
      ac.runwayOccupying = runway.id;
      ac.rolloutDistanceNm = 0;
      ac.clearances.approach = null;
      ac.onGlideslope = false;
      ac.onLocalizer = false;
    }
  }

  /**
   * Visual approach: track toward the runway threshold using the extended
   * centerline, with an inbound-side check so aircraft approaching from the
   * wrong direction are repositioned rather than U-turning to a fixed 5nm point.
   */
  private executeVisual(ac: AircraftState, runway: Runway, allAircraft?: AircraftState[]): void {
    const thresholdPos = runway.threshold;
    const distToThreshold = haversineDistance(ac.position, thresholdPos);
    const rwyHeading = runway.heading;
    const reciprocal = normalizeHeading(rwyHeading + 180);

    // Extended centerline reference (same as ILS)
    const farPoint = destinationPoint(thresholdPos, reciprocal, 30);
    const signedXtk = crossTrackDistance(ac.position, farPoint, thresholdPos);
    const xtk = Math.abs(signedXtk);

    // Is the aircraft approaching from the correct (inbound) side?
    const bearingFromThreshold = initialBearing(thresholdPos, ac.position);
    const angleFromReciprocal = Math.abs(headingDifference(reciprocal, bearingFromThreshold));
    const isInFront = angleFromReciprocal < 120;

    if (!ac.onLocalizer) {
      if (!isInFront) {
        // Wrong side — aim for a repositioning point 15nm out on final approach
        const entryPt = destinationPoint(thresholdPos, reciprocal, 15);
        ac.targetHeading = normalizeHeading(initialBearing(ac.position, entryPt));
      } else {
        // Inbound side — steer proportionally onto the centerline then track threshold
        if (xtk > 0.15) {
          const maxIntercept = Math.min(30, xtk * 8);
          const interceptAngle = signedXtk > 0 ? -maxIntercept : maxIntercept;
          ac.targetHeading = normalizeHeading(rwyHeading + interceptAngle);
        } else {
          ac.targetHeading = normalizeHeading(
            initialBearing(ac.position, thresholdPos)
          );
        }

        // Establish when aligned and reasonably close
        if (xtk < 1.5 && distToThreshold < 15) {
          ac.onLocalizer = true;
          ac.flightPhase = 'final';
          ac.clearances.heading = null;
          ac.clearances.turnDirection = null;
        }
      }

      // Descend toward glidepath regardless of lateral alignment
      const gsAlt = glideslopeAltitude(distToThreshold, runway.elevation, 3.0);
      if (ac.altitude > gsAlt + 500) {
        ac.targetAltitude = Math.max(runway.elevation + 1000, gsAlt + 200);
      }
    }

    if (ac.onLocalizer) {
      // Track centerline with proportional correction
      const correctionAngle = Math.max(-15, Math.min(15, -signedXtk * 20));
      ac.targetHeading = normalizeHeading(rwyHeading + correctionAngle);

      // Follow visual glidepath (3 degrees)
      const gsAlt = glideslopeAltitude(distToThreshold, runway.elevation, 3.0);
      ac.targetAltitude = Math.max(runway.elevation, gsAlt);
      ac.onGlideslope = true;

      const perf = performanceDB.getOrDefault(ac.typeDesignator);
      if (distToThreshold < 8) {
        ac.targetSpeed = perf.speed.vapp;
      }
      if (distToThreshold < 2) {
        ac.targetSpeed = perf.speed.vref;
      }
    }

    // Visual separation: if following traffic, slow down to maintain wake-safe distance
    if (ac.visualFollowTrafficCallsign && allAircraft) {
      const leader = allAircraft.find(a => a.callsign === ac.visualFollowTrafficCallsign);
      if (leader) {
        const gapNm = haversineDistance(ac.position, leader.position);
        const minSepNm = this.getVisualFollowMinSep(ac, leader);
        const perf = performanceDB.getOrDefault(ac.typeDesignator);
        if (gapNm < minSepNm) {
          // Too close: slow to 10kt below leader or vminFlaps+10, whichever is safer
          const slowTarget = Math.max(leader.speed - 10, perf.speed.vminFlaps + 10);
          ac.targetSpeed = Math.min(ac.targetSpeed, slowTarget);
        }
      } else {
        // Lead aircraft gone — clear following reference
        ac.visualFollowTrafficCallsign = undefined;
      }
    }

    // Landing detection: within 0.5nm and at realistic altitude
    const gsAtDistVis = glideslopeAltitude(distToThreshold, runway.elevation, 3.0);
    const visLandingAlt = gsAtDistVis + 100;
    const visCloseEnough = distToThreshold <= 0.5;
    const visLowEnough = ac.altitude <= visLandingAlt && ac.altitude < runway.elevation + 500;
    const visAbsolutelyAtRunway = distToThreshold <= 0.15 && ac.altitude < runway.elevation + 200;
    if ((visCloseEnough && visLowEnough) || visAbsolutelyAtRunway) {
      const perf2 = performanceDB.getOrDefault(ac.typeDesignator);
      ac.flightPhase = 'landed';
      ac.onGround = true;
      ac.altitude = runway.elevation;
      ac.verticalSpeed = 0;
      ac.speed = perf2.speed.vref;
      ac.groundspeed = perf2.speed.vref;
      ac.targetSpeed = 15;
      ac.heading = runway.heading;
      ac.targetHeading = runway.heading;
      ac.runwayOccupying = runway.id;
      ac.rolloutDistanceNm = 0;
      ac.clearances.approach = null;
      ac.onGlideslope = false;
      ac.onLocalizer = false;
      ac.visualFollowTrafficCallsign = undefined;
    }
  }

  /** Minimum separation (nm) for visual following based on wake categories */
  private getVisualFollowMinSep(follower: AircraftState, leader: AircraftState): number {
    // FAA 7110.65 wake turbulence minima for visual approaches in sequence
    const leaderCat = leader.wakeCategory;
    const followerCat = follower.wakeCategory;
    if (leaderCat === 'HEAVY' && followerCat !== 'HEAVY') return 5;
    if (leaderCat === 'HEAVY' && followerCat === 'HEAVY') return 4;
    if (leaderCat === 'LARGE' && followerCat === 'SMALL') return 3;
    return 3; // default minimum
  }

  private executeVNAV(ac: AircraftState): void {
    const route = ac.flightPlan.route;
    if (ac.currentFixIndex >= route.length) return;

    const legs = this.getProcedureLegs(ac);
    if (!legs) return;

    const perf = performanceDB.getOrDefault(ac.typeDesignator);

    // Look-ahead VNAV: scan ALL remaining fixes for altitude constraints.
    // For each "at" or "atOrBelow" constraint ahead, compute whether we need
    // to start descending NOW to make it at standard descent rate.
    // This gives realistic TOD behavior: aircraft start down well before the fix.
    if (ac.clearances.altitude === null) {
      for (let i = ac.currentFixIndex; i < route.length; i++) {
        const fixId = route[i];
        const leg = legs.find(l => l.fix?.id === fixId);
        if (!leg?.fix) continue;

        const c = leg.altitudeConstraint;
        if (!c) continue;

        // Only descend-to constraints: "at" or "atOrBelow" (or the max of "between")
        let targetAlt: number | null = null;
        if (c.type === 'at') targetAlt = c.altitude;
        else if (c.type === 'atOrBelow') targetAlt = c.altitude;
        else if (c.type === 'between') targetAlt = c.max;

        if (targetAlt !== null && ac.altitude > targetAlt + 50) {
          const distToFix = haversineDistance(ac.position, leg.fix.position);
          const gsKnots = Math.max(180, ac.groundspeed || 200);
          const timeToFixSec = (distToFix / gsKnots) * 3600;
          const altToLose = ac.altitude - targetAlt;
          const requiredVS = timeToFixSec > 0 ? (altToLose / timeToFixSec) * 60 : 9999;

          // Start descending if the required rate exceeds 40% of standard descent rate,
          // or if we're within 20nm (always prepare for constraints within 20nm).
          if (requiredVS > perf.descent.standardRate * 0.4 || distToFix < 20) {
            ac.targetAltitude = targetAlt;
            break; // Apply the nearest actionable constraint
          }
        }

        // For "atOrAbove" constraints on descents: enforce minimum altitude floor
        if ((c.type === 'atOrAbove' || c.type === 'between') && ac.clearances.altitude === null) {
          const minAlt = c.type === 'between' ? c.min : c.altitude;
          if (ac.targetAltitude < minAlt) {
            ac.targetAltitude = minAlt;
          }
        }
      }
    }

    // Apply the current fix's constraints precisely (overrides look-ahead if needed)
    const currentFixId = route[ac.currentFixIndex];
    for (const leg of legs) {
      if (leg.fix?.id === currentFixId) {
        if (leg.altitudeConstraint) {
          this.applyAltitudeConstraint(ac, leg.altitudeConstraint);
        }
        if (leg.speedConstraint) {
          this.applySpeedConstraint(ac, leg.speedConstraint);
        }
        break;
      }
    }
  }

  private applyAltitudeConstraint(
    ac: AircraftState,
    constraint: AltitudeConstraint
  ): void {
    // Only apply if no explicit ATC altitude clearance
    if (ac.clearances.altitude !== null) return;

    switch (constraint.type) {
      case 'at':
        ac.targetAltitude = constraint.altitude;
        break;
      case 'atOrAbove':
        if (ac.targetAltitude < constraint.altitude) {
          ac.targetAltitude = constraint.altitude;
        }
        break;
      case 'atOrBelow':
        if (ac.targetAltitude > constraint.altitude) {
          ac.targetAltitude = constraint.altitude;
        }
        break;
      case 'between':
        if (ac.targetAltitude < constraint.min) ac.targetAltitude = constraint.min;
        if (ac.targetAltitude > constraint.max) ac.targetAltitude = constraint.max;
        break;
    }
  }

  private applySpeedConstraint(
    ac: AircraftState,
    constraint: SpeedConstraint
  ): void {
    if (ac.clearances.speed !== null) return;

    switch (constraint.type) {
      case 'at':
        ac.targetSpeed = constraint.speed;
        break;
      case 'atOrBelow':
        if (ac.targetSpeed > constraint.speed) {
          ac.targetSpeed = constraint.speed;
        }
        break;
    }
  }

  private getProcedureLegs(ac: AircraftState): ProcedureLeg[] | null {
    if (!this.airportData) return null;

    if (ac.category === 'arrival' && ac.flightPlan.star) {
      const star = this.airportData.stars.find(
        s => s.name === ac.flightPlan.star
      );
      if (star) {
        // Collect all legs across common, enroute transitions, and runway transitions.
        // This ensures VNAV applies constraints for STARs whose legs live in transitions
        // rather than commonLegs (e.g. POWTN5, SPIDR5 where commonLegs is empty).
        const all: ProcedureLeg[] = [
          ...star.commonLegs,
          ...star.enrouteTransitions.flatMap(t => t.legs),
          ...star.runwayTransitions.flatMap(t => t.legs),
        ];
        return all.length > 0 ? all : null;
      }
    }

    if (ac.category === 'departure' && ac.flightPlan.sid) {
      const sid = this.airportData.sids.find(
        s => s.name === ac.flightPlan.sid
      );
      if (sid) {
        const all: ProcedureLeg[] = [
          ...sid.commonLegs,
          ...sid.runwayTransitions.flatMap(t => t.legs),
          ...sid.enrouteTransitions.flatMap(t => t.legs),
        ];
        return all.length > 0 ? all : null;
      }
    }

    return null;
  }

  private findFix(fixId: string): Position | null {
    if (!this.airportData) return null;

    const fix = this.airportData.fixes.find(f => f.id === fixId);
    if (fix) return fix.position;

    const navaid = this.airportData.navaids.find(n => n.id === fixId);
    if (navaid) return navaid.position;

    // Search procedure legs for embedded fixes
    for (const star of this.airportData.stars) {
      for (const leg of star.commonLegs) {
        if (leg.fix?.id === fixId) return leg.fix.position;
      }
    }
    for (const sid of this.airportData.sids) {
      for (const leg of sid.commonLegs) {
        if (leg.fix?.id === fixId) return leg.fix.position;
      }
    }
    for (const app of this.airportData.approaches) {
      for (const leg of app.legs) {
        if (leg.fix?.id === fixId) return leg.fix.position;
      }
    }

    return null;
  }
}
