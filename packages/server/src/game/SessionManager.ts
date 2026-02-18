import type {
  SessionConfig,
  SessionInfo,
  SessionStatus,
  GameState,
  AirportData,
  ScoreMetrics,
} from '@atc-sim/shared';
import { v4 as uuid } from 'uuid';
import { SimulationEngine } from '../engine/SimulationEngine.js';
import { loadAirportData } from '../data/AirportLoader.js';

/**
 * SessionManager handles session lifecycle: create, start, pause, resume, end.
 */
export class SessionManager {
  private sessions = new Map<
    string,
    {
      info: SessionInfo;
      engine: SimulationEngine;
      airportData: AirportData;
    }
  >();

  /** Create a new session */
  createSession(config: SessionConfig): SessionInfo {
    const id = uuid();
    const airportData = loadAirportData(config.airport);
    const engine = new SimulationEngine(config, airportData);

    const info: SessionInfo = {
      id,
      config,
      status: 'lobby',
      createdAt: Date.now(),
    };

    this.sessions.set(id, { info, engine, airportData });
    console.log(`[SessionManager] Created session ${id} for ${config.airport}`);
    return info;
  }

  /** Start a session simulation */
  startSession(
    sessionId: string,
    onStateUpdate: (state: GameState) => void
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.info.status !== 'lobby' && session.info.status !== 'paused') return false;

    session.info.status = 'running';
    session.engine.start(onStateUpdate);
    return true;
  }

  /** Pause a session */
  pauseSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== 'running') return false;

    session.info.status = 'paused';
    session.engine.pause();
    return true;
  }

  /** Resume a paused session */
  resumeSession(
    sessionId: string,
    onStateUpdate: (state: GameState) => void
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== 'paused') return false;

    session.info.status = 'running';
    session.engine.resume(onStateUpdate);
    return true;
  }

  /** End a session */
  endSession(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.engine.stop();
    session.info.status = 'ended';
    session.info.finalScore = session.engine.getScore();
    return session.info;
  }

  /** Set time scale for a session */
  setTimeScale(sessionId: string, timeScale: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.engine.setTimeScale(timeScale);
    return true;
  }

  /** Get session info */
  getSessionInfo(sessionId: string): SessionInfo | null {
    return this.sessions.get(sessionId)?.info ?? null;
  }

  /** Get simulation engine for a session */
  getEngine(sessionId: string): SimulationEngine | null {
    return this.sessions.get(sessionId)?.engine ?? null;
  }

  /** Get airport data for a session */
  getAirportData(sessionId: string): AirportData | null {
    return this.sessions.get(sessionId)?.airportData ?? null;
  }

  /** Remove a session */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.engine.stop();
      this.sessions.delete(sessionId);
    }
  }

  /** Get all session IDs */
  getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}
