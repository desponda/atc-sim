import type { AircraftState, Alert } from '@atc-sim/shared';
import { formatAltitudeDataBlock, formatSpeedDataBlock } from '@atc-sim/shared';
import { STARSColors, STARSSizes, STARSFonts, STARSGlow } from '../rendering/STARSTheme';
import { Projection } from '../rendering/Projection';
import { TextRenderer } from '../rendering/TextRenderer';
import { DataBlockManager } from '../interaction/DataBlockManager';

/**
 * Layer 2: Aircraft targets, history trails, data blocks, leader lines, alerts.
 * Redraws every frame via requestAnimationFrame.
 */
export class TargetLayer {
  private ctx: CanvasRenderingContext2D;
  private projection: Projection;
  private textRenderer: TextRenderer;
  private dataBlockManager: DataBlockManager;
  private selectedAircraftId: string | null = null;
  private alertAircraftIds = new Set<string>();
  private cautionAircraftIds = new Set<string>();
  private historyTrailLength = 5;
  private velocityVectorMinutes = 1; // 0 = off, 1 or 2

  constructor(
    ctx: CanvasRenderingContext2D,
    projection: Projection,
    dataBlockManager: DataBlockManager
  ) {
    this.ctx = ctx;
    this.projection = projection;
    this.textRenderer = new TextRenderer(ctx);
    this.dataBlockManager = dataBlockManager;
  }

  setContext(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
    this.textRenderer.setContext(ctx);
  }

  setSelectedAircraft(id: string | null): void {
    this.selectedAircraftId = id;
  }

  setHistoryTrailLength(length: number): void {
    this.historyTrailLength = Math.max(0, Math.min(10, length));
  }

  setVelocityVectorMinutes(minutes: number): void {
    this.velocityVectorMinutes = Math.max(0, Math.min(2, minutes));
  }

  updateAlerts(alerts: Alert[]): void {
    this.alertAircraftIds.clear();
    this.cautionAircraftIds.clear();
    for (const alert of alerts) {
      const set = alert.severity === 'warning' ? this.alertAircraftIds : this.cautionAircraftIds;
      for (const id of alert.aircraftIds) {
        set.add(id);
      }
    }
  }

  private frameCount = 0;
  private altFilterLow = 0;
  private altFilterHigh = 99900;

  setAltitudeFilter(low: number, high: number): void {
    this.altFilterLow = low;
    this.altFilterHigh = high;
  }

  draw(width: number, height: number, aircraft: AircraftState[]): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    this.frameCount++;

    // Track active IDs for cleanup
    const activeIds = new Set<string>();

    for (const ac of aircraft) {
      if (ac.onGround && ac.flightPhase === 'landed') continue;

      // Altitude filter: hide aircraft outside the filter range
      if (ac.altitude < this.altFilterLow || ac.altitude > this.altFilterHigh) continue;

      activeIds.add(ac.id);

      const targetPos = this.projection.project(ac.position);

      // Draw history trail
      this.drawHistoryTrail(ac, targetPos);

      // Determine color with flashing for alerts
      const isAlert = this.alertAircraftIds.has(ac.id);
      const isCaution = this.cautionAircraftIds.has(ac.id);
      const flashOn = Math.floor(Date.now() / 250) % 2 === 0;

      let color: string;
      if (ac.inboundHandoff === 'pending') {
        // Center's en-route traffic — silent, dim gray; no alert, no blink
        color = STARSColors.coast;
      } else if (ac.inboundHandoff === 'offered') {
        // Center is offering this arrival to us — amber flash, distinct from outbound
        color = Math.floor(Date.now() / 500) % 2 === 0 ? STARSColors.inboundHandoffOffered : STARSColors.inboundHandoffOfferedDim;
      } else if (ac.inboundHandoff === 'accepted') {
        // Controller accepted, aircraft checking in — brief gray
        color = STARSColors.inboundHandoffAccepted;
      } else if (ac.handingOff) {
        color = STARSColors.coast;
      } else if (ac.radarHandoffState === 'offered') {
        color = Math.floor(Date.now() / 500) % 2 === 0 ? STARSColors.handoffOffered : STARSColors.handoffOfferedDim;
      } else if (ac.radarHandoffState === 'accepted') {
        color = STARSColors.handoffAccepted;
      } else if (isAlert) {
        color = flashOn ? STARSColors.alert : STARSColors.alertDim;
      } else if (isCaution) {
        color = flashOn ? STARSColors.caution : STARSColors.cautionDim;
      } else if (ac.id === this.selectedAircraftId) {
        color = STARSColors.selected;
      } else {
        color = STARSColors.normal;
      }

      // Draw velocity vector (predicted track line)
      if (this.velocityVectorMinutes > 0 && ac.groundspeed > 50) {
        this.drawVelocityVector(ac, targetPos, color);
      }

      // Draw primary target (filled square)
      this.drawTarget(targetPos.x, targetPos.y, color);

      // Draw data block + leader line
      this.drawDataBlock(ac, targetPos.x, targetPos.y, color);
    }

