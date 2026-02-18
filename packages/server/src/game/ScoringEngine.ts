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
  /** Aircraft IDs that already received the late-center-handoff penalty */
  private lateCenterHandoffPenalized = new Set<string>();
  /** Aircraft IDs that already received the missed-center-handoff penalty */
  private missedCenterHandoffPenalized = new Set<string>();
  /** Aircraft IDs that already received the late-inbound-accept penalty */
  private lateInboundAcceptPenalized = new Set<string>();

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
   *   - Late:   aircraft within 3nm of threshold on final without handingOff → -50 pts
   *   - Missed: aircraft landed without ever handingOff                       → -100 pts
   *
   * Center (departure) handoffs:
   *   - Late:   departure at FL160+ without accepted radar handoff             → -50 pts
   *   - Missed: departure beyond 40nm without handingOff                       → -100 pts
   *
   * Inbound handoff acceptance:
   *   - Late:   arrival inboundHandoff='offered' for >90s without acceptance   → -30 pts
   */
  checkHandoffPenalties(aircraft: AircraftState[], airportData: AirportData): void {
    const LATE_TOWER_DIST_NM = 3;
    const LATE_CENTER_ALT = 16000; // FL160
    const MISSED_CENTER_DIST_NM = 40;
    const LATE_INBOUND_ACCEPT_SECS = 90;

    for (const ac of aircraft) {
      if (ac.category === 'arrival' || ac.category === 'overflight') {
        // ---- Tower handoff checks (arrivals on final/approach) ----
        if (
          (ac.flightPhase === 'final' || ac.flightPhase === 'approach') &&
          !ac.handingOff
        ) {
          const runway = ac.flightPlan.runway
            ? airportData.runways.find(r => r.id === ac.flightPlan.runway)
            : null;
          if (runway) {
            const distNm = haversineDistance(ac.position, runway.threshold);

            // Late tower handoff: within 3nm without being handed off
            if (
              distNm < LATE_TOWER_DIST_NM &&
              !this.lateTowerHandoffPenalized.has(ac.id)
            ) {
              this.lateTowerHandoffPenalized.add(ac.id);
              this.handoffPenaltyPoints += 50;
            }
          }
        }

        // Missed tower handoff: landed without ever handing off
        if (
          ac.flightPhase === 'landed' &&
          !ac.handingOff &&
          !this.missedTowerHandoffPenalized.has(ac.id) &&
          !this.lateTowerHandoffPenalized.has(ac.id)
        ) {
          this.missedTowerHandoffPenalized.add(ac.id);
          this.handoffPenaltyPoints += 100;
        }

        // ---- Inbound handoff acceptance check ----
        if (
          ac.inboundHandoff === 'offered' &&
          ac.inboundHandoffOfferedAt !== undefined &&
          !this.lateInboundAcceptPenalized.has(ac.id)
        ) {
          const elapsedSecs = (Date.now() - ac.inboundHandoffOfferedAt) / 1000;
          if (elapsedSecs > LATE_INBOUND_ACCEPT_SECS) {
            this.lateInboundAcceptPenalized.add(ac.id);
            this.handoffPenaltyPoints += 30;
          }
        }
      }

      if (ac.category === 'departure') {
        // ---- Center handoff checks ----

        // Late center handoff: at FL160+ without accepted radar handoff
        if (
          ac.altitude >= LATE_CENTER_ALT &&
          ac.radarHandoffState !== 'accepted' &&
          !ac.handingOff &&
          !this.lateCenterHandoffPenalized.has(ac.id)
        ) {
          this.lateCenterHandoffPenalized.add(ac.id);
          this.handoffPenaltyPoints += 50;
        }

        // Missed center handoff: beyond 40nm without handingOff
        if (
          !ac.handingOff &&
          !this.missedCenterHandoffPenalized.has(ac.id) &&
          !this.lateCenterHandoffPenalized.has(ac.id)
        ) {
          const distNm = haversineDistance(ac.position, airportData.position);
          if (distNm > MISSED_CENTER_DIST_NM) {
            this.missedCenterHandoffPenalized.add(ac.id);
            this.handoffPenaltyPoints += 100;
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

    // Handoff timing penalties (late/missed tower, center, inbound accept)
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
    this.lateInboundAcceptPenalized.clear();
  }
}
