import type { ScoreMetrics, Alert, AircraftState, AirportData } from '@atc-sim/shared';
import { haversineDistance } from '@atc-sim/shared';

/**
 * ScoringEngine tracks controller performance metrics.
 *
 * Scoring philosophy:
 * - Base score: 100
 * - Separation violation: -5 per incident, -1 per additional tick of violation
 * - MSAW: -3 per incident
 * - Late/missed handoff: -2 per incident
 * - Excessive delay: -1 per 2 minutes average delay beyond 5 minutes
 * - Efficiency bonus: +1 for each aircraft handled without issues
 * - Grade thresholds: A=90+, B=80-89, C=70-79, D=60-69, F=<60
 */
export class ScoringEngine {
  private metrics: ScoreMetrics = {
    separationViolations: 0,
    violationDuration: 0,
    conflictAlerts: 0,
    aircraftHandled: 0,
    averageDelay: 0,
    commandsIssued: 0,
    handoffQuality: 100,
    missedHandoffs: 0,
    overallScore: 100,
    grade: 'A',
  };

  private totalDelay = 0;
  private activeViolations = new Set<string>();
  private msawIncidents = 0;
  private cleanAircraft = 0; // aircraft handled without any issues

  // ---- Handoff penalty tracking (avoid double-penalizing) ----
  /** Aircraft IDs that already received the late-tower-handoff penalty */
  private lateTowerHandoffPenalized = new Set<string>();
  /** Aircraft IDs that already received the missed-tower-handoff penalty */
  private missedTowerHandoffPenalized = new Set<string>();
  /** Aircraft IDs that received the late-center-handoff penalty (departure above FL180) */
  private lateCenterHandoffPenalized = new Set<string>();
  /** Aircraft IDs that received the missed-center-handoff penalty (departure beyond 40nm) */
  private missedCenterHandoffPenalized = new Set<string>();
  /** Tick when each departure was first seen airborne (for grace period) */
  private departureAirborneAt = new Map<string, number>();

  /** Accumulated penalty points from handoff timing (subtracted in calculateScore) */
  private handoffPenaltyPoints = 0;

  /** Record a new alert */
  recordAlert(alert: Alert): void {
    if (alert.type === 'conflict') {
      if (alert.severity === 'warning') {
        // Active separation violation
        const key = alert.aircraftIds.sort().join(':');
        if (!this.activeViolations.has(key)) {
          this.activeViolations.add(key);
          this.metrics.separationViolations++;
        }
      }
      this.metrics.conflictAlerts++;
    } else if (alert.type === 'msaw') {
      this.msawIncidents++;
    }
  }

  /** Update per tick - track violation duration */
  update(): void {
    // Each active violation adds 1 second of violation duration
    this.metrics.violationDuration += this.activeViolations.size;

    // Recalculate score
    this.calculateScore();
  }

  /** Clear active violations that are no longer active */
  clearViolation(aircraftIds: string[]): void {
    const key = aircraftIds.sort().join(':');
    this.activeViolations.delete(key);
  }

  /** Sync active violations with conflict detector's current state */
  syncActiveViolations(activePairs: string[][]): void {
    const activeKeys = new Set(activePairs.map(pair => [...pair].sort().join(':')));
    for (const key of this.activeViolations) {
      if (!activeKeys.has(key)) {
        this.activeViolations.delete(key);
      }
    }
  }

  /** Record a command issued by the controller */
  recordCommand(): void {
    this.metrics.commandsIssued++;
  }

  /** Apply a point penalty for a bad command (e.g. invalid frequency) */
  recordBadCommand(points: number): void {
    this.metrics.overallScore = Math.max(0, this.metrics.overallScore - points);
    this.calculateScore();
  }

  /** Record an aircraft handled (arrived/departed successfully) */
  recordAircraftHandled(delaySec: number = 0): void {
    this.metrics.aircraftHandled++;
    this.totalDelay += delaySec;
    this.metrics.averageDelay =
      this.metrics.aircraftHandled > 0
        ? this.totalDelay / this.metrics.aircraftHandled
        : 0;

    // Track clean aircraft (delay under 5 min = 300s)
    if (delaySec < 300) {
      this.cleanAircraft++;
    }
  }

  /** Record handoff quality event */
  recordHandoff(quality: number): void {
    // Running average
    const total = this.metrics.aircraftHandled || 1;
    this.metrics.handoffQuality =
      (this.metrics.handoffQuality * (total - 1) + quality) / total;
  }

  /** Record a missed handoff (aircraft left airspace without proper handoff) */
  recordMissedHandoff(): void {
    this.metrics.missedHandoffs++;
  }

