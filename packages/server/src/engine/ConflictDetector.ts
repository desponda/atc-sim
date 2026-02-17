import type { AircraftState, Alert, AlertSeverity, AirportData, WakeCategory } from '@atc-sim/shared';
import { haversineDistance, destinationPoint, knotsToNmPerSecond, initialBearing } from '@atc-sim/shared';
import { v4 as uuid } from 'uuid';

/** TRACON separation minimums */
const LATERAL_SEP_NM = 3;
const VERTICAL_SEP_FT = 1000;

/** Prediction lookahead times (seconds) */
const LOOKAHEAD_TIMES = [30, 60, 120];

/** Minimum safe altitude for TRACON area (ft MSL) */
const DEFAULT_MVA = 2000;

/** Runway occupancy thresholds */
const ON_RUNWAY_DIST_NM = 0.5;
const ON_RUNWAY_ALT_AGL = 200;
const ON_FINAL_DIST_NM = 10;
const SHORT_FINAL_DIST_NM = 2;

/** Final approach separation minimums (nm) */
const FINAL_SEP_NM = 3;

/** Wake turbulence separation requirements (nm) - [leader][follower] */
const WAKE_SEP: Record<WakeCategory, Record<WakeCategory, number>> = {
  SUPER: { SUPER: 4, HEAVY: 6, LARGE: 7, SMALL: 8 },
  HEAVY: { SUPER: 4, HEAVY: 4, LARGE: 5, SMALL: 6 },
  LARGE: { SUPER: 3, HEAVY: 3, LARGE: 3, SMALL: 4 },
  SMALL: { SUPER: 3, HEAVY: 3, LARGE: 3, SMALL: 3 },
};

/** Information about an aircraft on final approach */
interface FinalApproachInfo {
  aircraft: AircraftState;
  runway: string;
  distanceToThreshold: number;
}

/**
 * ConflictDetector checks for separation violations and terrain/altitude alerts.
 */
export class ConflictDetector {
  private activeAlerts = new Map<string, Alert>();
  private airportData: AirportData | null = null;

  /** Aircraft IDs that have been flagged for automatic go-around */
  private goAroundTriggers: { aircraftId: string; reason: string }[] = [];

  setAirportData(data: AirportData): void {
    this.airportData = data;
  }

  /**
   * Run conflict detection for all aircraft. Returns new and updated alerts.
   */
  detect(aircraft: AircraftState[], simTime: number): Alert[] {
    const newAlerts: Alert[] = [];
    this.goAroundTriggers = [];

    // Clear expired alerts for aircraft no longer in the list
    const activeIds = new Set(aircraft.map(a => a.id));
    for (const [key, alert] of this.activeAlerts) {
      if (!alert.aircraftIds.every(id => activeIds.has(id))) {
        this.activeAlerts.delete(key);
      }
    }

    // Check all pairs for separation violations and predicted conflicts
    for (let i = 0; i < aircraft.length; i++) {
      for (let j = i + 1; j < aircraft.length; j++) {
        const a = aircraft[i];
        const b = aircraft[j];

        // Skip ground aircraft
        if (a.onGround || b.onGround) continue;
        // Skip aircraft that have landed or are in final
        if (a.flightPhase === 'landed' || b.flightPhase === 'landed') continue;

        // Current separation check
        const lateralNm = haversineDistance(a.position, b.position);
        const verticalFt = Math.abs(a.altitude - b.altitude);

        const pairKey = [a.id, b.id].sort().join(':');

        if (lateralNm < LATERAL_SEP_NM && verticalFt < VERTICAL_SEP_FT) {
          // Active conflict - always update with fresh distances
          const alertKey = `CA:${pairKey}`;
          const existing = this.activeAlerts.get(alertKey);
          const message = `CONFLICT ALERT: ${a.callsign} and ${b.callsign} - ${lateralNm.toFixed(1)}nm / ${verticalFt.toFixed(0)}ft`;

          if (existing) {
            // Update existing alert with current distances
            existing.message = message;
            existing.timestamp = simTime;
          } else {
            // New conflict
            const alert: Alert = {
              id: uuid(),
              type: 'conflict',
              severity: 'warning',
              aircraftIds: [a.id, b.id],
              message,
              timestamp: simTime,
            };
            this.activeAlerts.set(alertKey, alert);
            newAlerts.push(alert);
          }
        } else {
          // No current conflict; check predictions
          this.activeAlerts.delete(`CA:${pairKey}`);

          const predicted = this.predictConflict(a, b);
          if (predicted !== null) {
            const predKey = `PCA:${pairKey}`;
            const message = `PREDICTED CONFLICT: ${a.callsign} and ${b.callsign} in ~${predicted}s`;
            const existing = this.activeAlerts.get(predKey);

            if (existing) {
              // Update with current prediction
              existing.message = message;
              existing.timestamp = simTime;
            } else {
              const alert: Alert = {
                id: uuid(),
                type: 'conflict',
                severity: 'caution',
                aircraftIds: [a.id, b.id],
                message,
                timestamp: simTime,
              };
              this.activeAlerts.set(predKey, alert);
              newAlerts.push(alert);
            }
          } else {
            this.activeAlerts.delete(`PCA:${pairKey}`);
          }
        }
      }

      // MSAW check for each aircraft
      const ac = aircraft[i];
      if (!ac.onGround && ac.flightPhase !== 'landed' && ac.flightPhase !== 'final' && ac.flightPhase !== 'missed') {
        const mva = DEFAULT_MVA; // Could be position-based with real data
        if (ac.altitude < mva && ac.verticalSpeed <= 0) {
          const msawKey = `MSAW:${ac.id}`;
          const message = `MSAW: ${ac.callsign} at ${Math.round(ac.altitude)}ft, MVA ${mva}ft`;
          const existing = this.activeAlerts.get(msawKey);

          if (existing) {
            // Update with current altitude
            existing.message = message;
            existing.timestamp = simTime;
          } else {
            const alert: Alert = {
              id: uuid(),
              type: 'msaw',
              severity: 'warning',
              aircraftIds: [ac.id],
              message,
              timestamp: simTime,
            };
            this.activeAlerts.set(msawKey, alert);
            newAlerts.push(alert);
          }
        } else {
          this.activeAlerts.delete(`MSAW:${ac.id}`);
        }
      }
    }

    // Runway conflict detection and final approach spacing
    if (this.airportData) {
      const runwayAlerts = this.detectRunwayConflicts(aircraft, simTime);
      newAlerts.push(...runwayAlerts);

      const wakeAlerts = this.detectFinalApproachSpacing(aircraft, simTime);
      newAlerts.push(...wakeAlerts);
    }

    return newAlerts;
  }

