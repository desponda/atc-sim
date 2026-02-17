/** All supported ATC command types */
export type CommandType =
  | 'altitude'
  | 'heading'
  | 'speed'
  | 'approach'
  | 'direct'
  | 'hold'
  | 'sid'
  | 'star'
  | 'climbViaSID'
  | 'descendViaSTAR'
  | 'handoff'
  | 'goAround'
  | 'expectApproach'
  | 'expectRunway'
  | 'cancelApproach'
  | 'resumeOwnNavigation';

export interface AltitudeCommand {
  type: 'altitude';
  /** Target altitude in feet MSL */
  altitude: number;
  /** Optional: cross at a specific fix */
  atFix?: string;
  /** Climb or descend */
  direction: 'climb' | 'descend';
}

export interface HeadingCommand {
  type: 'heading';
  /** Target heading in degrees magnetic */
  heading: number;
  /** Turn direction */
  turnDirection: 'left' | 'right' | null;
}

export interface SpeedCommand {
  type: 'speed';
  /** Target speed in knots IAS, or null for "resume normal speed" */
  speed: number | null;
}

export interface ApproachCommand {
  type: 'approach';
  /** Approach type */
  approachType: 'ILS' | 'RNAV' | 'VISUAL';
  /** Runway designator (e.g., "16", "34", "07") */
  runway: string;
  /** Altitude to maintain until established on the localizer/final approach course */
  maintainUntilEstablished?: number;
  /** Fix to cross at altitude before approach */
  crossFix?: string;
  /** Altitude to cross fix at */
  crossAltitude?: number;
  /** "at or above" vs "at" for cross restriction */
  crossType?: 'at' | 'atOrAbove';
}

export interface DirectCommand {
  type: 'direct';
  /** Fix name to proceed direct to */
  fix: string;
}

export interface HoldCommand {
  type: 'hold';
  /** Fix to hold at */
  fix: string;
  /** "as published" or custom */
  asPublished: boolean;
  /** Inbound course (if not as published) */
  inboundCourse?: number;
  /** Turn direction in hold */
  turnDirection?: 'left' | 'right';
  /** Leg length in minutes or nm */
  legLength?: number;
}

export interface SIDCommand {
  type: 'sid';
  /** SID name */
  name: string;
}

export interface STARCommand {
  type: 'star';
  /** STAR name */
  name: string;
}

export interface ClimbViaSIDCommand {
  type: 'climbViaSID';
}

export interface DescendViaSTARCommand {
  type: 'descendViaSTAR';
}

export interface HandoffCommand {
  type: 'handoff';
  /** Facility to contact */
  facility: 'tower' | 'center' | 'approach' | 'departure' | 'ground';
  /** Frequency */
  frequency: number;
}

export interface GoAroundCommand {
  type: 'goAround';
}

export interface ExpectApproachCommand {
  type: 'expectApproach';
  approachType: 'ILS' | 'RNAV' | 'VISUAL';
  runway: string;
}

export interface ExpectRunwayCommand {
  type: 'expectRunway';
  runway: string;
}

export interface CancelApproachCommand {
  type: 'cancelApproach';
}

export interface ResumeOwnNavigationCommand {
  type: 'resumeOwnNavigation';
}

/** Union of all command types */
export type ATCCommand =
  | AltitudeCommand
  | HeadingCommand
  | SpeedCommand
  | ApproachCommand
  | DirectCommand
  | HoldCommand
  | SIDCommand
  | STARCommand
  | ClimbViaSIDCommand
  | DescendViaSTARCommand
  | HandoffCommand
  | GoAroundCommand
  | ExpectApproachCommand
  | ExpectRunwayCommand
  | CancelApproachCommand
  | ResumeOwnNavigationCommand;

/** A complete command issued by the controller */
export interface ControllerCommand {
  /** Target aircraft callsign */
  callsign: string;
  /** Parsed commands (can issue multiple at once) */
  commands: ATCCommand[];
  /** Raw text as entered */
  rawText: string;
  /** Timestamp */
  timestamp: number;
}

/** Command parse result */
export interface ParseResult {
  success: boolean;
  command?: ControllerCommand;
  error?: string;
  /** Suggestions for autocomplete */
  suggestions?: string[];
}
