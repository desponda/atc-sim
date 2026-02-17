import { STARSColors, STARSSizes, STARSGlow } from '../rendering/STARSTheme';

/**
 * Layer 3: Mouse cursor crosshairs, CRT scanline overlay, and vignette effect.
 * Simulates authentic STARS CRT display characteristics including:
 * - Phosphor-glow crosshair cursor with center gap
 * - Horizontal scanline overlay (every 2px)
 * - Radial vignette for CRT brightness falloff
 * Redraws every frame (lightweight).
 */
export class OverlayLayer {
  private ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  setContext(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
  }

  draw(width: number, height: number, mouseX: number, mouseY: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    // Draw crosshair cursor at mouse position with phosphor glow
    if (mouseX >= 0 && mouseY >= 0) {
      this.drawCrosshair(ctx, mouseX, mouseY);
    }

    // CRT scanline overlay across the entire canvas
    this.drawScanlines(ctx, width, height);

    // Subtle vignette to simulate CRT brightness falloff
    this.drawVignette(ctx, width, height);
  }

  private drawCrosshair(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
  ): void {
    const s = STARSSizes.crosshairSize;
    const gap = 4; // Gap radius around center point so exact center is visible

    // Enable CRT phosphor glow - bright bloom around the crosshair lines
    ctx.shadowBlur = STARSGlow.crosshair;
    ctx.shadowColor = STARSColors.glow;
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 1;

    // Horizontal line - left segment
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.lineTo(x - gap, y);
    ctx.stroke();

    // Horizontal line - right segment
    ctx.beginPath();
    ctx.moveTo(x + gap, y);
    ctx.lineTo(x + s, y);
    ctx.stroke();

    // Vertical line - top segment
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x, y - gap);
    ctx.stroke();

    // Vertical line - bottom segment
    ctx.beginPath();
    ctx.moveTo(x, y + gap);
    ctx.lineTo(x, y + s);
    ctx.stroke();

    // Reset shadow
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  private drawScanlines(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    // Draw subtle horizontal scanlines across the entire canvas
    // to simulate the horizontal scan pattern of a real CRT monitor.
    // Black lines at very low alpha create the characteristic banding.
    ctx.globalAlpha = STARSGlow.scanlineAlpha;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let y = 0; y < height; y += STARSGlow.scanlineSpacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    // Reset alpha
    ctx.globalAlpha = 1;
  }

  private drawVignette(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    const cx = width / 2;
    const cy = height / 2;
    // Radius from center to the farthest corner
    const cornerRadius = Math.sqrt(cx * cx + cy * cy);

    // Radial gradient: transparent at center, darkening toward edges
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, cornerRadius);
    // Center is fully transparent - no brightness reduction
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    // Stay transparent through most of the display area
    gradient.addColorStop(0.6, 'rgba(0, 0, 0, 0)');
    // Begin subtle darkening toward the edges
    gradient.addColorStop(0.85, 'rgba(0, 0, 0, 0.08)');
    // Corners darken to simulate natural CRT brightness falloff
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.18)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
}