  /**
   * Detect runway conflicts: aircraft on runway while another is on short final.
   */
  private detectRunwayConflicts(aircraft: AircraftState[], simTime: number): Alert[] {
    const newAlerts: Alert[] = [];
    if (!this.airportData) return newAlerts;

    for (const runway of this.airportData.runways) {
      const fieldElev = runway.elevation;

      // Find aircraft on the runway (within 0.5nm of threshold, below 200ft AGL)
      const onRunway = aircraft.filter(ac => {
        if (ac.flightPhase === 'landed' || ac.onGround) return false;
        const dist = haversineDistance(ac.position, runway.threshold);
        const agl = ac.altitude - fieldElev;
        return dist < ON_RUNWAY_DIST_NM && agl < ON_RUNWAY_ALT_AGL;
      });

      // Find aircraft on short final (within 2nm, on approach/final, descending)
      const onShortFinal = aircraft.filter(ac => {
        if (ac.flightPhase !== 'final' && ac.flightPhase !== 'approach') return false;
        if (!ac.clearances.approach || ac.clearances.approach.runway !== runway.id) return false;
        const dist = haversineDistance(ac.position, runway.threshold);
        return dist < SHORT_FINAL_DIST_NM && dist > ON_RUNWAY_DIST_NM;
      });

      // If someone is on the runway while another is on short final, alert
      for (const rwyAc of onRunway) {
        for (const finalAc of onShortFinal) {
          if (rwyAc.id === finalAc.id) continue;
          const pairKey = [rwyAc.id, finalAc.id].sort().join(':');
          const alertKey = `RWY:${pairKey}`;

          if (!this.activeAlerts.has(alertKey)) {
            const alert: Alert = {
              id: uuid(),
              type: 'runwayConflict',
              severity: 'warning',
              aircraftIds: [rwyAc.id, finalAc.id],
              message: `RUNWAY CONFLICT: ${rwyAc.callsign} on runway ${runway.id}, ${finalAc.callsign} on short final`,
              timestamp: simTime,
            };
            this.activeAlerts.set(alertKey, alert);
            newAlerts.push(alert);

            // Trigger automatic go-around for the aircraft on final
            this.goAroundTriggers.push({
              aircraftId: finalAc.id,
              reason: `traffic on runway ${runway.id}`,
            });
          }
        }
      }
    }

    return newAlerts;
  }