  /**
   * Check handoff timing penalties. Call once per tick from SimulationEngine.
   *
   * Tower handoffs (arrivals):
   *   - Late:   aircraft within 2nm of threshold on final without handingOff → -5 pts
   *   - Missed: aircraft landed without ever handingOff                       → -10 pts
   *   Only checked for arrivals where the player accepted the inbound handoff.
   *
   * Center handoffs (departures):
   *   - Late:   departure above FL180 without handoff (after grace period)   → -5 pts
   *   - Missed: departure beyond 40nm without handoff (after grace period)   → -10 pts
   *   Grace period: 300 ticks from when we first see the aircraft airborne,
   *   preventing false positives at game start or high time scales.
   */
  checkHandoffPenalties(aircraft: AircraftState[], airportData: AirportData, currentTick: number): void {
    const LATE_TOWER_DIST_NM = 2;
    const LATE_CENTER_ALT = 18000;    // FL180
    const MISSED_CENTER_DIST_NM = 40; // nm from airport
    // Grace period for tower handoffs: inbound offered at least this many ticks ago
    const INBOUND_GRACE_TICKS = 90;
    // Grace period for center handoffs: departure airborne for at least this many ticks
    // before we start enforcing FL180/40nm thresholds
    const DEPARTURE_GRACE_TICKS = 300;

    for (const ac of aircraft) {
      // ---- Arrival/overflight: tower handoff checks ----
      if (ac.category === 'arrival' || ac.category === 'overflight') {
        const inboundAgeTicks = ac.inboundHandoffOfferedAt !== undefined
          ? currentTick - ac.inboundHandoffOfferedAt
          : Infinity;
        const pastGrace = inboundAgeTicks >= INBOUND_GRACE_TICKS;

        // Late tower handoff: within 2nm on final without handing off
        if (
          pastGrace &&
          ac.flightPhase === 'final' &&
          ac.inboundHandoff === 'accepted' &&
          !ac.handingOff
        ) {
          const runway = ac.flightPlan.runway
            ? airportData.runways.find(r => r.id === ac.flightPlan.runway)
            : null;
          if (runway) {
            const distNm = haversineDistance(ac.position, runway.threshold);
            if (distNm < LATE_TOWER_DIST_NM && !this.lateTowerHandoffPenalized.has(ac.id)) {
              this.lateTowerHandoffPenalized.add(ac.id);
              this.handoffPenaltyPoints += 5;
            }
          }
        }

        // Missed tower handoff: landed without handing off (only for accepted inbound)
        if (
          pastGrace &&
          ac.flightPhase === 'landed' &&
          ac.inboundHandoff === 'accepted' &&
          !ac.handingOff &&
          !this.missedTowerHandoffPenalized.has(ac.id) &&
          !this.lateTowerHandoffPenalized.has(ac.id)
        ) {
          this.missedTowerHandoffPenalized.add(ac.id);
          this.handoffPenaltyPoints += 10;
        }
      }

      // ---- Departure: center handoff checks ----
      if (
        ac.category === 'departure' &&
        (ac.flightPhase === 'climb' || ac.flightPhase === 'cruise')
      ) {
        // Record when we first saw this departure airborne
        if (!this.departureAirborneAt.has(ac.id)) {
          this.departureAirborneAt.set(ac.id, currentTick);
        }
        const airborneAge = currentTick - (this.departureAirborneAt.get(ac.id) ?? currentTick);

        // Only enforce after grace period — gives player time to issue handoff
        if (airborneAge >= DEPARTURE_GRACE_TICKS && !ac.handingOff) {
          // Late center handoff: above FL180 without handing off to center
          if (ac.altitude >= LATE_CENTER_ALT && !this.lateCenterHandoffPenalized.has(ac.id)) {
            this.lateCenterHandoffPenalized.add(ac.id);
            this.handoffPenaltyPoints += 5;
          }

          // Missed center handoff: beyond 40nm without handing off
          const distNm = haversineDistance(ac.position, airportData.position);
          if (distNm > MISSED_CENTER_DIST_NM && !this.missedCenterHandoffPenalized.has(ac.id)) {
            this.missedCenterHandoffPenalized.add(ac.id);
            this.handoffPenaltyPoints += 10;
          }
        }
      }
    }
  }

  private calculateScore(): void {
    let score = 100;

    // -5 per separation violation incident
    score -= this.metrics.separationViolations * 5;

    // -1 per 30 seconds of ongoing violation (slow accumulation)
    score -= Math.floor(this.metrics.violationDuration / 30);

    // -3 per MSAW incident
    score -= this.msawIncidents * 3;

    // -2 per missed handoff
    score -= this.metrics.missedHandoffs * 2;

    // -1 per 2 minutes of average delay beyond 5 minutes (300s)
    const excessDelay = Math.max(0, this.metrics.averageDelay - 300);
    score -= Math.floor(excessDelay / 120);

    // +1 per aircraft handled cleanly (no issues)
    score += this.cleanAircraft * 1;

    // Handoff timing penalties (late/missed tower and center handoffs)
    score -= this.handoffPenaltyPoints;

    this.metrics.overallScore = Math.max(0, Math.min(100, Math.round(score)));
    this.metrics.grade = this.gradeFromScore(this.metrics.overallScore);
  }

  private gradeFromScore(
    score: number
  ): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  /** Get current metrics */
  getMetrics(): ScoreMetrics {
    return { ...this.metrics };
  }

  /** Reset all metrics */
  reset(): void {
    this.metrics = {
      separationViolations: 0,
      violationDuration: 0,
      conflictAlerts: 0,
      aircraftHandled: 0,
      averageDelay: 0,
      commandsIssued: 0,
      handoffQuality: 100,
      missedHandoffs: 0,
      overallScore: 100,
      grade: 'A',
    };
    this.totalDelay = 0;
    this.activeViolations.clear();
    this.msawIncidents = 0;
    this.cleanAircraft = 0;
    this.handoffPenaltyPoints = 0;
    this.lateTowerHandoffPenalized.clear();
    this.missedTowerHandoffPenalized.clear();
    this.lateCenterHandoffPenalized.clear();
    this.missedCenterHandoffPenalized.clear();
    this.departureAirborneAt.clear();
  }
}
