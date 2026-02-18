import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useGameStore, type EventLogEntry } from './state/GameStore';
import { getGameClient } from './network/GameClient';
import { SessionPanel } from './ui/SessionPanel';
import { BriefingPanel } from './ui/BriefingPanel';
import { RadarScope } from './radar/RadarScope';
import { StatusBar } from './ui/StatusBar';
import { DCBPanel } from './ui/DCBPanel';
import { CommPanel } from './ui/CommPanel';
import { CommandInput } from './ui/CommandInput';
import { FlightStripPanel } from './ui/FlightStripPanel';
import { CommandReference, CommandRefButton } from './ui/CommandReference';
import {
  unlockAudio,
  playNewStrip,
  playConflictAlert,
  playMSAW,
  playRunwayAlert,
  playHandoffOffered,
  playHandoffAccepted,
  playHandoffRejected,
  playPilotMessage,
} from './audio/SoundManager';

const appStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  position: 'relative',
  overflow: 'hidden',
};

/**
 * Watches game state changes and triggers synthesized audio cues.
 * Mounted only when in-session.
 */
const SoundEffects: React.FC = () => {
  const radioLog = useGameStore((s) => s.radioLog);
  const alerts = useGameStore((s) => s.alerts);
  const aircraft = useGameStore((s) => s.aircraft);

  const prevRadioLen = useRef(radioLog.length);
  const prevAlertIds = useRef(new Set(alerts.map((a) => a.id)));
  const prevAircraftIds = useRef(new Set(aircraft.map((a) => a.id)));

  // New radio / system message
  useEffect(() => {
    const prev = prevRadioLen.current;
    prevRadioLen.current = radioLog.length;
    if (radioLog.length <= prev) return;
    const newMsgs = radioLog.slice(prev);
    for (const msg of newMsgs) {
      if (msg.from === 'system') {
        if (msg.message.includes('radar contact')) {
          playHandoffAccepted();
        } else if (msg.message.includes('rejected')) {
          playHandoffRejected();
        } else if (msg.message.includes('radar handoff')) {
          playHandoffOffered();
        }
      } else if (msg.from !== 'controller') {
        // Pilot radio transmission — short squelch break tone
        playPilotMessage();
      }
    }
  }, [radioLog]);

  // New aircraft (new flight strip) — only chime for inbound arrivals, not ground departures
  useEffect(() => {
    const prev = prevAircraftIds.current;
    const current = new Set(aircraft.map((a) => a.id));
    let hasNew = false;
    for (const ac of aircraft) {
      if (!prev.has(ac.id) && !(ac.category === 'departure' && ac.onGround)) {
        hasNew = true;
        break;
      }
    }
    prevAircraftIds.current = current;
    if (hasNew) playNewStrip();
  }, [aircraft]);

  // New alerts
  useEffect(() => {
    const prev = prevAlertIds.current;
    const current = new Set(alerts.map((a) => a.id));
    let playedCA = false;
    let playedMSAW = false;
    let playedRwy = false;
    for (const alert of alerts) {
      if (!prev.has(alert.id)) {
        const t = alert.type?.toLowerCase() ?? '';
        if ((t.includes('conflict') || t.includes('ca')) && !playedCA) {
          playConflictAlert();
          playedCA = true;
        } else if ((t.includes('msaw') || t.includes('altitude')) && !playedMSAW) {
          playMSAW();
          playedMSAW = true;
        } else if ((t.includes('runway') || t.includes('incursion')) && !playedRwy) {
          playRunwayAlert();
          playedRwy = true;
        } else if (!playedCA) {
          playConflictAlert();
          playedCA = true;
        }
      }
    }
    prevAlertIds.current = current;
  }, [alerts]);

  return null;
};

/**
 * Watches game state and writes events to the event log panel.
 * Tracks: new conflict/MSAW/runway alerts, score deductions, missed handoffs.
 */
