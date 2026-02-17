import { STARSColors, STARSFonts, STARSGlow } from '../rendering/STARSTheme';
import { Projection } from '../rendering/Projection';

/**
 * Layer 0: Range rings, compass rose, range labels, and north indicator.
 * Renders with authentic STARS CRT phosphor glow effects.
 * Range rings are barely visible, just like a real STARS TRACON display.
 * Only redraws on resize or range change.
 */
export class BackgroundLayer {
  private ctx: CanvasRenderingContext2D;
  private projection: Projection;

  constructor(ctx: CanvasRenderingContext2D, projection: Projection) {
    this.ctx = ctx;
    this.projection = projection;
  }

  setContext(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
  }

  draw(width: number, height: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    // Fill background - pure black like a real CRT
    ctx.fillStyle = STARSColors.background;
    ctx.fillRect(0, 0, width, height);

    const center = this.projection.getCenter();
    const screenCenter = this.projection.project(center);
    const scale = this.projection.getScale();
    const range = this.projection.getRange();

    // Draw range rings with phosphor glow
    const ringIntervals = this.getRingIntervals(range);
    this.drawRangeRings(ctx, screenCenter, scale, ringIntervals);

    // Draw compass rose around the outermost ring
    const maxRingNm = ringIntervals[ringIntervals.length - 1];
    const maxRadius = maxRingNm * scale;
    this.drawCompassRose(ctx, screenCenter.x, screenCenter.y, maxRadius);

    // Draw north arrow indicator above the compass rose
    this.drawNorthIndicator(ctx, screenCenter.x, screenCenter.y, maxRadius);
  }

  private getRingIntervals(range: number): number[] {
    if (range <= 10) return [5, 10];
    if (range <= 20) return [5, 10, 20];
    if (range <= 40) return [10, 20, 30, 40];
    if (range <= 60) return [10, 20, 30, 40, 50, 60];
    return [20, 40, 60, 80, 100, 120];
  }

  private drawRangeRings(
    ctx: CanvasRenderingContext2D,
    screenCenter: { x: number; y: number },
    scale: number,
    ringIntervals: number[],
  ): void {
    // Enable phosphor glow for range rings
    ctx.shadowBlur = STARSGlow.rings;
    ctx.shadowColor = STARSColors.glow;
    ctx.strokeStyle = STARSColors.rings;
    ctx.lineWidth = 0.5;

    for (const interval of ringIntervals) {
      const radiusPx = interval * scale;
      if (radiusPx < 20) continue;

      // Draw the ring
      ctx.beginPath();
      ctx.arc(screenCenter.x, screenCenter.y, radiusPx, 0, Math.PI * 2);
      ctx.stroke();

      // Label ring distance at the 3-o'clock position (right side)
      // Very dim text, just barely readable
      ctx.font = `${STARSFonts.mapLabel}px ${STARSFonts.family}`;
      ctx.fillStyle = STARSColors.rings;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${interval}`, screenCenter.x + radiusPx + 4, screenCenter.y);
    }

    // Reset shadow
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  private drawCompassRose(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    maxRadius: number,
  ): void {
    // Enable subtle phosphor glow for compass ticks
    ctx.shadowBlur = STARSGlow.rings;
    ctx.shadowColor = STARSColors.glow;
    ctx.strokeStyle = STARSColors.compass;
    ctx.fillStyle = STARSColors.compass;
    ctx.lineWidth = 0.5;

    for (let deg = 0; deg < 360; deg += 10) {
      // Convert heading to canvas angle: 0 heading = north = up on screen
      // Canvas 0 rad points right, so subtract 90 to rotate north up
      const rad = ((deg - 90) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      const isMajor = deg % 30 === 0;
      const tickLength = isMajor ? 12 : 6;
      const outerRadius = maxRadius;
      const innerRadius = maxRadius - tickLength;

      // Draw tick mark pointing inward from the ring edge
      ctx.beginPath();
      ctx.moveTo(cx + cos * innerRadius, cy + sin * innerRadius);
      ctx.lineTo(cx + cos * outerRadius, cy + sin * outerRadius);
      ctx.stroke();

      // Label major ticks with two-digit heading (00, 03, 06, 09, ...)
      if (isMajor) {
        const labelRadius = maxRadius + 14;
        const label = String(deg / 10).padStart(2, '0');
        ctx.font = `${STARSFonts.mapLabel}px ${STARSFonts.family}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx + cos * labelRadius, cy + sin * labelRadius);
      }
    }

    // Reset shadow
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  private drawNorthIndicator(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    maxRadius: number,
  ): void {
    // Small "N" above the compass rose at the top (north)
    ctx.shadowBlur = STARSGlow.rings;
    ctx.shadowColor = STARSColors.glow;
    ctx.fillStyle = STARSColors.compass;
    ctx.font = `bold ${STARSFonts.mapLabel + 2}px ${STARSFonts.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - maxRadius - 26);

    // Reset shadow
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }
}
