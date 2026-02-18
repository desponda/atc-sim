import type { GameState, SessionConfig, SessionInfo, RadioTransmission, Alert, ScoreMetrics } from './game.js';
import type { AirportData } from './navdata.js';
import type { ControllerCommand } from './command.js';

/** ===== Server → Client Messages ===== */

export interface GameStateMessage {
  type: 'gameState';
  state: GameState;
}

export interface RadioMessage {
  type: 'radioMessage';
  transmission: RadioTransmission;
}

export interface AlertMessage {
  type: 'alert';
  alert: Alert;
}

export interface ScoreUpdateMessage {
  type: 'scoreUpdate';
  score: ScoreMetrics;
}

export interface SessionInfoMessage {
  type: 'sessionInfo';
  session: SessionInfo;
}

export interface AirportDataMessage {
  type: 'airportData';
  data: AirportData;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  code?: string;
}

export interface CommandResponseMessage {
  type: 'commandResponse';
  success: boolean;
  callsign: string;
  rawText: string;
  error?: string;
}

export type ServerMessage =
  | GameStateMessage
  | RadioMessage
  | AlertMessage
  | ScoreUpdateMessage
  | SessionInfoMessage
  | AirportDataMessage
  | ErrorMessage
  | CommandResponseMessage;

/** ===== Client → Server Messages ===== */

export interface CommandMessage {
  type: 'command';
  command: ControllerCommand;
}

export interface CreateSessionMessage {
  type: 'createSession';
  config: SessionConfig;
}

export interface SessionControlMessage {
  type: 'sessionControl';
  action: 'start' | 'pause' | 'resume' | 'end' | 'setTimeScale';
  timeScale?: number;
}

export interface UpdateScratchPadMessage {
  type: 'updateScratchPad';
  aircraftId: string;
  text: string;
}

export interface RadarHandoffMessage {
  type: 'radarHandoff';
  aircraftId: string;
}

export interface AcceptHandoffMessage {
  type: 'acceptHandoff';
  aircraftId: string;
}

export type ClientMessage =
  | CommandMessage
  | CreateSessionMessage
  | SessionControlMessage
  | UpdateScratchPadMessage
  | RadarHandoffMessage
  | AcceptHandoffMessage;
