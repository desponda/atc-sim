import { STARSColors, STARSFonts, STARSGlow } from './STARSTheme';

/**
 * Utility for rendering STARS-style monospace text on canvas.
 * Supports CRT phosphor glow effects for authentic STARS display appearance.
 */
export class TextRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  /** Set the context (e.g., after canvas resize) */
  setContext(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
  }

  /** Measure text width at given font size */
  measureWidth(text: string, fontSize: number): number {
    this.ctx.font = `${fontSize}px ${STARSFonts.family}`;
    return this.ctx.measureText(text).width;
  }

  /** Draw text at position with optional phosphor glow */
  drawText(
    text: string,
    x: number,
    y: number,
    options: {
      color?: string;
      fontSize?: number;
      align?: CanvasTextAlign;
      baseline?: CanvasTextBaseline;
      glow?: boolean;
    } = {}
  ): void {
    const {
      color = STARSColors.normal,
      fontSize = STARSFonts.dataBlock,
      align = 'left',
      baseline = 'top',
      glow = false,
    } = options;

    const ctx = this.ctx;
    ctx.font = `${fontSize}px ${STARSFonts.family}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;

    if (glow) {
      ctx.shadowBlur = STARSGlow.dataBlock;
      ctx.shadowColor = color;
    }

    ctx.fillText(text, x, y);

    if (glow) {
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  }

  /** Draw a multi-line data block with optional phosphor glow, returns total height */
  drawDataBlock(
    lines: string[],
    x: number,
    y: number,
    color: string = STARSColors.normal,
    fontSize: number = STARSFonts.dataBlock,
    lineHeight: number = 14,
    glow: boolean = false
  ): number {
    const ctx = this.ctx;
    ctx.font = `${fontSize}px ${STARSFonts.family}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    if (glow) {
      ctx.shadowBlur = STARSGlow.dataBlock;
      ctx.shadowColor = color;
    }

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, y + i * lineHeight);
    }

    if (glow) {
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }

    return lines.length * lineHeight;
  }
}
