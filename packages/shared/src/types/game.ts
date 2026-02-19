import type { AircraftState } from './aircraft.js';

/** Wind at a specific altitude */
export interface WindLayer {
  /** Altitude in feet MSL */
  altitude: number;
  /** Wind direction (degrees magnetic, where wind is FROM) */
  direction: number;
  /** Wind speed (knots) */
  speed: number;
  /** Gust speed (knots), null if no gusts */
  gusts: number | null;
}

/** Weather/environmental conditions */
export interface WeatherState {
  /** Wind layers from surface up */
  winds: WindLayer[];
  /** Altimeter setting (inches Hg) */
  altimeter: number;
  /** Temperature at field elevation (°C) */
  temperature: number;
  /** Visibility (statute miles) */
  visibility: number;
  /** Ceiling (ft AGL), null if clear */
  ceiling: number | null;
  /** Current ATIS letter */
  atisLetter: string;
}

/** Runway configuration */
export interface RunwayConfig {
  /** Active arrival runways */
  arrivalRunways: string[];
  /** Active departure runways */
  departureRunways: string[];
}

/** Traffic density setting */
export type TrafficDensity = 'light' | 'moderate' | 'heavy';

/** Scenario type */
export type ScenarioType = 'arrivals' | 'departures' | 'mixed';

/** Session configuration */
export interface SessionConfig {
  /** Airport ICAO code */
  airport: string;
  /** Traffic density */
  density: TrafficDensity;
  /** Scenario type */
  scenarioType: ScenarioType;
  /** Active runway configuration */
  runwayConfig: RunwayConfig;
  /** Initial weather */
  weather: WeatherState;
}

/** Simulation time state */
export interface SimulationClock {
  /** Current simulation time (Unix ms) */
  time: number;
  /** Time acceleration factor */
  timeScale: number;
  /** Ticks elapsed since session start */
  tickCount: number;
  /** Is simulation running */
  running: boolean;
  /** Is simulation paused */
  paused: boolean;
}

/** Alert severity */
export type AlertSeverity = 'caution' | 'warning';

/** Active alert */
export interface Alert {
  id: string;
  type: 'conflict' | 'msaw' | 'wake' | 'runwayConflict' | 'airspace';
  severity: AlertSeverity;
  /** Aircraft involved */
  aircraftIds: string[];
  message: string;
  timestamp: number;
}

/** Radio transmission */
export interface RadioTransmission {
  id: string;
  /** Who is transmitting */
  from: 'controller' | string; // 'controller' or aircraft callsign
  /** Message text */
  message: string;
  /** Timestamp */
  timestamp: number;
  /** Frequency */
  frequency: number;
}

/** Score breakdown */
export interface ScoreMetrics {
  /** Total separation violations */
  separationViolations: number;
  /** Total duration of violations (seconds) */
  violationDuration: number;
  /** Number of conflict alerts triggered */
  conflictAlerts: number;
  /** Aircraft handled (arrived/departed from airspace) */
  aircraftHandled: number;
  /** Average delay per aircraft (seconds) */
  averageDelay: number;
  /** Commands issued */
  commandsIssued: number;
  /** Handoff quality (0-100) */
  handoffQuality: number;
  /** Aircraft that left airspace without proper handoff */
  missedHandoffs: number;
  /** Overall score (0-100) */
  overallScore: number;
  /** Letter grade */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

/** TRACON airspace limits for display */
export interface TRACONLimits {
  /** Lateral radius in nm from airport center */
  lateralRadiusNm: number;
  /** Ceiling altitude (ft MSL) */
  ceiling: number;
  /** Floor altitude (ft MSL) */
  floor: number;
}

/** Full game state sent to client */
export interface GameState {
  /** Session ID */
  sessionId: string;
  /** All aircraft */
  aircraft: AircraftState[];
  /** Simulation clock */
  clock: SimulationClock;
  /** Current weather */
  weather: WeatherState;
  /** Active runway config */
  runwayConfig: RunwayConfig;
  /** Active alerts */
  alerts: Alert[];
  /** Current score metrics */
  score: ScoreMetrics;
  /** Current ATIS broadcast text */
  atisText: string;
  /** TRACON airspace limits */
  traconLimits: TRACONLimits;
}

/** Session status */
export type SessionStatus = 'lobby' | 'running' | 'paused' | 'ended';

/** Session info */
export interface SessionInfo {
  id: string;
  config: SessionConfig;
  status: SessionStatus;
  createdAt: number;
  /** Final score if ended */
  finalScore?: ScoreMetrics;
}
