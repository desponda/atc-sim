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
   */
  execute(ac: AircraftState): void {
    // If heading is assigned by ATC, don't follow LNAV
    const hasAtcHeading = ac.clearances.heading !== null;

    // Missed approach procedure: climb on runway heading, then follow missed approach legs
    if (ac.flightPhase === 'missed') {
      this.executeMissedApproach(ac);
      return;
    }

    // ILS approach tracking takes priority
    if (ac.clearances.approach) {
      this.executeApproach(ac);
      return;
    }

    // Direct-to fix
    if (ac.clearances.directFix) {
      this.executeDirect(ac);
      return;
    }

    // Follow route/procedure if no ATC heading override
    if (!hasAtcHeading) {
      this.executeRouteNavigation(ac);
    }

    // Apply VNAV from procedure constraints
    if (ac.clearances.descendViaSTAR || ac.clearances.climbViaSID) {
      this.executeVNAV(ac);
    }

    // For arrivals with no explicit ATC altitude clearance and no approach,
    // gently descend toward a reasonable altitude. This simulates being
    // descended by a previous controller before being handed off to us.
    // Works alongside VNAV: auto-descent handles gradual step-downs while
    // VNAV handles specific procedure altitude constraints.
    if (ac.category === 'arrival' && ac.clearances.altitude === null &&
        !ac.clearances.approach && this.airportData) {
      // If the aircraft is level (not already descending to a different target),
      // give it a descent target. Arrivals should always be working their way
      // down to the approach altitude (~3000ft AGL).
      const approachAlt = this.airportData.elevation + 3000;
      if (ac.targetAltitude > approachAlt && Math.abs(ac.targetAltitude - ac.altitude) < 100) {
        // Step-down: descend 2000ft at a time toward approach altitude
        const stepTarget = Math.max(approachAlt, ac.altitude - 2000);
        ac.targetAltitude = Math.round(stepTarget / 100) * 100;
      }
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

    if (isGA) {
      // GA aircraft: cruise at typical speed (usually 100-150kt)
      ac.targetSpeed = Math.min(perf.speed.typicalCruiseIAS, perf.speed.vmo);
      return;
    }

    if (ac.category === 'arrival') {
      // Below 10,000ft: max 250kt
      if (ac.altitude < 10000) {
        const maxSpeed = Math.min(perf.speed.vmaxBelow10k, 250);
        if (ac.targetSpeed > maxSpeed) {
          ac.targetSpeed = maxSpeed;
        }
      }

      // Within 20nm and below 10,000ft: slow to ~210kt
      if (distToAirport < 20 && ac.altitude < 10000) {
        const targetSpd = Math.max(210, perf.speed.vapp + 30);
        if (ac.targetSpeed > targetSpd) {
          ac.targetSpeed = targetSpd;
        }
      }

      // Within 12nm: slow to ~180kt
      if (distToAirport < 12 && ac.altitude < 6000) {
        const targetSpd = Math.max(180, perf.speed.vapp + 20);
        if (ac.targetSpeed > targetSpd) {
          ac.targetSpeed = targetSpd;
        }
      }
    } else if (ac.category === 'departure') {
      // Departures: below 10,000ft maintain 250kt max
      if (ac.altitude < 10000) {
        const maxSpeed = Math.min(perf.speed.vmaxBelow10k, 250);
        if (ac.targetSpeed > maxSpeed) {
          ac.targetSpeed = maxSpeed;
        }
        // Below 3000ft AGL, maintain lower speed
        if (this.airportData && ac.altitude < this.airportData.elevation + 3000) {
          ac.targetSpeed = Math.min(ac.targetSpeed, 200);
        }
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

  private executeRouteNavigation(ac: AircraftState): void {
    const route = ac.flightPlan.route;
    if (route.length === 0 || ac.currentFixIndex >= route.length) return;

    const targetFixId = route[ac.currentFixIndex];
    const fix = this.findFix(targetFixId);
    if (!fix) {
      // Skip unfound fix
      ac.currentFixIndex++;
      return;
    }

    const bearing = initialBearing(ac.position, fix);
    const distance = haversineDistance(ac.position, fix);

    // Only update target heading if the fix is ahead of us or we're close.
    // For aircraft that just spawned, only start LNAV if the course correction
    // is reasonable (< 45 deg) or the fix is getting close. This prevents
    // newly-spawned aircraft from immediately banking hard.
    const courseDiff = Math.abs(headingDifference(ac.heading, bearing));
    if (courseDiff < 45 || distance < 10) {
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

  private executeApproach(ac: AircraftState): void {
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
        this.executeVisual(ac, runway);
        break;
    }
  }

  private executeILS(ac: AircraftState, runway: Runway): void {
    const locCourse = runway.ilsCourse ?? runway.heading;
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
      // Build a point far behind the runway on the localizer course to define
      // the centerline path, then measure aircraft distance from that line.
      const reciprocal = normalizeHeading(locCourse + 180);
      const farPoint = destinationPoint(thresholdPos, reciprocal, 30);
      const xtk = Math.abs(crossTrackDistance(ac.position, thresholdPos, farPoint));

      // How close our heading is to the localizer course.
      // Use assigned heading if available — aircraft may still be turning toward
      // its assigned intercept heading and the instantaneous heading could
      // temporarily exceed the intercept angle threshold.
      const effectiveHeading = ac.clearances.heading ?? ac.heading;
      const headingToLoc = Math.abs(headingDifference(effectiveHeading, locCourse));

      // Ensure the aircraft is on the inbound side (not behind the runway).
      // bearingFromThreshold pointing away from aircraft should be roughly
      // the reciprocal of the localizer course if the aircraft is in front.
      const bearingFromThreshold = initialBearing(thresholdPos, ac.position);
      const angleFromReciprocal = Math.abs(headingDifference(reciprocal, bearingFromThreshold));
      const isInFront = angleFromReciprocal < 90;

      // Intercept criteria using cross-track distance:
      // - Within 1nm of the extended centerline (cross-track) — realistic ILS beam width
      // - Aircraft heading within 45° of localizer course
      // - Within 25nm of threshold
      // - Aircraft is in front of the runway (on the approach side)
      if (xtk < 1.0 && headingToLoc < 45 && distToThreshold < 25 && isInFront) {
        ac.onLocalizer = true;
        ac.flightPhase = 'final';
        // Once intercepting, cancel any ATC heading so localizer tracking takes over
        ac.clearances.heading = null;
        ac.clearances.turnDirection = null;
        // FAA: "maintain until established" - now established, release altitude restriction
        if (ac.clearances.maintainUntilEstablished !== null) {
          ac.clearances.maintainUntilEstablished = null;
          ac.clearances.altitude = null; // Let glideslope control altitude
        }
      } else if (!hasAtcHeading) {
        if (!isInFront) {
          // Aircraft is behind the runway -- fly toward a point well ahead
          // on the approach side (15nm from threshold on the reciprocal course).
          // This brings the aircraft around to the correct side for intercept.
          const entryPt = destinationPoint(thresholdPos, reciprocal, 15);
          const bearingToEntry = initialBearing(ac.position, entryPt);
          ac.targetHeading = normalizeHeading(bearingToEntry);
        } else if (distToThreshold < 25) {
          // Aircraft is on the approach side -- steer to intercept the localizer.
          // Use an intercept angle proportional to cross-track distance.
          if (xtk > 0.3) {
            const signedXtk = crossTrackDistance(ac.position, farPoint, thresholdPos);
            const maxIntercept = Math.min(30, xtk * 10);
            const interceptAngle = signedXtk > 0 ? -maxIntercept : maxIntercept;
            ac.targetHeading = normalizeHeading(locCourse + interceptAngle);
          } else {
            ac.targetHeading = normalizeHeading(locCourse);
          }
        }
      }
      // If the controller has assigned a heading (e.g., "fly heading 130"),
      // let the aircraft fly it -- the physics engine will turn toward the
      // target heading and the next tick we check intercept criteria again.
    }

    if (ac.onLocalizer) {
      // Track the localizer by steering toward a point on the extended centerline
      // slightly ahead of the aircraft. This avoids the angular correction problem
      // where adding degrees to the localizer course heading barely affects the
      // lateral component for near-north/south courses.
      const reciprocal = normalizeHeading(locCourse + 180);

      // Aim for a point on the centerline 2-3nm ahead (closer to runway).
      // When very close, aim directly at the threshold.
      const aimDist = Math.max(0, distToThreshold - Math.min(3, distToThreshold * 0.3));
      const aimPoint = aimDist > 0.5
        ? destinationPoint(thresholdPos, reciprocal, aimDist)
        : thresholdPos;
      const bearingToAim = initialBearing(ac.position, aimPoint);
      // Clamp the heading correction to ±20° from the localizer course to avoid
      // wild heading swings while still converging on the centerline.
      const hdgDiff = headingDifference(locCourse, bearingToAim);
      const clampedDiff = Math.max(-20, Math.min(20, hdgDiff));
      ac.targetHeading = normalizeHeading(locCourse + clampedDiff);

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
      }

      if (ac.onGlideslope) {
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

      // Landing detection: within 0.5nm of threshold and close to runway elevation
      if (distToThreshold < 0.5 && ac.altitude < runway.elevation + 150) {
        ac.flightPhase = 'landed';
        ac.onGround = true;
        ac.altitude = runway.elevation;
        ac.verticalSpeed = 0;
        ac.speed = 0;
        ac.targetSpeed = 0;
        ac.groundspeed = 0;
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

    if (distToThreshold < 0.3 && ac.altitude < runway.elevation + 100) {
      ac.flightPhase = 'landed';
      ac.onGround = true;
      ac.altitude = runway.elevation;
      ac.verticalSpeed = 0;
      ac.speed = 0;
      ac.targetSpeed = 0;
      ac.groundspeed = 0;
    }
  }

  /**
   * Visual approach: fly direct to a point on extended centerline, then track to runway.
   * Similar to RNAV but with a direct-to-final behavior.
   */
  private executeVisual(ac: AircraftState, runway: Runway): void {
    const thresholdPos = runway.threshold;
    const distToThreshold = haversineDistance(ac.position, thresholdPos);
    const bearingToThreshold = initialBearing(ac.position, thresholdPos);
    const rwyHeading = runway.heading;

    // If far out, fly toward a point ~5nm on extended centerline
    if (distToThreshold > 6 && !ac.onLocalizer) {
      // Aim for a point 5nm from threshold on runway heading (reverse direction)
      const reciprocal = normalizeHeading(rwyHeading + 180);
      const interceptPt = destinationPoint(thresholdPos, reciprocal, 5);
      const bearingToIntercept = initialBearing(ac.position, interceptPt);
      ac.targetHeading = normalizeHeading(bearingToIntercept);

      // Start descending toward approach altitude
      const gsAlt = glideslopeAltitude(distToThreshold, runway.elevation, 3.0);
      if (ac.altitude > gsAlt + 500) {
        ac.targetAltitude = Math.max(runway.elevation + 1000, gsAlt + 200);
      }
    } else {
      // Close in: track runway centerline
      ac.onLocalizer = true;
      ac.flightPhase = 'final';

      const locDev = headingDifference(rwyHeading, bearingToThreshold);
      const correction = Math.max(-10, Math.min(10, locDev * 3));
      ac.targetHeading = normalizeHeading(rwyHeading + correction);

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

    // Landing detection
    if (distToThreshold < 0.3 && ac.altitude < runway.elevation + 100) {
      ac.flightPhase = 'landed';
      ac.onGround = true;
      ac.altitude = runway.elevation;
      ac.verticalSpeed = 0;
      ac.speed = 0;
      ac.targetSpeed = 0;
      ac.groundspeed = 0;
    }
  }

  private executeVNAV(ac: AircraftState): void {
    // Look at the current route fix for altitude/speed constraints
    const route = ac.flightPlan.route;
    if (ac.currentFixIndex >= route.length) return;

    const legs = this.getProcedureLegs(ac);
    if (!legs) return;

    // Find the current leg's constraints
    const targetFixId = route[ac.currentFixIndex];
    for (const leg of legs) {
      if (leg.fix?.id === targetFixId) {
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
      if (star) return star.commonLegs;
    }

    if (ac.category === 'departure' && ac.flightPlan.sid) {
      const sid = this.airportData.sids.find(
        s => s.name === ac.flightPlan.sid
      );
      if (sid) return sid.commonLegs;
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
