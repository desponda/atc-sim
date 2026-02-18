import type { Position } from './aircraft.js';

/** Navigation fix type */
export type FixType = 'waypoint' | 'navaid' | 'airport' | 'runway';

/** Navigation fix */
export interface Fix {
  /** Fix identifier (e.g., "CAMRN", "RIC") */
  id: string;
  /** Fix name if different from ID */
  name?: string;
  /** Fix type */
  type: FixType;
  /** Geographic position */
  position: Position;
}

/** Navaid type */
export type NavaidType = 'VOR' | 'VORDME' | 'DME' | 'NDB' | 'TACAN' | 'ILS';

/** Navigation aid */
export interface Navaid extends Fix {
  type: 'navaid';
  /** Navaid type */
  navaidType: NavaidType;
  /** Frequency (MHz or kHz for NDB) */
  frequency: number;
  /** Morse code identifier */
  morseId: string;
  /** Magnetic variation at navaid (degrees, negative = west) */
  magneticVariation: number;
  /** For ILS: runway it serves */
  ilsRunway?: string;
  /** For ILS: localizer course (degrees magnetic) */
  localizerCourse?: number;
  /** For ILS: glideslope angle (degrees) */
  glideslopeAngle?: number;
}

/** Runway definition */
export interface Runway {
  /** Runway designator (e.g., "16", "34", "07L") */
  id: string;
  /** Runway heading (degrees magnetic) */
  heading: number;
  /** Threshold position */
  threshold: Position;
  /** Opposite end position */
  end: Position;
  /** Length (feet) */
  length: number;
  /** Width (feet) */
  width: number;
  /** Threshold elevation (ft MSL) */
  elevation: number;
  /** ILS available */
  ilsAvailable: boolean;
  /** ILS frequency if available */
  ilsFrequency?: number;
  /** ILS course (degrees magnetic) */
  ilsCourse?: number;
  /** Glideslope angle */
  glideslopeAngle?: number;
  /** Displaced threshold distance (ft) */
  displacedThreshold?: number;
}

/** Procedure leg type (ARINC 424) */
export type LegType =
  | 'IF' // Initial Fix
  | 'TF' // Track to Fix
  | 'DF' // Direct to Fix
  | 'CF' // Course to Fix
  | 'FA' // Fix to Altitude
  | 'FC' // Fix to DME/Distance
  | 'FD' // Fix to DME/Distance
  | 'FM' // Fix to Manual
  | 'CA' // Course to Altitude
  | 'CD' // Course to DME
  | 'CI' // Course to Intercept
  | 'CR' // Course to Radial
  | 'HA' // Holding to Altitude
  | 'HF' // Holding to Fix (one turn)
  | 'HM' // Holding to Manual
  | 'PI' // Procedure Turn
  | 'RF' // Radius to Fix (arc)
  | 'VA' // Heading to Altitude
  | 'VD' // Heading to DME
  | 'VI' // Heading to Intercept
  | 'VM' // Heading to Manual
  | 'VR'; // Heading to Radial

/** Speed/altitude constraint */
export type AltitudeConstraint =
  | { type: 'at'; altitude: number }
  | { type: 'atOrAbove'; altitude: number }
  | { type: 'atOrBelow'; altitude: number }
  | { type: 'between'; min: number; max: number };

export type SpeedConstraint =
  | { type: 'at'; speed: number }
  | { type: 'atOrBelow'; speed: number };

/** A single leg in a procedure */
export interface ProcedureLeg {
  /** Leg type */
  legType: LegType;
  /** Fix for this leg */
  fix?: Fix;
  /** Course (degrees magnetic) */
  course?: number;
  /** Distance (nm) */
  distance?: number;
  /** Altitude constraint */
  altitudeConstraint?: AltitudeConstraint;
  /** Speed constraint */
  speedConstraint?: SpeedConstraint;
  /** Turn direction */
  turnDirection?: 'left' | 'right';
  /** Is this a flyover fix (vs fly-by) */
  flyover?: boolean;
}

/** Procedure transition */
export interface ProcedureTransition {
  /** Transition name (fix name or "ALL") */
  name: string;
  /** Legs in this transition */
  legs: ProcedureLeg[];
}

/** Standard Instrument Departure */
export interface SID {
  /** SID name (e.g., "JERES2") */
  name: string;
  /** Associated runways */
  runways: string[];
  /** Common legs (after runway-specific transition) */
  commonLegs: ProcedureLeg[];
  /** Runway-specific transitions */
  runwayTransitions: ProcedureTransition[];
  /** Enroute transitions */
  enrouteTransitions: ProcedureTransition[];
  /** Initial clearance altitude (ft MSL) — "climb via SID" top altitude */
  topAltitude?: number;
}

