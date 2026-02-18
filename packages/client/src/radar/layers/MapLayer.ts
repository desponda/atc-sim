import type { AirportData, Fix, Runway, SID, STAR, AirspaceBoundary, ProcedureLeg, VideoMap, VideoMapFeature, Approach, AltitudeConstraint } from '@atc-sim/shared';
import { STARSColors, STARSFonts, STARSSizes, STARSGlow } from '../rendering/STARSTheme';
import { Projection } from '../rendering/Projection';

export interface MapLayerOptions {
  showFixes: boolean;
  showSIDs: boolean;
  showSTARs: boolean;
  showAirspace: boolean;
  showRunways: boolean;
  enabledVideoMaps: Record<string, boolean>;
}

/**
 * Layer 1: Fixes, runways, SID/STAR routes, airspace boundaries.
 * Redraws on pan/zoom or toggle changes.
 */
export class MapLayer {
  private ctx: CanvasRenderingContext2D;
  private projection: Projection;
  private airportData: AirportData | null = null;
  private options: MapLayerOptions = {
    showFixes: true,
    showSIDs: true,
    showSTARs: true,
    showAirspace: true,
    showRunways: true,
    enabledVideoMaps: {},
  };

  constructor(ctx: CanvasRenderingContext2D, projection: Projection) {
    this.ctx = ctx;
    this.projection = projection;
  }

  setContext(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
  }

  setAirportData(data: AirportData): void {
    this.airportData = data;
  }

