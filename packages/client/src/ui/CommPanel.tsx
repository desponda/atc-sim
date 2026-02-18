import React, { useRef, useEffect } from 'react';
import { useGameStore, type EventLogEntry } from '../state/GameStore';
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

function eventColor(entry: EventLogEntry): string {
  if (entry.severity === 'warning') return '#ff4444';
  if (entry.severity === 'caution') return '#ffaa00';
  return '#8899aa';
}

function eventTag(entry: EventLogEntry): string {
  switch (entry.type) {
    case 'conflict': return 'CA';
    case 'msaw':     return 'MSAW';
    case 'runway':   return 'RWY';
    case 'wake':     return 'WAKE';
    case 'score':    return 'SCORE';
    case 'handoff':  return 'HO';
    default:         return 'INFO';
  }
}

export const CommPanel: React.FC = () => {
  const radioLog = useGameStore((s) => s.radioLog);
  const eventLog = useGameStore((s) => s.eventLog);
  const commBottomRef = useRef<HTMLDivElement>(null);
  const eventBottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll comm log to bottom on new messages
  useEffect(() => {
    commBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [radioLog.length]);

  // Auto-scroll event log to bottom on new events
  useEffect(() => {
    eventBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [eventLog.length]);

  const recentEvents = eventLog.slice(-20);

  return (
    <div style={panelStyle}>
      {/* Comm Log — takes all remaining space */}
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
        <div ref={commBottomRef} />
      </div>

      {/* Event Log — fixed height at the bottom, always visible */}
      <div style={{
        borderTop: `1px solid ${STARSColors.panelBorder}`,
        background: '#020802',
        flexShrink: 0,
      }}>
        <div style={{
          ...headerStyle,
          borderBottom: `1px solid ${STARSColors.panelBorder}`,
          color: '#446644',
        }}>
          Event Log
        </div>
        <div style={{
          height: 148,
          overflowY: 'auto',
          padding: '2px 0',
          fontSize: 10,
          fontFamily: STARSFonts.family,
        }}>
          {recentEvents.length === 0 ? (
            <div style={{ padding: '6px 8px', color: '#2a3a2a', fontStyle: 'italic', fontSize: 10 }}>
              No events
            </div>
          ) : (
            recentEvents.map((entry, idx) => {
              const color = eventColor(entry);
              const age = recentEvents.length - 1 - idx;
              const opacity = Math.max(0.4, 1 - age * 0.05);
              return (
                <div key={entry.id} style={{
                  display: 'flex',
                  gap: 5,
                  padding: '2px 6px',
                  lineHeight: '15px',
                  opacity,
                  borderBottom: `1px solid rgba(30,50,30,0.3)`,
                }}>
                  <span style={{ color: '#334433', fontSize: 9, whiteSpace: 'nowrap', alignSelf: 'center', minWidth: 44 }}>
                    {formatLogTime(entry.timestamp)}
                  </span>
                  <span style={{ color, fontWeight: 'bold', fontSize: 10, whiteSpace: 'nowrap', minWidth: 34 }}>
                    {eventTag(entry)}
                  </span>
                  <span style={{ color, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.message}
                  </span>
                </div>
              );
            })
          )}
          <div ref={eventBottomRef} />
        </div>
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