/** Standard Terminal Arrival Route */
export interface STAR {
  /** STAR name (e.g., "CAMRN4") */
  name: string;
  /** Associated runways */
  runways: string[];
  /** Common legs (before runway-specific transition) */
  commonLegs: ProcedureLeg[];
  /** Enroute transitions */
  enrouteTransitions: ProcedureTransition[];
  /** Runway transitions */
  runwayTransitions: ProcedureTransition[];
}

/** Instrument approach type */
export type ApproachType = 'ILS' | 'RNAV' | 'VOR' | 'NDB' | 'LOC' | 'LDA';

/** Instrument approach procedure */
export interface Approach {
  /** Approach name (e.g., "ILS RWY 16") */
  name: string;
  /** Approach type */
  approachType: ApproachType;
  /** Runway */
  runway: string;
  /** Approach legs */
  legs: ProcedureLeg[];
  /** Approach transitions (IAFs) */
  transitions: ProcedureTransition[];
  /** Missed approach legs */
  missedApproachLegs: ProcedureLeg[];
  /** Decision altitude / MDA (ft MSL) */
  minimums: number;
}

/** Airspace boundary segment */
export interface AirspaceBoundary {
  /** Name / identifier */
  name: string;
  /** Airspace class */
  class: 'A' | 'B' | 'C' | 'D' | 'E';
  /** Floor (ft MSL) */
  floor: number;
  /** Ceiling (ft MSL) */
  ceiling: number;
  /** Boundary polygon (lat/lon points) */
  boundary: Position[];
}

/** Video map feature type */
export type VideoMapFeatureType = 'line' | 'polygon' | 'label' | 'symbol';

/** A single feature within a video map (polyline, polygon, label, or airport symbol) */
export interface VideoMapFeature {
  /** Feature type */
  type: VideoMapFeatureType;
  /** Coordinate pairs for lines/polygons */
  points?: Position[];
  /** Label text (for 'label' and 'symbol' types) */
  text?: string;
  /** Label/symbol position */
  position?: Position;
  /** Optional color override (hex) */
  color?: string;
  /** Line dash pattern [dash, gap] - solid if omitted */
  lineDash?: number[];
}

/** A named, toggleable video map group (like real STARS numbered maps) */
export interface VideoMap {
  /** Map identifier (e.g., "jrv-north", "pct-mva") */
  id: string;
  /** Display name (e.g., "JRV North", "PCT MVA") */
  name: string;
  /** Short label for DCB button (e.g., "NORTH", "MVA") */
  shortName: string;
  /** Whether this map is visible by default */
  defaultVisible: boolean;
  /** Vice map ID number (from source data) */
  viceId?: number;
  /** Vice brightness group (0=A, 1=B) */
  group?: number;
  /** Vice category index */
  category?: number;
  /** Vice color index (0-8) */
  color?: number;
  /** Features in this map */
  features: VideoMapFeature[];
}

/** Complete airport nav data */
export interface AirportData {
  /** ICAO code */
  icao: string;
  /** Airport name */
  name: string;
  /** Reference position */
  position: Position;
  /** Field elevation (ft MSL) */
  elevation: number;
  /** Magnetic variation (degrees, negative = west) */
  magneticVariation: number;

  /** Runways */
  runways: Runway[];

  /** Frequencies */
  frequencies: {
    atis: number;
    approach: number[];
    tower: number[];
    ground: number[];
    departure: number[];
    center: number[];
  };

  /** All fixes within area */
  fixes: Fix[];
  /** Navaids */
  navaids: Navaid[];
  /** SIDs */
  sids: SID[];
  /** STARs */
  stars: STAR[];
  /** Approaches */
  approaches: Approach[];
  /** Airspace boundaries */
  airspace: AirspaceBoundary[];
  /** TRACON airspace vertical and lateral limits */
  tracon?: {
    name: string;
    /** Upper limit of TRACON airspace (ft MSL) */
    ceiling: number;
    /** Lower limit (ft MSL, 0 = surface) */
    floor: number;
    /** Approximate lateral radius (nm) */
    lateralRadiusNm: number;
  };
  /** Video maps (optional - numbered/toggleable geographic overlays) */
  videoMaps?: VideoMap[];
}
