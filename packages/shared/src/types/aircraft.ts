/** Aircraft weight/wake turbulence category */
export type WakeCategory = 'SUPER' | 'HEAVY' | 'LARGE' | 'SMALL';

/** Aircraft equipment/capability */
export interface AircraftCapability {
  rnav: boolean;
  rnavGps: boolean;
  ils: boolean;
  vor: boolean;
  dme: boolean;
}

/** Aircraft performance envelope */
export interface AircraftPerformance {
  /** ICAO type designator (e.g., "B738") */
  typeDesignator: string;
  /** Full name (e.g., "Boeing 737-800") */
  name: string;
  /** Wake turbulence category */
  wakeCategory: WakeCategory;

  speed: {
    /** Minimum clean speed (kts IAS) */
    vminClean: number;
    /** Minimum speed with flaps (kts IAS) */
    vminFlaps: number;
    /** Typical approach speed (kts IAS) */
    vapp: number;
    /** Reference landing speed (kts IAS) */
    vref: number;
    /** Max IAS below 10,000 (kts) - typically 250 */
    vmaxBelow10k: number;
    /** Max operating speed (kts IAS) */
    vmo: number;
    /** Max operating Mach */
    mmo: number;
    /** Typical cruise speed (kts IAS) */
    typicalCruiseIAS: number;
    /** Typical cruise Mach */
    typicalCruiseMach: number;
  };

  climb: {
    /** Initial climb rate (ft/min) from sea level */
    initialRate: number;
    /** Climb rate at 10,000ft (ft/min) */
    rateAt10k: number;
    /** Climb rate at FL240 (ft/min) */
    rateAt24k: number;
    /** Climb rate at FL350 (ft/min) */
    rateAt35k: number;
    /** Typical acceleration altitude (ft AGL) */
    accelAltitude: number;
  };

  descent: {
    /** Standard descent rate (ft/min) */
    standardRate: number;
    /** Maximum descent rate (ft/min) */
    maxRate: number;
    /** Typical idle descent gradient (nm per 1000ft) */
    idleGradient: number;
  };

  turn: {
    /** Standard rate turn (deg/sec) */
    standardRate: number;
    /** Max bank angle (degrees) */
    maxBank: number;
  };

  /** Service ceiling (ft MSL) */
  ceiling: number;

  /** Default capability */
  capability: AircraftCapability;
}

/** Phase of flight */
export type FlightPhase =
  | 'ground'
  | 'departure'
  | 'climb'
  | 'cruise'
  | 'descent'
  | 'approach'
  | 'final'
  | 'missed'
  | 'landed';

/** Transponder mode */
export type TransponderMode = 'off' | 'standby' | 'modeC' | 'ident';

/** Assigned clearances from ATC */
export interface Clearances {
  /** Assigned altitude (ft MSL), null if none */
  altitude: number | null;
  /** Assigned heading (degrees magnetic), null if none (fly nav) */
  heading: number | null;
  /** Assigned speed (kts IAS), null if none */
  speed: number | null;
  /** Turn direction preference */
  turnDirection: 'left' | 'right' | null;
  /** Cleared approach type + runway, null if not cleared */
  approach: { type: 'ILS' | 'RNAV' | 'VISUAL'; runway: string } | null;
  /** Cleared to hold at fix */
  holdFix: string | null;
  /** Cleared to proceed direct to fix */
  directFix: string | null;
  /** Cleared SID/STAR name */
  procedure: string | null;
  /** "Climb via SID" / "Descend via STAR" active */
  climbViaSID: boolean;
  /** "Descend via STAR" active */
  descendViaSTAR: boolean;
  /** Expected approach type */
  expectedApproach: { type: 'ILS' | 'RNAV' | 'VISUAL'; runway: string } | null;
  /** Altitude to maintain until established on localizer/final approach course */
  maintainUntilEstablished: number | null;
  /** Handoff frequency */
  handoffFrequency: number | null;
}

/** Aircraft flight plan */
export interface FlightPlan {
  /** Departure airport ICAO */
  departure: string;
  /** Arrival airport ICAO */
  arrival: string;
  /** Filed cruise altitude (ft MSL) */
  cruiseAltitude: number;
  /** Filed route as fix names */
  route: string[];
  /** Assigned SID name */
  sid: string | null;
  /** Assigned STAR name */
  star: string | null;
  /** Assigned runway */
  runway: string | null;
  /** Squawk code */
  squawk: string;
}

/** Geographic position */
export interface Position {
  lat: number;
  lon: number;
}

/** Complete aircraft state */
export interface AircraftState {
  /** Unique identifier */
  id: string;
  /** Callsign (e.g., "UAL123") */
  callsign: string;
  /** ICAO type designator */
  typeDesignator: string;
  /** Wake category */
  wakeCategory: WakeCategory;

  /** Current position */
  position: Position;
  /** Current altitude (ft MSL) */
  altitude: number;
  /** Current heading (degrees magnetic) */
  heading: number;
  /** Current indicated airspeed (kts) */
  speed: number;
  /** Current groundspeed (kts) */
  groundspeed: number;
  /** Current vertical speed (ft/min) */
  verticalSpeed: number;
  /** Is aircraft on the ground */
  onGround: boolean;

  /** Current flight phase */
  flightPhase: FlightPhase;
  /** Transponder mode */
  transponder: TransponderMode;

  /** Flight plan */
  flightPlan: FlightPlan;
  /** Active ATC clearances */
  clearances: Clearances;

  /** Current route fix index being navigated to */
  currentFixIndex: number;
  /** Is aircraft established on localizer */
  onLocalizer: boolean;
  /** Is aircraft established on glideslope */
  onGlideslope: boolean;
  /** Is this aircraft being handed off */
  handingOff: boolean;

  /** Arrival or departure from controller perspective */
  category: 'arrival' | 'departure' | 'overflight' | 'vfr';

  /** History trail positions (most recent first) */
  historyTrail: Position[];

  /** Target values being flown toward */
  targetAltitude: number;
  targetHeading: number;
  targetSpeed: number;

  /** Bank angle (degrees, positive = right) */
  bankAngle: number;

  /** Controller scratch pad notes (free-text, client-editable) */
  scratchPad?: string;
}
