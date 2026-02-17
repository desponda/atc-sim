import type { Position } from '@atc-sim/shared';
import { stereographicProject, stereographicUnproject } from '@atc-sim/shared';

/**
 * Wraps stereographic projection with pan/zoom/scale state.
 * Converts lat/lon positions to screen pixel coordinates and back.
 */
export class Projection {
  /** Center of the projection (airport reference point) */
  private center: Position;
  /** Pan offset in nautical miles */
  private panOffsetNm = { x: 0, y: 0 };
  /** Range in nautical miles (radius of visible area) */
  private rangeNm = 40;
  /** Canvas width/height in pixels */
  private canvasWidth = 0;
  private canvasHeight = 0;

  constructor(center: Position) {
    this.center = center;
  }

  /** Update canvas dimensions */
  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  /** Set range in nautical miles */
  setRange(rangeNm: number): void {
    this.rangeNm = Math.max(5, Math.min(120, rangeNm));
  }

  getRange(): number {
    return this.rangeNm;
  }

  getCenter(): Position {
    return this.center;
  }

  /** Pixels per nautical mile based on current range and canvas size */
  getScale(): number {
    const minDim = Math.min(this.canvasWidth, this.canvasHeight);
    return minDim / (2 * this.rangeNm);
  }

  /** Pan by a delta in pixels */
  pan(dxPx: number, dyPx: number): void {
    const scale = this.getScale();
    if (scale === 0) return;
    this.panOffsetNm.x -= dxPx / scale;
    this.panOffsetNm.y += dyPx / scale;
  }

  /** Zoom centered on a screen point */
  zoom(factor: number, screenX: number, screenY: number): void {
    // Get the world position under the cursor before zoom
    const worldBefore = this.screenToWorld(screenX, screenY);

    this.rangeNm = Math.max(5, Math.min(120, this.rangeNm / factor));

    // Get the world position under the cursor after zoom
    const worldAfter = this.screenToWorld(screenX, screenY);

    // Adjust pan so the point under cursor stays fixed
    const projBefore = stereographicProject(worldBefore, this.center);
    const projAfter = stereographicProject(worldAfter, this.center);
    this.panOffsetNm.x += projAfter.x - projBefore.x;
    this.panOffsetNm.y += projAfter.y - projBefore.y;
  }

  /** Reset pan to centered */
  resetPan(): void {
    this.panOffsetNm = { x: 0, y: 0 };
  }

  /** Convert lat/lon to screen pixel coordinates */
  project(pos: Position): { x: number; y: number } {
    const projected = stereographicProject(pos, this.center);
    const scale = this.getScale();
    const cx = this.canvasWidth / 2;
    const cy = this.canvasHeight / 2;

    return {
      x: cx + (projected.x - this.panOffsetNm.x) * scale,
      y: cy - (projected.y - this.panOffsetNm.y) * scale, // Y is inverted on screen
    };
  }

  /** Convert screen pixel coordinates to lat/lon */
  screenToWorld(screenX: number, screenY: number): Position {
    const scale = this.getScale();
    if (scale === 0) return this.center;

    const cx = this.canvasWidth / 2;
    const cy = this.canvasHeight / 2;

    const nmX = (screenX - cx) / scale + this.panOffsetNm.x;
    const nmY = -(screenY - cy) / scale + this.panOffsetNm.y;

    return stereographicUnproject({ x: nmX, y: nmY }, this.center);
  }
}
