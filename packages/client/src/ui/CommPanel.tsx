import React, { useRef, useEffect } from 'react';
import { useGameStore } from '../state/GameStore';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 24,
  right: 0,
  bottom: 32,
  width: 260,
  background: STARSColors.panelBg,
  borderLeft: `1px solid ${STARSColors.panelBorder}`,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: STARSFonts.family,
  fontSize: STARSFonts.panel,
  color: STARSColors.normal,
  overflow: 'hidden',
  userSelect: 'none',
};

const headerStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: `1px solid ${STARSColors.panelBorder}`,
  color: STARSColors.dimText,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const logStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '4px 6px',
};

const messageStyle = (from: string): React.CSSProperties => {
  const isController = from === 'controller';
  const isSystem = from === 'system';
  return {
    marginBottom: 4,
    lineHeight: 1.45,
    fontSize: isSystem ? 11 : 12,
    color: isController
      ? STARSColors.radioController
      : isSystem
        ? STARSColors.radioSystem
        : STARSColors.radioPilot,
    textShadow: isController ? `0 0 3px ${STARSColors.glow}` : 'none',
    wordBreak: 'break-word',
    fontStyle: isSystem ? 'italic' : 'normal',
  };
};

const timeStyle: React.CSSProperties = {
  color: STARSColors.dimText,
  marginRight: 4,
  fontSize: 10,
  textShadow: 'none',
};

function formatLogTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export const CommPanel: React.FC = () => {
  const radioLog = useGameStore((s) => s.radioLog);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [radioLog.length]);

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>Comm Log</div>
      <div style={logStyle}>
        {radioLog.map((msg) => {
          const isController = msg.from === 'controller';
          const isSystem = msg.from === 'system';
          return (
            <div key={msg.id} style={messageStyle(msg.from)}>
              <span style={timeStyle}>{formatLogTime(msg.timestamp)}</span>
              {!isSystem && (
                <strong>{isController ? 'ATC' : msg.from}: </strong>
              )}
              {msg.message}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <style>{`
        div::-webkit-scrollbar {
          width: 6px;
        }
        div::-webkit-scrollbar-track {
          background: #000000;
        }
        div::-webkit-scrollbar-thumb {
          background: #003300;
          border-radius: 3px;
        }
        div::-webkit-scrollbar-thumb:hover {
          background: #004400;
        }
      `}</style>
    </div>
  );
};
