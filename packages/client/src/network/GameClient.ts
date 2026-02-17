import type {
  ServerMessage,
  ClientMessage,
  ControllerCommand,
  SessionConfig,
} from '@atc-sim/shared';
import { useGameStore } from '../state/GameStore';

/**
 * WebSocket client for communicating with the game server.
 */
export class GameClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(url?: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url || `${protocol}//${window.location.host}/ws`;
  }

  /** Connect to the server */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const store = useGameStore.getState();
    store.setConnectionError(null);

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        useGameStore.getState().setConnected(true);
        useGameStore.getState().setConnectionError(null);
      };

      this.ws.onclose = () => {
        useGameStore.getState().setConnected(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        useGameStore.getState().setConnectionError('Connection failed');
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          this.handleMessage(message);
        } catch {
          // Ignore malformed messages
        }
      };
    } catch {
      store.setConnectionError('Failed to create WebSocket');
      this.scheduleReconnect();
    }
  }

  /** Disconnect from server */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Send a message to the server */
  private send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Send a controller command */
  sendCommand(command: ControllerCommand): void {
    this.send({ type: 'command', command });
  }

  /** Request a new session */
  createSession(config: SessionConfig): void {
    this.send({ type: 'createSession', config });
  }

  /** Send session control */
  sessionControl(action: 'start' | 'pause' | 'resume' | 'end', timeScale?: number): void {
    this.send({ type: 'sessionControl', action, timeScale });
  }

  /** Set time acceleration */
  setTimeScale(scale: number): void {
    this.send({ type: 'sessionControl', action: 'setTimeScale', timeScale: scale });
  }

  /** Update scratch pad text for an aircraft */
  updateScratchPad(aircraftId: string, text: string): void {
    this.send({ type: 'updateScratchPad', aircraftId, text });
  }

  private handleMessage(message: ServerMessage): void {
    const store = useGameStore.getState();

    switch (message.type) {
      case 'gameState':
        store.updateGameState(message.state);
        break;
      case 'radioMessage':
        store.addRadioMessage(message.transmission);
        break;
      case 'alert':
        store.addAlert(message.alert);
        break;
      case 'scoreUpdate':
        store.updateScore(message.score);
        break;
      case 'sessionInfo':
        store.setSession(message.session);
        if (message.session.status === 'lobby') {
          // Auto-start the session once created
          this.sessionControl('start');
        } else if (message.session.status === 'running') {
          store.setInSession(true);
        } else if (message.session.status === 'ended') {
          store.setInSession(false);
        }
        break;
      case 'airportData':
        store.setAirportData(message.data);
        break;
      case 'commandResponse':
        if (!message.success && message.error) {
          store.setLastCommandError(message.error);
        }
        break;
      case 'error':
        store.setConnectionError(message.message);
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

/** Singleton game client instance */
let clientInstance: GameClient | null = null;

export function getGameClient(): GameClient {
  if (!clientInstance) {
    clientInstance = new GameClient();
  }
  return clientInstance;
}
