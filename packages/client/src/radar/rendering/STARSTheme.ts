/**
 * Authentic STARS (Standard Terminal Automation Replacement System) radar scope
 * color palette, fonts, sizing, and CRT display settings.
 *
 * Color values sourced from Vice (github.com/mmp/vice), the most accurate
 * open-source STARS implementation, cross-referenced with real STARS documentation.
 *
 * Key insight: Real STARS is NOT green-on-black (that's ARTS-III). Modern STARS uses:
 * - White for tracked/owned aircraft
 * - Green for untracked aircraft
 * - Blue for primary radar returns and history trails
 * - Cyan for selected targets
 * - Gray for range rings and compass
 */

/** Convert 0-1 RGB to hex string */
function rgbHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * STARS Brightness levels (0-100 scale, from Vice's default preferences).
 * Each element type has an independent brightness that scales its base color.
 */
export const STARSBrightness = {
  dcb: 60,
  backgroundContrast: 0,
  fullDatablocks: 80,
  lists: 80,
  positions: 80,
  limitedDatablocks: 80,
  otherTracks: 80,
  lines: 40,
  rangeRings: 20,
  compass: 40,
  beaconSymbols: 55,
  primarySymbols: 80,
  history: 60,
  weather: 30,
} as const;

/**
 * STARS History trail colors - 5 fading blue shades (from Vice stars.go).
 * Applied at STARSBrightness.history (60%) intensity.
 */
export const STARSHistoryColors = [
  rgbHex(0.12, 0.31, 0.78),   // #1f4fc7 (brightest)
  rgbHex(0.12, 0.25, 0.63),   // #1f40a1
  rgbHex(0.12, 0.2, 0.5),     // #1f3380
  rgbHex(0.12, 0.16, 0.42),   // #1f296b
  rgbHex(0.12, 0.12, 0.35),   // #1f1f59 (dimmest)
] as const;

export const STARSColors = {
  /** Background - black at default contrast */
  background: '#000000',

  // ─── Track/Aircraft Colors (from Vice stars.go) ───
  /** Tracked/owned aircraft - WHITE (authentic STARS, NOT green) */
  normal: '#ffffff',
  /** Selected aircraft - cyan */
  selected: '#00ffff',
  /** Caution/warning - yellow */
  caution: '#ffff00',
  /** Alert (imminent conflict) - red */
  alert: '#ff0000',
  /** Coasting/ghost target - yellow */
  coast: '#ffff00',
  /** Primary radar return (position symbol) - blue */
  primaryReturn: rgbHex(0.12, 0.48, 1),   // #1f7aff

  // ─── Map & Infrastructure ───
  /** Map features (fixes, routes) */
  map: '#003300',
  /** Map labels */
  mapLabel: '#005500',
  /** Range rings - gray at 20% brightness */
  rings: rgbHex(0.55 * 0.2, 0.55 * 0.2, 0.55 * 0.2),   // #1c1c1c
  /** Compass rose - gray at 40% brightness */
  compass: rgbHex(0.55 * 0.4, 0.55 * 0.4, 0.55 * 0.4),  // #383838
  /** History trail dots - brightest blue */
  historyTrail: rgbHex(0.12, 0.31, 0.78),                 // #1f4fc7
  /** Leader line - white (matches tracked aircraft) */
  leaderLine: '#cccccc',
  /** Runway outline */
  runway: '#008800',
  /** Extended centerline */
  centerline: '#004400',
  /** Airspace boundary - dim blue */
  airspace: '#002244',

  // ─── Text & UI ───
  /** Command input text - bright green (STARS keyboard area) */
  inputText: '#00ff00',
  /** Error text - red */
  errorText: '#ff4444',
  /** Dim text in panels */
  dimText: '#444444',
  /** Controller transmissions - green (STARS list color) */
  radioController: rgbHex(0.1, 0.9, 0.1),  // #1ae61a
  /** Pilot readbacks - dim white */
  radioPilot: '#aaaaaa',

  // ─── Panel UI ───
  /** Panel background - pure black */
  panelBg: '#000000',
  /** DCB button background */
  panelButton: '#0a0a0a',
  /** DCB button active */
  panelButtonActive: '#001a00',
  /** Panel border */
  panelBorder: '#222222',
  /** Panel button active border (brighter) */
  panelBorderActive: '#444444',

  // ─── Glow/Effect Colors ───
  /** Phosphor glow color (used for CSS/canvas shadow) */
  glow: '#88bbff',
  /** Bright target return */
  targetBright: '#ffffff',
  /** Velocity vector / predicted track */
  velocityVector: '#004400',

  // ─── Video Map Colors ───
  /** Geographic features (rivers, coastlines) */
  videoMapGeo: '#003344',
  /** MVA sector boundaries and labels */
  videoMapMVA: '#334400',
  /** Satellite airport symbols */
  videoMapAirport: '#444444',
  /** Restricted/prohibited area boundaries */
  videoMapSUA: '#442200',
  /** Highway/road reference lines */
  videoMapRoad: '#222222',
} as const;

export const STARSFonts = {
  /** Primary STARS display font - monospace */
  family: "'Share Tech Mono', 'Courier New', monospace",
  /** Data block text size */
  dataBlock: 11,
  /** Map label text size */
  mapLabel: 9,
  /** Status bar text size */
  statusBar: 12,
  /** Command input text size */
  commandInput: 13,
  /** Panel text size */
  panel: 10,
} as const;

/** Target rendering sizes in pixels */
export const STARSSizes = {
  /** Primary target square half-size */
  targetSize: 3,
  /** History trail dot radius */
  historyDotRadius: 2,
  /** Leader line default length in pixels */
  leaderLineLength: 32,
  /** Leader line lengths (STARS has 8 preset lengths) */
  leaderLineLengths: [0, 17, 32, 47, 62, 77, 114, 152] as readonly number[],
  /** Default leader line length index (2 = 32px) */
  leaderLineLengthDefault: 2,
  /** Data block line height */
  dataBlockLineHeight: 13,
  /** Cursor crosshair size */
  crosshairSize: 15,
  /** Minimum click distance to select target (px) */
  selectionRadius: 16,
  /** Extended centerline tick mark spacing (1nm marks) */
  centerlineTickSpacing: 1,
  /** Extended centerline length in nm */
  centerlineExtension: 15,
} as const;

/**
 * CRT display effect settings.
 * Subtle glow simulates phosphor bloom of CRT monitors used in real STARS.
 */
export const STARSGlow = {
  /** Shadow blur radius for primary targets */
  target: 6,
  /** Shadow blur for data block text */
  dataBlock: 3,
  /** Shadow blur for leader lines */
  leaderLine: 2,
  /** Shadow blur for map features */
  map: 1,
  /** Shadow blur for range rings */
  rings: 1,
  /** Shadow blur for the crosshair cursor */
  crosshair: 4,
  /** Scanline opacity (0 = off, higher = more visible) */
  scanlineAlpha: 0.02,
  /** Scanline spacing in pixels */
  scanlineSpacing: 3,
} as const;