const EventLogger: React.FC = () => {
  const alerts = useGameStore((s) => s.alerts);
  const score = useGameStore((s) => s.score);
  const addEventLogEntry = useGameStore((s) => s.addEventLogEntry);

  const prevAlertIds = useRef(new Set(alerts.map((a) => a.id)));
  const prevViolations = useRef(score?.separationViolations ?? 0);
  const prevConflictAlerts = useRef(score?.conflictAlerts ?? 0);
  const prevMissedHandoffs = useRef(score?.missedHandoffs ?? 0);
  const prevScore = useRef(score?.overallScore ?? 100);

  // New alerts
  useEffect(() => {
    const prev = prevAlertIds.current;
    for (const alert of alerts) {
      if (!prev.has(alert.id)) {
        const type: EventLogEntry['type'] =
          alert.type === 'conflict' ? 'conflict' :
          alert.type === 'msaw' ? 'msaw' :
          alert.type === 'runwayConflict' ? 'runway' :
          alert.type === 'wake' ? 'wake' : 'info';
        addEventLogEntry({
          id: alert.id,
          timestamp: Date.now(),
          type,
          message: alert.message,
          severity: alert.severity === 'warning' ? 'warning' : 'caution',
        });
      }
    }
    prevAlertIds.current = new Set(alerts.map((a) => a.id));
  }, [alerts, addEventLogEntry]);

  // Score deductions — watch both named counters and overall score for
  // catch-all on handoff timing penalties (which don't have their own counter)
  useEffect(() => {
    if (!score) return;

    const now = Date.now();
    const scoreDrop = prevScore.current - score.overallScore;

    if (score.separationViolations > prevViolations.current) {
      addEventLogEntry({
        id: `sep-${now}`,
        timestamp: now,
        type: 'score',
        message: `Separation violation — −5 pts`,
        severity: 'warning',
      });
    }
    if (score.missedHandoffs > prevMissedHandoffs.current) {
      addEventLogEntry({
        id: `ho-${now}`,
        timestamp: now,
        type: 'handoff',
        message: `Missed handoff — score penalty`,
        severity: 'caution',
      });
    }
    if (score.conflictAlerts > prevConflictAlerts.current) {
      addEventLogEntry({
        id: `ca-score-${now}`,
        timestamp: now,
        type: 'score',
        message: `Conflict alert — score penalty`,
        severity: 'caution',
      });
    }
    // Catch handoff timing penalties (late tower/center/inbound accept)
    // that don't have dedicated counters — detect as unexpected score drop
    if (
      scoreDrop > 0 &&
      score.separationViolations === prevViolations.current &&
      score.missedHandoffs === prevMissedHandoffs.current &&
      score.conflictAlerts === prevConflictAlerts.current
    ) {
      addEventLogEntry({
        id: `ho-timing-${now}`,
        timestamp: now,
        type: 'handoff',
        message: `Late/missed handoff — −${scoreDrop} pts`,
        severity: 'caution',
      });
    }

    prevViolations.current = score.separationViolations;
    prevMissedHandoffs.current = score.missedHandoffs;
    prevConflictAlerts.current = score.conflictAlerts;
    prevScore.current = score.overallScore;
  }, [score, addEventLogEntry]);

  return null;
};

export const App: React.FC = () => {
  const inSession = useGameStore((s) => s.inSession);
  const showBriefing = useGameStore((s) => s.showBriefing);
  const [showCmdRef, setShowCmdRef] = useState(false);

  // Connect to server on mount
  useEffect(() => {
    const client = getGameClient();
    client.connect();
    return () => {
      client.disconnect();
    };
  }, []);

  // Unlock Web Audio on first user gesture (browser requirement)
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => {
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('pointerdown', unlock);
    };
  }, []);

  // Toggle command reference with '?' when not typing in an input
  useEffect(() => {
    if (!inSession) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === '?' && e.target === document.body) {
        e.preventDefault();
        setShowCmdRef(v => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [inSession]);

  const handleSessionStart = useCallback(() => {
    // inSession will be set to true when we receive sessionInfo with 'running' status
    // from the server via GameClient.handleMessage
  }, []);

  if (!inSession) {
    if (showBriefing) return <BriefingPanel />;
    return <SessionPanel onStart={handleSessionStart} />;
  }

  return (
    <div style={appStyle}>
      <SoundEffects />
      <EventLogger />
      <StatusBar showCmdRef={showCmdRef} onToggleCmdRef={() => setShowCmdRef(v => !v)} />
      <DCBPanel />
      <RadarScope />
      <FlightStripPanel />
      <CommPanel />
      <CommandInput />
      {showCmdRef && <CommandReference onClose={() => setShowCmdRef(false)} />}
    </div>
  );
};
