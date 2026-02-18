import express from 'express';
import { createServer } from 'http';
import { existsSync } from 'fs';
import { join } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ClientMessage,
  ServerMessage,
  GameState,
  RadioTransmission,
  Alert,
  SessionConfig,
} from '@atc-sim/shared';
import { SessionManager } from './game/SessionManager.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ─── Express app ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const sessionManager = new SessionManager();

// REST: Create session
app.post('/api/session', (req, res) => {
  try {
    const config = req.body as SessionConfig;
    if (!config.airport) {
      res.status(400).json({ error: 'airport is required' });
      return;
    }
    const session = sessionManager.createSession(config);
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Health check (used by K8s liveness/readiness probes)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// REST: Get session info
app.get('/api/session/:id', (req, res) => {
  const info = sessionManager.getSessionInfo(req.params.id);
  if (!info) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(info);
});

// ─── HTTP server ───────────────────────────────────────────────────────────
const server = createServer(app);

// ─── WebSocket server ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

/** Track which session each WebSocket belongs to */
const clientSessions = new Map<WebSocket, string>();

wss.on('connection', (ws: WebSocket) => {
  console.log('[WS] Client connected');

  ws.on('message', (data: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      sendMessage(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    handleClientMessage(ws, msg);
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    clientSessions.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

function handleClientMessage(ws: WebSocket, msg: ClientMessage): void {
  switch (msg.type) {
    case 'createSession': {
      try {
        const config = msg.config;
        if (!config.airport) {
          sendMessage(ws, { type: 'error', message: 'airport is required' });
          return;
        }
        const session = sessionManager.createSession(config);
        clientSessions.set(ws, session.id);
        sendMessage(ws, { type: 'sessionInfo', session });
        // Send airport data to the client for map rendering
        const airportData = sessionManager.getAirportData(session.id);
        if (airportData) {
          sendMessage(ws, { type: 'airportData', data: airportData });
        }
      } catch (e) {
        sendMessage(ws, { type: 'error', message: String(e) });
      }
      break;
    }

    case 'sessionControl': {
      const sessionId = clientSessions.get(ws);
      if (!sessionId) {
        sendMessage(ws, { type: 'error', message: 'No session. Create one first.' });
        return;
      }

      switch (msg.action) {
        case 'start': {
          const stateCallback = (state: GameState) => {
            state.sessionId = sessionId;
            broadcastToSession(sessionId, { type: 'gameState', state });
          };

          const engine = sessionManager.getEngine(sessionId);
          if (engine) {
            engine.setOnRadioMessage((transmission: RadioTransmission) => {
              broadcastToSession(sessionId, { type: 'radioMessage', transmission });
            });
            engine.setOnAlert((alert: Alert) => {
              broadcastToSession(sessionId, { type: 'alert', alert });
            });
          }

          const ok = sessionManager.startSession(sessionId, stateCallback);
          if (!ok) {
            sendMessage(ws, { type: 'error', message: 'Cannot start session' });
            return;
          }
          const info = sessionManager.getSessionInfo(sessionId);
          if (info) sendMessage(ws, { type: 'sessionInfo', session: info });
          break;
        }

        case 'pause': {
          sessionManager.pauseSession(sessionId);
          const info = sessionManager.getSessionInfo(sessionId);
          if (info) sendMessage(ws, { type: 'sessionInfo', session: info });
          break;
        }

        case 'resume': {
          const stateCallback = (state: GameState) => {
            state.sessionId = sessionId;
            broadcastToSession(sessionId, { type: 'gameState', state });
          };
          sessionManager.resumeSession(sessionId, stateCallback);
          const info = sessionManager.getSessionInfo(sessionId);
          if (info) sendMessage(ws, { type: 'sessionInfo', session: info });
          break;
        }

        case 'end': {
          const finalInfo = sessionManager.endSession(sessionId);
          if (finalInfo) sendMessage(ws, { type: 'sessionInfo', session: finalInfo });
          break;
        }

        case 'setTimeScale': {
          if (msg.timeScale != null) {
            sessionManager.setTimeScale(sessionId, msg.timeScale);
          }
          break;
        }
      }
      break;
    }

    case 'command': {
      const sessionId = clientSessions.get(ws);
      if (!sessionId) {
        sendMessage(ws, { type: 'error', message: 'No session' });
        return;
      }

      const engine = sessionManager.getEngine(sessionId);
      if (!engine) {
        sendMessage(ws, { type: 'error', message: 'Session not found' });
        return;
      }

      const result = engine.processCommand(msg.command.rawText);
      sendMessage(ws, {
        type: 'commandResponse',
        success: result.success,
        callsign: result.callsign,
        rawText: result.rawText,
        error: result.error,
      });

      // Note: readback is already broadcast via the engine's onRadioMessage callback
      // set up in the 'start' handler, so we don't send it again here.
      break;
    }

    case 'updateScratchPad': {
      const sessionId = clientSessions.get(ws);
      if (!sessionId) {
        sendMessage(ws, { type: 'error', message: 'No session' });
        return;
      }

      const engine = sessionManager.getEngine(sessionId);
      if (!engine) {
        sendMessage(ws, { type: 'error', message: 'Session not found' });
        return;
      }

      engine.updateScratchPad(msg.aircraftId, msg.text);
      break;
    }

    case 'radarHandoff': {
      const sessionId = clientSessions.get(ws);
      if (!sessionId) {
        sendMessage(ws, { type: 'error', message: 'No session' });
        return;
      }

      const engine = sessionManager.getEngine(sessionId);
      if (!engine) {
        sendMessage(ws, { type: 'error', message: 'Session not found' });
        return;
      }

      const result = engine.processRadarHandoff(msg.aircraftId);
      sendMessage(ws, {
        type: 'commandResponse',
        success: result.success,
        callsign: result.callsign,
        rawText: 'radar handoff',
        error: result.error,
      });
      break;
    }

    case 'acceptHandoff': {
      const sessionId = clientSessions.get(ws);
      if (!sessionId) {
        sendMessage(ws, { type: 'error', message: 'No session' });
        return;
      }

      const engine = sessionManager.getEngine(sessionId);
      if (!engine) {
        sendMessage(ws, { type: 'error', message: 'Session not found' });
        return;
      }

      const result = engine.processAcceptHandoff(msg.aircraftId);
      sendMessage(ws, {
        type: 'commandResponse',
        success: result.success,
        callsign: result.callsign,
        rawText: 'acceptHandoff',
        error: result.error,
      });
      break;
    }
  }
}

function sendMessage(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToSession(sessionId: string, msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const [client, sid] of clientSessions) {
    if (sid === sessionId && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── Static client (production) ────────────────────────────────────────────
const staticDir = process.env.STATIC_DIR;
if (staticDir && existsSync(staticDir)) {
  app.use(express.static(staticDir));
  // SPA fallback — all non-API routes serve index.html
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(staticDir, 'index.html'));
    }
  });
  console.log(`[Server] Serving static client from ${staticDir}`);
}

// ─── Start server ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Server] ATC Simulation server running on port ${PORT}`);
  console.log(`[Server] REST: http://localhost:${PORT}/api/session`);
  console.log(`[Server] WebSocket: ws://localhost:${PORT}`);
});