  /**
   * Detect final approach spacing violations and wake turbulence alerts.
   */
  private detectFinalApproachSpacing(aircraft: AircraftState[], simTime: number): Alert[] {
    const newAlerts: Alert[] = [];
    if (!this.airportData) return newAlerts;

    // Group aircraft on final by runway
    const finalByRunway = new Map<string, FinalApproachInfo[]>();

    for (const ac of aircraft) {
      if (ac.flightPhase !== 'final' && ac.flightPhase !== 'approach') continue;
      if (!ac.clearances.approach) continue;

      const rwyId = ac.clearances.approach.runway;
      const runway = this.airportData.runways.find(r => r.id === rwyId);
      if (!runway) continue;

      const dist = haversineDistance(ac.position, runway.threshold);
      if (dist > ON_FINAL_DIST_NM) continue;

      if (!finalByRunway.has(rwyId)) finalByRunway.set(rwyId, []);
      finalByRunway.get(rwyId)!.push({
        aircraft: ac,
        runway: rwyId,
        distanceToThreshold: dist,
      });
    }

    // Check each runway's final approach sequence
    for (const [rwyId, acOnFinal] of finalByRunway) {
      if (acOnFinal.length < 2) continue;

      // Sort by distance to threshold (closest first = leader)
      acOnFinal.sort((a, b) => a.distanceToThreshold - b.distanceToThreshold);

      for (let i = 0; i < acOnFinal.length - 1; i++) {
        const leader = acOnFinal[i];
        const follower = acOnFinal[i + 1];

        const spacing = follower.distanceToThreshold - leader.distanceToThreshold;
        const requiredSep = WAKE_SEP[leader.aircraft.wakeCategory][follower.aircraft.wakeCategory];

        if (spacing < requiredSep) {
          const pairKey = [leader.aircraft.id, follower.aircraft.id].sort().join(':');
          const alertKey = `WAKE:${pairKey}`;

          // Determine severity: less than standard (3nm) = warning, wake turbulence = caution
          const severity: AlertSeverity = spacing < FINAL_SEP_NM ? 'warning' : 'caution';
          const message = `WAKE TURBULENCE: ${follower.aircraft.callsign} ${spacing.toFixed(1)}nm behind ${leader.aircraft.callsign} (${leader.aircraft.wakeCategory}), need ${requiredSep}nm on runway ${rwyId}`;
          const existing = this.activeAlerts.get(alertKey);

          if (existing) {
            // Update with current spacing
            existing.message = message;
            existing.severity = severity;
            existing.timestamp = simTime;
          } else {
            const alert: Alert = {
              id: uuid(),
              type: 'wake',
              severity,
              aircraftIds: [leader.aircraft.id, follower.aircraft.id],
              message,
              timestamp: simTime,
            };
            this.activeAlerts.set(alertKey, alert);
            newAlerts.push(alert);
          }
        } else {
          const pairKey = [leader.aircraft.id, follower.aircraft.id].sort().join(':');
          this.activeAlerts.delete(`WAKE:${pairKey}`);
        }
      }
    }

    return newAlerts;
  }

  /**
   * Predict conflict using linear extrapolation at lookahead times.
   * Returns the earliest time in seconds at which a conflict is predicted, or null.
   */
  private predictConflict(a: AircraftState, b: AircraftState): number | null {
    for (const t of LOOKAHEAD_TIMES) {
      const posA = this.extrapolate(a, t);
      const posB = this.extrapolate(b, t);

      const lateralNm = haversineDistance(posA.position, posB.position);
      const verticalFt = Math.abs(posA.altitude - posB.altitude);

      if (lateralNm < LATERAL_SEP_NM && verticalFt < VERTICAL_SEP_FT) {
        return t;
      }
    }
    return null;
  }

  /**
   * Linear extrapolation of aircraft position.
   * Derives ground track from recent history trail positions when available,
   * falling back to heading. Does not model turns in progress.
   */
  private extrapolate(
    ac: AircraftState,
    seconds: number
  ): { position: { lat: number; lon: number }; altitude: number } {
    // Derive ground track from history trail if we have at least one prior position
    let track: number;
    if (ac.historyTrail.length > 0) {
      track = initialBearing(ac.historyTrail[0], ac.position);
    } else {
      track = ac.heading;
    }
    const distNm = knotsToNmPerSecond(ac.groundspeed) * seconds;
    const position = destinationPoint(ac.position, track, distNm);
    const altitude = ac.altitude + (ac.verticalSpeed / 60) * seconds;
    return { position, altitude };
  }

  /** Get all currently active alerts */
  getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values());
  }

  /** Get pair keys for currently active conflict alerts (CA: prefix) */
  getActiveConflictPairKeys(): string[][] {
    const pairs: string[][] = [];
    for (const key of this.activeAlerts.keys()) {
      if (key.startsWith('CA:')) {
        pairs.push(key.slice(3).split(':'));
      }
    }
    return pairs;
  }

  /** Get aircraft IDs that should execute automatic go-arounds */
  getGoAroundTriggers(): { aircraftId: string; reason: string }[] {
    return this.goAroundTriggers;
  }

  /** Clear all alerts */
  clear(): void {
    this.activeAlerts.clear();
  }
}
