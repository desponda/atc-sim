import type { AircraftState } from '@atc-sim/shared';
import { Projection } from '../rendering/Projection';
import { DataBlockManager } from './DataBlockManager';
import { STARSSizes } from '../rendering/STARSTheme';

import type { RBLPoint } from '../layers/OverlayLayer';
import type { OverlayLayer } from '../layers/OverlayLayer';

export interface ScopeInteractionCallbacks {
  onSelectAircraft: (id: string | null) => void;
  onCycleLeader: (id: string) => void;
  onRedrawNeeded: () => void;
  onRadarHandoff?: (id: string) => void;
  onAcceptHandoff?: (id: string) => void;
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
  private isLeftPanTracking = false;
  private leftPanStartX = 0;
  private leftPanStartY = 0;
  /** True if the most recent left-click turned into a drag pan (suppress click event) */
  didLeftPan = false;
  private lastPanX = 0;
  private lastPanY = 0;
  private overlayLayer: OverlayLayer | null = null;
  private selectedAircraftId: string | null = null;

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

  /** Set overlay layer for RBL tool */
  setOverlayLayer(layer: OverlayLayer): void {
    this.overlayLayer = layer;
  }

  /** Track currently selected aircraft so repeated clicks trigger radar handoff */
  setSelectedAircraftId(id: string | null): void {
    this.selectedAircraftId = id;
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
    } else if (e.button === 0) {
      // Left click: track for potential pan drag
      this.isLeftPanTracking = true;
      this.didLeftPan = false;
      this.leftPanStartX = e.clientX;
      this.leftPanStartY = e.clientY;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
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
    } else if (this.isLeftPanTracking) {
      if (!this.didLeftPan) {
        // Check if drag exceeds threshold (5px) to start panning
        const dx = e.clientX - this.leftPanStartX;
        const dy = e.clientY - this.leftPanStartY;
        if (Math.sqrt(dx * dx + dy * dy) > 5) {
          this.didLeftPan = true;
          this.lastPanX = e.clientX;
          this.lastPanY = e.clientY;
        }
      }
      if (this.didLeftPan) {
        const dx = e.clientX - this.lastPanX;
        const dy = e.clientY - this.lastPanY;
        this.projection.pan(dx, dy);
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        this.callbacks.onRedrawNeeded();
      }
    }
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 1) {
      this.isPanning = false;
    } else if (e.button === 0) {
      this.isLeftPanTracking = false;
    }
  };

  private handleMouseLeave = (): void => {
    this.isPanning = false;
    this.isLeftPanTracking = false;
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

  /**
   * Handle double-click: start/reset the RBL tool by anchoring point 1.
   * Called from React before the RBL rubber-bands to the cursor.
   */
  handleDoubleClick(screenX: number, screenY: number): void {
    if (!this.overlayLayer) return;
    const pos = this.projection.screenToWorld(screenX, screenY);
    // Always restart: set exactly 1 anchor point
    this.overlayLayer.rblPoints = [{ screenX, screenY, lat: pos.lat, lon: pos.lon }];
  }

  /** Handle left click - called from React event to coordinate with aircraft state */
  handleClick(screenX: number, screenY: number, aircraft: AircraftState[], shiftKey?: boolean, ctrlKey?: boolean): void {
    // Ctrl+click: offer departure radar handoff to center
    if (ctrlKey) {
      const blockHit = this.dataBlockManager.hitTest(screenX, screenY);
      if (blockHit && this.callbacks.onRadarHandoff) {
        this.callbacks.onRadarHandoff(blockHit);
      }
      return;
    }

    // Shift+click: RBL point placement (legacy shortcut)
    if (shiftKey && this.overlayLayer) {
      const pos = this.projection.screenToWorld(screenX, screenY);
      if (this.overlayLayer.rblPoints.length >= 2) {
        this.overlayLayer.rblPoints = [];
      }
      this.overlayLayer.rblPoints.push({
        screenX, screenY,
        lat: pos.lat, lon: pos.lon,
      });
      return;
    }

    // Check hits first — aircraft/block selection always takes priority
    const blockHit = this.dataBlockManager.hitTest(screenX, screenY);
    const targetHit = this.findNearestAircraft(screenX, screenY, aircraft);

    if (this.overlayLayer) {
      const pts = this.overlayLayer.rblPoints.length;
      if (pts === 1 && !blockHit && !targetHit) {
        // Anchor point 2 — freeze the RBL
        const pos = this.projection.screenToWorld(screenX, screenY);
        this.overlayLayer.rblPoints.push({ screenX, screenY, lat: pos.lat, lon: pos.lon });
        return;
      } else if (pts === 2 && !blockHit && !targetHit) {
        // Second click in empty space clears
        this.overlayLayer.rblPoints = [];
        return;
      }
    }

    if (blockHit) {
      const ac = aircraft.find((a) => a.id === blockHit);
      if (ac && (ac as any).inboundHandoff === 'offered') {
        // Plain click on an offered inbound handoff accepts it
        if (this.callbacks.onAcceptHandoff) this.callbacks.onAcceptHandoff(blockHit);
      }
      this.callbacks.onSelectAircraft(blockHit);
      return;
    }
    if (targetHit) {
      this.callbacks.onSelectAircraft(targetHit);
    } else {
      this.callbacks.onSelectAircraft(null);
    }
  }

  /** Clear the RBL measurement (e.g. on Escape) */
  clearRBL(): void {
    if (this.overlayLayer) this.overlayLayer.rblPoints = [];
  }

  /** Handle right click on data block to cycle leader direction */
  handleRightClick(screenX: number, screenY: number): void {
    const blockHit = this.dataBlockManager.hitTest(screenX, screenY);
    if (blockHit) {
      this.callbacks.onCycleLeader(blockHit);
    }
  }
}
