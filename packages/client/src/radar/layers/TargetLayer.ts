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

  draw(width: number, height: number, aircraft: AircraftState[]): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    this.frameCount++;

    // Track active IDs for cleanup
    const activeIds = new Set<string>();

    for (const ac of aircraft) {
      if (ac.onGround && ac.flightPhase === 'landed') continue;
      activeIds.add(ac.id);

      const targetPos = this.projection.project(ac.position);

      // Draw history trail
      this.drawHistoryTrail(ac, targetPos);

      // Determine color (coast targets are gray)
      const color = ac.handingOff
        ? STARSColors.coast
        : this.getAircraftColor(ac.id);

      // Draw primary target (filled square)
      this.drawTarget(targetPos.x, targetPos.y, color);

      // Draw data block + leader line
      this.drawDataBlock(ac, targetPos.x, targetPos.y, color);
    }

    // Cleanup stale data block positions
    this.dataBlockManager.cleanup(activeIds);
  }

  private getAircraftColor(id: string): string {
    if (this.alertAircraftIds.has(id)) return STARSColors.alert;
    if (this.cautionAircraftIds.has(id)) return STARSColors.caution;
    if (id === this.selectedAircraftId) return STARSColors.selected;
    return STARSColors.normal;
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
    // Line 1: Callsign + handoff indicator
    const handoffIndicator = ac.handingOff
      ? (this.frameCount % 2 === 0 ? ' H' : '  ') // Flashing "H"
      : '';
    const line1 = ac.callsign + handoffIndicator;
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
