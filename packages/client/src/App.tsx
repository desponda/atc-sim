import React, { useEffect, useCallback } from 'react';
import { useGameStore } from './state/GameStore';
import { getGameClient } from './network/GameClient';
import { SessionPanel } from './ui/SessionPanel';
import { RadarScope } from './radar/RadarScope';
import { StatusBar } from './ui/StatusBar';
import { DCBPanel } from './ui/DCBPanel';
import { CommPanel } from './ui/CommPanel';
import { CommandInput } from './ui/CommandInput';
import { FlightStripPanel } from './ui/FlightStripPanel';

const appStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  position: 'relative',
  overflow: 'hidden',
};

export const App: React.FC = () => {
  const inSession = useGameStore((s) => s.inSession);

  // Connect to server on mount
  useEffect(() => {
    const client = getGameClient();
    client.connect();
    return () => {
      client.disconnect();
    };
  }, []);

  const handleSessionStart = useCallback(() => {
    // inSession will be set to true when we receive sessionInfo with 'running' status
    // from the server via GameClient.handleMessage
  }, []);

  if (!inSession) {
    return <SessionPanel onStart={handleSessionStart} />;
  }

  return (
    <div style={appStyle}>
      <StatusBar />
      <DCBPanel />
      <RadarScope />
      <FlightStripPanel />
      <CommPanel />
      <CommandInput />
    </div>
  );
};