    // Cleanup stale data block positions
    this.dataBlockManager.cleanup(activeIds);
  }

  private drawVelocityVector(
    ac: AircraftState,
    targetPos: { x: number; y: number },
    color: string
  ): void {
    const ctx = this.ctx;
    // Project position forward by N minutes using heading + groundspeed
    const seconds = this.velocityVectorMinutes * 60;
    const distNm = (ac.groundspeed / 3600) * seconds;
    const headingRad = (ac.heading * Math.PI) / 180;

    // Approximate lat/lon offset (good enough for display)
    const dLat = (distNm / 60) * Math.cos(headingRad);
    const dLon = (distNm / 60) * Math.sin(headingRad) / Math.cos((ac.position.lat * Math.PI) / 180);
    const futurePos = this.projection.project({
      lat: ac.position.lat + dLat,
      lon: ac.position.lon + dLon,
    });

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(targetPos.x, targetPos.y);
    ctx.lineTo(futurePos.x, futurePos.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawTarget(x: number, y: number, color: string): void {
    const ctx = this.ctx;
    const s = STARSSizes.targetSize;

    // Phosphor glow on primary target - CRT bloom effect
    ctx.shadowBlur = STARSGlow.target;
    ctx.shadowColor = color;

    ctx.fillStyle = color;
    ctx.fillRect(x - s, y - s, s * 2, s * 2);

    // Reset glow
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  private drawHistoryTrail(ac: AircraftState, currentPos: { x: number; y: number }): void {
    if (this.historyTrailLength === 0) return;
    const ctx = this.ctx;
    const trail = ac.historyTrail;
    const count = Math.min(trail.length, this.historyTrailLength);

    // On real STARS, history dots are uniform brightness - no fading
    ctx.fillStyle = STARSColors.historyTrail;
    ctx.globalAlpha = 1;

    // Subtle phosphor glow on history dots
    ctx.shadowBlur = 2;
    ctx.shadowColor = STARSColors.glow;

    for (let i = 0; i < count; i++) {
      const pos = this.projection.project(trail[i]);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, STARSSizes.historyDotRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Reset glow
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  private drawDataBlock(
    ac: AircraftState,
    targetX: number,
    targetY: number,
    color: string
  ): void {
    const ctx = this.ctx;

    // Build STARS Full Data Block lines
    // Line 1: Callsign — no "H" indicator; handed-off aircraft just go gray
    const handoffIndicator = '';

    // Inbound handoff markers take priority over outbound radar handoff markers
    let radarHandoffMarker: string;
    if (ac.inboundHandoff === 'pending') {
      // Still with center — no marker
      radarHandoffMarker = '';
    } else if (ac.inboundHandoff === 'offered') {
      // Caret suffix indicates inbound offer from center (flashes with the color)
      radarHandoffMarker = Math.floor(Date.now() / 500) % 2 === 0 ? '^' : '';
    } else if (ac.inboundHandoff === 'accepted') {
      // No suffix during check-in transition
      radarHandoffMarker = '';
    } else if (ac.radarHandoffState === 'accepted') {
      radarHandoffMarker = 'J';
    } else if (ac.radarHandoffState === 'offered') {
      radarHandoffMarker = Math.floor(Date.now() / 500) % 2 === 0 ? '*' : '';
    } else {
      radarHandoffMarker = '';
    }

    const line1 = ac.callsign + handoffIndicator + (radarHandoffMarker ? ` ${radarHandoffMarker}` : '');
    // Line 2: Type + vertical trend arrow + CURRENT altitude + assigned altitude
    // Real STARS shows assigned altitude when it differs from current
    const climbArrow = ac.verticalSpeed > 200 ? '\u2191' : ac.verticalSpeed < -200 ? '\u2193' : ' ';
    const currentAlt = formatAltitudeDataBlock(ac.altitude);
    const assignedAlt = ac.clearances.altitude;
    const assignedAltStr = (assignedAlt !== null && Math.abs(assignedAlt - ac.altitude) > 200)
      ? ` ${formatAltitudeDataBlock(assignedAlt)}`
      : '';
    const line2 = `${ac.typeDesignator} ${climbArrow}${currentAlt}${assignedAltStr}`;
    // Line 3: Groundspeed (tens of knots) + scratchpad (approach or dest)
    const gs = formatSpeedDataBlock(ac.groundspeed);
    const scratchpad = this.getScratchpad(ac);
    const line3 = `${gs}  ${scratchpad}`;

    const lines = [line1, line2, line3];

    // Measure block size
    const fontSize = STARSFonts.dataBlock;
    const lineHeight = STARSSizes.dataBlockLineHeight;
    ctx.font = `${fontSize}px ${STARSFonts.family}`;
    let maxWidth = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > maxWidth) maxWidth = w;
    }
    const blockWidth = maxWidth + 4;
    const blockHeight = lines.length * lineHeight;

    // Update data block position
    const block = this.dataBlockManager.updateBlock(
      ac.id,
      targetX,
      targetY,
      blockWidth,
      blockHeight
    );

    // Compute leader line end point
    const computed = this.dataBlockManager.computeBlockPosition(
      targetX,
      targetY,
      block.direction,
      blockWidth,
      blockHeight
    );

    // Draw leader line with phosphor glow
    const leaderColor = color === STARSColors.selected ? STARSColors.leaderLine : color;
    ctx.shadowBlur = STARSGlow.leaderLine;
    ctx.shadowColor = leaderColor;
    ctx.strokeStyle = leaderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(targetX, targetY);
    ctx.lineTo(computed.leaderEndX, computed.leaderEndY);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    // Draw data block text with phosphor glow
    this.textRenderer.drawDataBlock(lines, block.x + 2, block.y, color, fontSize, lineHeight, true);

    // If selected, draw highlight border with white glow
    if (ac.id === this.selectedAircraftId) {
      ctx.shadowBlur = STARSGlow.dataBlock;
      ctx.shadowColor = STARSColors.selected;
      ctx.strokeStyle = STARSColors.selected;
      ctx.lineWidth = 1;
      ctx.strokeRect(block.x, block.y - 1, blockWidth, blockHeight + 2);
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  }

  /**
   * Generate scratchpad text for line 3 of the data block.
   * Priority: assigned approach > expected approach > destination
   */
  private getScratchpad(ac: AircraftState): string {
    // Show assigned approach: "I16", "R34", "V16"
    if (ac.clearances.approach) {
      const prefix = ac.clearances.approach.type === 'ILS' ? 'I'
        : ac.clearances.approach.type === 'RNAV' ? 'R'
        : 'V';
      return prefix + ac.clearances.approach.runway;
    }

    // Show expected approach in scratchpad
    if (ac.clearances.expectedApproach) {
      const prefix = ac.clearances.expectedApproach.type === 'ILS' ? 'I'
        : ac.clearances.expectedApproach.type === 'RNAV' ? 'R'
        : 'V';
      return 'E' + prefix + ac.clearances.expectedApproach.runway;
    }

    // Default: show destination (strip 'K' prefix for display)
    if (ac.flightPlan.arrival && ac.flightPlan.arrival !== ac.flightPlan.departure) {
      const dest = ac.flightPlan.arrival;
      return dest.startsWith('K') ? dest.substring(1) : dest;
    }

    return '';
  }
}
