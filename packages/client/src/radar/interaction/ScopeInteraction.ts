import type { AircraftState } from '@atc-sim/shared';
import { Projection } from '../rendering/Projection';
import { DataBlockManager } from './DataBlockManager';
import { STARSSizes } from '../rendering/STARSTheme';

export interface ScopeInteractionCallbacks {
  onSelectAircraft: (id: string | null) => void;
  onCycleLeader: (id: string) => void;
  onRedrawNeeded: () => void;
}

/**
 * Handles mouse/wheel interactions on the radar scope:
 * - Left click: select aircraft target or data block
 * - Scroll wheel: zoom in/out centered on cursor
 * - Middle click + drag: pan the scope
 */
export class ScopeInteraction {
  private projection: Projection;
  private dataBlockManager: DataBlockManager;
  private callbacks: ScopeInteractionCallbacks;

  private isPanning = false;
  private lastPanX = 0;
  private lastPanY = 0;

  /** Current mouse position for crosshair rendering */
  mouseX = -1;
  mouseY = -1;

  constructor(
    projection: Projection,
    dataBlockManager: DataBlockManager,
    callbacks: ScopeInteractionCallbacks
  ) {
    this.projection = projection;
    this.dataBlockManager = dataBlockManager;
    this.callbacks = callbacks;
  }

  /** Attach event listeners to the overlay canvas */
  attach(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('mousedown', this.handleMouseDown);
    canvas.addEventListener('mousemove', this.handleMouseMove);
    canvas.addEventListener('mouseup', this.handleMouseUp);
    canvas.addEventListener('mouseleave', this.handleMouseLeave);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Detach event listeners */
  detach(canvas: HTMLCanvasElement): void {
    canvas.removeEventListener('mousedown', this.handleMouseDown);
    canvas.removeEventListener('mousemove', this.handleMouseMove);
    canvas.removeEventListener('mouseup', this.handleMouseUp);
    canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    canvas.removeEventListener('wheel', this.handleWheel);
  }

  /** Find the aircraft whose target is closest to screen point, within selection radius */
  findNearestAircraft(
    screenX: number,
    screenY: number,
    aircraft: AircraftState[]
  ): string | null {
    let bestId: string | null = null;
    let bestDist: number = STARSSizes.selectionRadius;

    for (const ac of aircraft) {
      const pos = this.projection.project(ac.position);
      const dx = pos.x - screenX;
      const dy = pos.y - screenY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = ac.id;
      }
    }
    return bestId;
  }

  private handleMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) {
      // Middle click: start panning
      this.isPanning = true;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
      e.preventDefault();
    }
  };

  private handleMouseMove = (e: MouseEvent): void => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    this.mouseX = e.clientX - rect.left;
    this.mouseY = e.clientY - rect.top;

    if (this.isPanning) {
      const dx = e.clientX - this.lastPanX;
      const dy = e.clientY - this.lastPanY;
      this.projection.pan(dx, dy);
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
      this.callbacks.onRedrawNeeded();
    }
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 1) {
      this.isPanning = false;
    }
  };

  private handleMouseLeave = (): void => {
    this.isPanning = false;
    this.mouseX = -1;
    this.mouseY = -1;
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.projection.zoom(factor, x, y);
    this.callbacks.onRedrawNeeded();
  };

  /** Handle left click - called from React event to coordinate with aircraft state */
  handleClick(screenX: number, screenY: number, aircraft: AircraftState[]): void {
    // Check data block hit first
    const blockHit = this.dataBlockManager.hitTest(screenX, screenY);
    if (blockHit) {
      this.callbacks.onSelectAircraft(blockHit);
      return;
    }

    // Check target hit
    const targetHit = this.findNearestAircraft(screenX, screenY, aircraft);
    if (targetHit) {
      this.callbacks.onSelectAircraft(targetHit);
    } else {
      this.callbacks.onSelectAircraft(null);
    }
  }

  /** Handle right click on data block to cycle leader direction */
  handleRightClick(screenX: number, screenY: number): void {
    const blockHit = this.dataBlockManager.hitTest(screenX, screenY);
    if (blockHit) {
      this.callbacks.onCycleLeader(blockHit);
    }
  }
}