  setOptions(options: Partial<MapLayerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  getOptions(): MapLayerOptions {
    return { ...this.options };
  }

  draw(width: number, height: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    if (!this.airportData) return;

    if (this.options.showAirspace) {
      this.drawAirspace(this.airportData.airspace);
    }
    if (this.options.showRunways) {
      this.drawRunways(this.airportData.runways);
    }
    if (this.options.showSIDs) {
      this.drawProcedures(this.airportData.sids, 'SID');
    }
    if (this.options.showSTARs) {
      this.drawProcedures(this.airportData.stars, 'STAR');
    }
    // Approach fixes (IAF/FAF) are always drawn for controller reference.
    // Collect rendered fix IDs so drawFixes() skips duplicates.
    const approachFixIds = this.airportData.approaches?.length
      ? this.drawApproachFixes(this.airportData.approaches)
      : new Set<string>();

    if (this.options.showFixes) {
      this.drawFixes(this.airportData.fixes.filter(f => !approachFixIds.has(f.id)));
      this.drawFixes(
        this.airportData.navaids.map((n) => ({ ...n, type: 'navaid' as const }))
      );
    }

    if (this.airportData?.videoMaps) {
      this.drawVideoMaps(this.airportData.videoMaps);
    }
  }

  private getVideoMapDefaultColor(map: VideoMap): string {
    const name = map.name.toUpperCase();
    // Coastlines, rivers, geographic features
    if (name.includes('COAST') || name.includes('GEO')) return STARSColors.videoMapGeo;
    // MVA - Minimum Vectoring Altitudes
    if (name.includes('MVA')) return STARSColors.videoMapMVA;
    // Airports, tower cab views
    if (name.includes('AIRPORT') || name.includes('TOWER') || name.includes('APTS')) return STARSColors.videoMapAirport;
    // Restricted areas, SUAs, SFRA
    if (name.includes('RAREA') || name.includes('SUA') || name.includes('SFRA') || name.includes('RESTRICT')) return STARSColors.videoMapSUA;
    // Roads, highways
    if (name.includes('ROAD')) return STARSColors.videoMapRoad;
    // Airspace classes (B, D), zones
    if (name.includes('CLASS') || name.includes('ZONE')) return STARSColors.airspace;
    // Airways (J, Q, T, V)
    if (name.includes('AIRWAY') || name.includes('JAIRWAY') || name.includes('QAIRWAY') ||
        name.includes('TAIRWAY') || name.includes('VAIRWAY')) return STARSColors.map;
    // Approach/departure procedures, fixes, STARs
    if (name.includes('STAR') || name.includes('IAP') || name.includes('SID') ||
        name.includes('FIX') || name.includes('APPROACH')) return STARSColors.map;
    // MEGA combined, helo routes
    if (name.includes('MEGA')) return STARSColors.videoMapGeo;
    if (name.includes('HELO')) return STARSColors.videoMapSUA;
    // Default: standard map color
    return STARSColors.map;
  }

  private drawVideoMaps(maps: VideoMap[]): void {
    const ctx = this.ctx;

    for (const map of maps) {
      if (!this.options.enabledVideoMaps[map.id]) continue;

      const defaultColor = this.getVideoMapDefaultColor(map);

      ctx.shadowBlur = STARSGlow.map;
      ctx.shadowColor = STARSColors.glow;

      for (const feature of map.features) {
        this.drawVideoMapFeature(feature, defaultColor);
      }

      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  }

  private drawVideoMapFeature(feature: VideoMapFeature, defaultColor: string): void {
    const ctx = this.ctx;
    const color = feature.color ?? defaultColor;

    switch (feature.type) {
      case 'line': {
        if (!feature.points || feature.points.length < 2) break;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        if (feature.lineDash) {
          ctx.setLineDash(feature.lineDash);
        }
        ctx.beginPath();
        const first = this.projection.project(feature.points[0]);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < feature.points.length; i++) {
          const pt = this.projection.project(feature.points[i]);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
        if (feature.lineDash) {
          ctx.setLineDash([]);
        }
        break;
      }
      case 'polygon': {
        if (!feature.points || feature.points.length < 3) break;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        if (feature.lineDash) {
          ctx.setLineDash(feature.lineDash);
        }
        ctx.beginPath();
        const first = this.projection.project(feature.points[0]);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < feature.points.length; i++) {
          const pt = this.projection.project(feature.points[i]);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.closePath();
        ctx.stroke();
        if (feature.lineDash) {
          ctx.setLineDash([]);
        }
        break;
      }
      case 'label': {
        if (!feature.position || !feature.text) break;
        const pos = this.projection.project(feature.position);
        ctx.fillStyle = color;
        ctx.font = `8px ${STARSFonts.family}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(feature.text, pos.x, pos.y);
        break;
      }
      case 'symbol': {
        if (!feature.position) break;
        const pos = this.projection.project(feature.position);
        const arm = 4;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        // Draw "+" crosshair
        ctx.beginPath();
        ctx.moveTo(pos.x - arm, pos.y);
        ctx.lineTo(pos.x + arm, pos.y);
        ctx.moveTo(pos.x, pos.y - arm);
        ctx.lineTo(pos.x, pos.y + arm);
        ctx.stroke();
        // Draw text label offset to the right
        if (feature.text) {
          ctx.fillStyle = color;
          ctx.font = `8px ${STARSFonts.family}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(feature.text, pos.x + arm + 2, pos.y);
        }
        break;
      }
    }
  }

  private drawFixes(fixes: Fix[]): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    ctx.font = `${STARSFonts.mapLabel}px ${STARSFonts.family}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (const fix of fixes) {
      const pos = this.projection.project(fix.position);
      const s = 4; // Symbol half-size

      // Enable phosphor glow for fix symbols
      ctx.shadowBlur = STARSGlow.map;
      ctx.shadowColor = STARSColors.glow;

      if (fix.type === 'navaid') {
        // Draw hexagon for navaids (VOR) - slightly brighter
        ctx.strokeStyle = STARSColors.mapLabel;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle = (i * 60 - 30) * (Math.PI / 180);
          const x = pos.x + Math.cos(angle) * s;
          const y = pos.y + Math.sin(angle) * s;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      } else {
        // Draw small triangle for waypoints - very dim green
        ctx.strokeStyle = STARSColors.map;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - s);
        ctx.lineTo(pos.x + s, pos.y + s);
        ctx.lineTo(pos.x - s, pos.y + s);
        ctx.closePath();
        ctx.stroke();
      }

      // Label with 2px offset, 9px font
      ctx.fillStyle = STARSColors.mapLabel;
      ctx.fillText(fix.id, pos.x + s + 2, pos.y - s);

      // Reset glow
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  }

  private drawRunways(runways: Runway[]): void {
    const ctx = this.ctx;
    const scale = this.projection.getScale(); // pixels per nautical mile

    for (const rwy of runways) {
      const threshold = this.projection.project(rwy.threshold);
      const end = this.projection.project(rwy.end);

      // Runway direction vector
      const dx = end.x - threshold.x;
      const dy = end.y - threshold.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;
      const ux = dx / len;
      const uy = dy / len;
      // Perpendicular vector (for tick marks and threshold markers)
      const px = -uy;
      const py = ux;

      // --- Runway outline with glow ---
      ctx.shadowBlur = STARSGlow.map;
      ctx.shadowColor = STARSColors.glow;
      ctx.strokeStyle = STARSColors.runway;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(threshold.x, threshold.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();

      // --- Runway threshold markers (perpendicular marks at each end) ---
      ctx.lineWidth = 2;
      const threshLen = 8; // half-length of threshold marker in pixels
      // Threshold end
      ctx.beginPath();
      ctx.moveTo(threshold.x + px * threshLen, threshold.y + py * threshLen);
      ctx.lineTo(threshold.x - px * threshLen, threshold.y - py * threshLen);
      ctx.stroke();
      // Far end
      ctx.beginPath();
      ctx.moveTo(end.x + px * threshLen, end.y + py * threshLen);
      ctx.lineTo(end.x - px * threshLen, end.y - py * threshLen);
      ctx.stroke();

      // Reset glow for centerline (dimmer features)
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';

      // --- Extended centerline with mile tick marks ---
      // Solid dim line extending from threshold on the approach side
      const extNm = STARSSizes.centerlineExtension; // 15nm
      const extLenPx = extNm * scale;

      ctx.strokeStyle = STARSColors.centerline;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(threshold.x, threshold.y);
      ctx.lineTo(threshold.x - ux * extLenPx, threshold.y - uy * extLenPx);
      ctx.stroke();

      // Tick marks every 1nm, longer every 5nm
      const tickSpacingNm = STARSSizes.centerlineTickSpacing; // 1nm
      const tickSpacingPx = tickSpacingNm * scale;
      const numTicks = Math.floor(extNm / tickSpacingNm);

      for (let i = 1; i <= numTicks; i++) {
        const distPx = i * tickSpacingPx;
        const cx = threshold.x - ux * distPx;
        const cy = threshold.y - uy * distPx;

        // 5nm marks are twice as long (8px half-length), 1nm marks are 4px
        const tickHalf = (i % 5 === 0) ? 8 : 4;

        ctx.beginPath();
        ctx.moveTo(cx + px * tickHalf, cy + py * tickHalf);
        ctx.lineTo(cx - px * tickHalf, cy - py * tickHalf);
        ctx.stroke();
      }

      // --- Runway label at midpoint, offset to the side ---
      ctx.shadowBlur = STARSGlow.map;
      ctx.shadowColor = STARSColors.glow;
      ctx.font = `${STARSFonts.mapLabel}px ${STARSFonts.family}`;
      ctx.fillStyle = STARSColors.mapLabel;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const midX = (threshold.x + end.x) / 2;
      const midY = (threshold.y + end.y) / 2;
      ctx.fillText(rwy.id, midX + px * 12, midY + py * 12);

      // Reset glow
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  }

  private drawProcedures(procedures: (SID | STAR)[], type: 'SID' | 'STAR'): void {
    const ctx = this.ctx;
    // SIDs: blue-tinted dim, STARs: green-tinted dim
    ctx.strokeStyle = type === 'SID' ? '#001a33' : '#002a1a';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 4]);

    // Subtle glow on procedure routes
    ctx.shadowBlur = STARSGlow.map;
    ctx.shadowColor = STARSColors.glow;

    for (const proc of procedures) {
      this.drawProcedureLegs(proc.commonLegs);
      for (const trans of proc.enrouteTransitions) {
        this.drawProcedureLegs(trans.legs);
      }
      for (const trans of proc.runwayTransitions) {
        this.drawProcedureLegs(trans.legs);
      }
    }

    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  private drawProcedureLegs(legs: ProcedureLeg[]): void {
    const ctx = this.ctx;
    let lastPos: { x: number; y: number } | null = null;

    for (const leg of legs) {
      if (leg.fix) {
        const pos = this.projection.project(leg.fix.position);
        if (lastPos && (leg.legType === 'TF' || leg.legType === 'DF' || leg.legType === 'CF')) {
          ctx.beginPath();
          ctx.moveTo(lastPos.x, lastPos.y);
          ctx.lineTo(pos.x, pos.y);
          ctx.stroke();
        }
        lastPos = pos;
      }
    }
  }

  /**
   * Extracts the altitude value from an altitude constraint (always returns the
   * "at or above" / "at" baseline altitude, or the min of a between constraint).
   */
  private constraintAlt(c: AltitudeConstraint): number {
    if (c.type === 'between') return c.min;
    return c.altitude;
  }

  /**
   * Always-visible approach fix overlay: marks IAF and FAF for each approach
   * procedure so controllers can easily reference them when issuing clearances.
   *
   * Symbols:
   *   IAF – open circle (where radar vectors may begin)
   *   FAF – open diamond (the crossing fix for approach clearances)
   *   INT – small "×" cross (intermediate fixes)
   *
   * Each fix is labelled with its identifier and altitude constraint.
   */
  private drawApproachFixes(approaches: Approach[]): Set<string> {
    const ctx = this.ctx;

    // Approach-fix colour: dim cyan-blue, distinct from normal waypoints
    const COLOR = '#007799';

    // Role priority: FAF > IAF > INT (for de-duplication)
    const ROLE_PRIORITY: Record<string, number> = { FAF: 3, IAF: 2, INT: 1 };

    interface ApproachFix {
      fix: Fix;
      role: 'IAF' | 'FAF' | 'INT';
      altitude?: number;
      altSuffix: string; // '+', '-', or ''
    }

    const fixMap = new Map<string, ApproachFix>();

    const upsert = (
      fix: Fix,
      role: 'IAF' | 'FAF' | 'INT',
      constraint?: AltitudeConstraint
    ) => {
      const existing = fixMap.get(fix.id);
      if (existing && ROLE_PRIORITY[existing.role] >= ROLE_PRIORITY[role]) return;
      let altitude: number | undefined;
      let altSuffix = '';
      if (constraint) {
        altitude = this.constraintAlt(constraint);
        altSuffix = constraint.type === 'atOrAbove' ? '+' : constraint.type === 'atOrBelow' ? '-' : '';
      }
      fixMap.set(fix.id, { fix, role, altitude, altSuffix });
    };

    for (const approach of approaches) {
      // Main approach legs (skip runway endpoint fixes)
      const legs = approach.legs.filter(l => l.fix && l.fix.type !== 'runway');
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (!leg.fix) continue;
        const role: 'IAF' | 'FAF' | 'INT' =
          i === 0 ? 'IAF' : i === legs.length - 1 ? 'FAF' : 'INT';
        upsert(leg.fix, role, leg.altitudeConstraint);
      }

      // Approach transitions (IAFs accessed via a feeder route)
      for (const trans of approach.transitions) {
        const tLegs = trans.legs.filter(l => l.fix && l.fix.type !== 'runway');
        if (tLegs.length === 0) continue;
        // First leg of a transition is an IAF
        const tIAF = tLegs[0];
        if (tIAF.fix) upsert(tIAF.fix, 'IAF', tIAF.altitudeConstraint);
      }
    }

    ctx.lineWidth = 1;
    ctx.font = `9px ${STARSFonts.family}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowBlur = STARSGlow.map;
    ctx.shadowColor = STARSColors.glow;
    ctx.strokeStyle = COLOR;
    ctx.fillStyle = COLOR;

    for (const { fix, role, altitude, altSuffix } of fixMap.values()) {
      const pos = this.projection.project(fix.position);
      const s = 5; // half-size of marker

      ctx.strokeStyle = COLOR;
      ctx.fillStyle = COLOR;
      ctx.beginPath();

      if (role === 'IAF') {
        // Open circle
        ctx.arc(pos.x, pos.y, s, 0, Math.PI * 2);
        ctx.stroke();
      } else if (role === 'FAF') {
        // Open diamond (rotated square)
        ctx.moveTo(pos.x,     pos.y - s);
        ctx.lineTo(pos.x + s, pos.y);
        ctx.lineTo(pos.x,     pos.y + s);
        ctx.lineTo(pos.x - s, pos.y);
        ctx.closePath();
        ctx.stroke();
      } else {
        // INT: small × cross
        const arm = 3;
        ctx.moveTo(pos.x - arm, pos.y - arm);
        ctx.lineTo(pos.x + arm, pos.y + arm);
        ctx.moveTo(pos.x + arm, pos.y - arm);
        ctx.lineTo(pos.x - arm, pos.y + arm);
        ctx.stroke();
      }

      // Fix label (upper-right of marker)
      ctx.fillStyle = COLOR;
      const labelX = pos.x + s + 2;
      const labelY = pos.y - s;
      ctx.fillText(fix.id, labelX, labelY);

      // Altitude label (one line below fix id, slightly dimmer)
      if (altitude !== undefined) {
        ctx.globalAlpha = 0.75;
        ctx.fillText(`${altitude}${altSuffix}`, labelX, labelY + 9);
        ctx.globalAlpha = 1;
      }
    }

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    return new Set(fixMap.keys());
  }

  private drawAirspace(boundaries: AirspaceBoundary[]): void {
    const ctx = this.ctx;

    for (const boundary of boundaries) {
      if (boundary.boundary.length < 3) continue;

      // Subtle phosphor glow on airspace boundaries
      ctx.shadowBlur = STARSGlow.map;
      ctx.shadowColor = STARSColors.glow;

      ctx.strokeStyle = STARSColors.airspace;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);

      ctx.beginPath();
      const first = this.projection.project(boundary.boundary[0]);
      ctx.moveTo(first.x, first.y);

      for (let i = 1; i < boundary.boundary.length; i++) {
        const pt = this.projection.project(boundary.boundary[i]);
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Label at centroid
      let cx = 0, cy = 0;
      for (const pt of boundary.boundary) {
        const s = this.projection.project(pt);
        cx += s.x;
        cy += s.y;
      }
      cx /= boundary.boundary.length;
      cy /= boundary.boundary.length;

      ctx.font = `${STARSFonts.mapLabel}px ${STARSFonts.family}`;
      ctx.fillStyle = STARSColors.airspace;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(boundary.name, cx, cy);

      // Reset glow
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  }
}
