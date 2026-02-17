import type { AircraftState, AirportData, Alert } from '@atc-sim/shared';
import { Projection } from './rendering/Projection';
import { BackgroundLayer } from './layers/BackgroundLayer';
import { MapLayer, type MapLayerOptions } from './layers/MapLayer';
import { TargetLayer } from './layers/TargetLayer';
import { OverlayLayer } from './layers/OverlayLayer';
import { DataBlockManager } from './interaction/DataBlockManager';
import { ScopeInteraction, type ScopeInteractionCallbacks } from './interaction/ScopeInteraction';
import type { Position } from '@atc-sim/shared';

/**
 * Orchestrates all 4 canvas layers, handles resize, and manages the render loop.
 */
export class CanvasManager {
  private container: HTMLElement;
  private canvases: HTMLCanvasElement[] = [];
  private contexts: CanvasRenderingContext2D[] = [];

  readonly projection: Projection;
  private backgroundLayer!: BackgroundLayer;
  private mapLayer!: MapLayer;
  private targetLayer!: TargetLayer;
  private overlayLayer!: OverlayLayer;

  readonly dataBlockManager: DataBlockManager;
  readonly scopeInteraction: ScopeInteraction;

  private animationFrameId: number | null = null;
  private needsStaticRedraw = true;
  private needsMapRedraw = true;

  private aircraft: AircraftState[] = [];
  private width = 0;
  private height = 0;

  constructor(container: HTMLElement, center: Position, callbacks: ScopeInteractionCallbacks) {
    this.container = container;
    this.projection = new Projection(center);
    this.dataBlockManager = new DataBlockManager();
    this.scopeInteraction = new ScopeInteraction(
      this.projection,
      this.dataBlockManager,
      {
        ...callbacks,
        onRedrawNeeded: () => {
          this.needsStaticRedraw = true;
          this.needsMapRedraw = true;
          callbacks.onRedrawNeeded();
        },
      }
    );

    this.createCanvases();
    this.resize();
    this.startRenderLoop();
  }

  private createCanvases(): void {
    for (let i = 0; i < 4; i++) {
      const canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = i === 3 ? 'auto' : 'none';
      if (i === 3) {
        canvas.style.cursor = 'none';
      }
      this.container.appendChild(canvas);
      this.canvases.push(canvas);

      const ctx = canvas.getContext('2d', { alpha: i > 0 })!;
      this.contexts.push(ctx);
    }

    this.backgroundLayer = new BackgroundLayer(this.contexts[0], this.projection);
    this.mapLayer = new MapLayer(this.contexts[1], this.projection);
    this.targetLayer = new TargetLayer(this.contexts[2], this.projection, this.dataBlockManager);
    this.overlayLayer = new OverlayLayer(this.contexts[3]);

    // Attach interaction to overlay canvas
    this.scopeInteraction.attach(this.canvases[3]);
  }

  /** Handle container resize */
  resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    const dpr = window.devicePixelRatio || 1;

    for (let i = 0; i < 4; i++) {
      const canvas = this.canvases[i];
      canvas.width = this.width * dpr;
      canvas.height = this.height * dpr;
      this.contexts[i].setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    this.projection.setCanvasSize(this.width, this.height);

    // Update layer contexts in case they were recreated
    this.backgroundLayer.setContext(this.contexts[0]);
    this.mapLayer.setContext(this.contexts[1]);
    this.targetLayer.setContext(this.contexts[2]);
    this.overlayLayer.setContext(this.contexts[3]);

    this.needsStaticRedraw = true;
    this.needsMapRedraw = true;
  }

  /** Set airport data for map layer */
  setAirportData(data: AirportData): void {
    this.mapLayer.setAirportData(data);
    this.needsMapRedraw = true;
  }

  /** Update aircraft for target layer */
  setAircraft(aircraft: AircraftState[]): void {
    this.aircraft = aircraft;
  }

  /** Set selected aircraft */
  setSelectedAircraft(id: string | null): void {
    this.targetLayer.setSelectedAircraft(id);
  }

  /** Set alerts */
  setAlerts(alerts: Alert[]): void {
    this.targetLayer.updateAlerts(alerts);
  }

  /** Set range */
  setRange(rangeNm: number): void {
    this.projection.setRange(rangeNm);
    this.needsStaticRedraw = true;
    this.needsMapRedraw = true;
  }

  /** Set map options */
  setMapOptions(options: Partial<MapLayerOptions>): void {
    this.mapLayer.setOptions(options);
    this.needsMapRedraw = true;
  }

  getMapOptions(): MapLayerOptions {
    return this.mapLayer.getOptions();
  }

  /** Set history trail length */
  setHistoryTrailLength(length: number): void {
    this.targetLayer.setHistoryTrailLength(length);
  }

  /** Mark static layers dirty */
  invalidateStatic(): void {
    this.needsStaticRedraw = true;
    this.needsMapRedraw = true;
  }

  private startRenderLoop(): void {
    const render = () => {
      this.animationFrameId = requestAnimationFrame(render);

      if (this.needsStaticRedraw) {
        this.backgroundLayer.draw(this.width, this.height);
        this.needsStaticRedraw = false;
      }

      if (this.needsMapRedraw) {
        this.mapLayer.draw(this.width, this.height);
        this.needsMapRedraw = false;
      }

      // Target and overlay layers always redraw
      this.targetLayer.draw(this.width, this.height, this.aircraft);
      this.overlayLayer.draw(
        this.width,
        this.height,
        this.scopeInteraction.mouseX,
        this.scopeInteraction.mouseY
      );
    };

    this.animationFrameId = requestAnimationFrame(render);
  }

  /** Clean up */
  destroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.scopeInteraction.detach(this.canvases[3]);
    for (const canvas of this.canvases) {
      canvas.remove();
    }
    this.canvases = [];
    this.contexts = [];
  }
}
