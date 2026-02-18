import React, { useRef, useEffect } from 'react';
import { useGameStore, type EventLogEntry } from '../state/GameStore';
import { STARSFonts } from '../radar/rendering/STARSTheme';

const FONT = STARSFonts.family;

/** Color by severity */
function entryColor(entry: EventLogEntry): string {
  if (entry.severity === 'warning') return '#ff4444';
  if (entry.severity === 'caution') return '#ffaa00';
  return '#8899aa';
}

/** Short prefix tag by type */
function typeTag(entry: EventLogEntry): string {
  switch (entry.type) {
    case 'conflict': return 'CA';
    case 'msaw':     return 'MSAW';
    case 'runway':   return 'RWY';
    case 'wake':     return 'WAKE';
    case 'score':    return 'SCORE';
    case 'handoff':  return 'HO';
    case 'info':     return 'INFO';
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  left: 204,
  bottom: 36,
  width: 360,
  maxHeight: 160,
  overflowY: 'auto',
  background: 'rgba(0,0,0,0.78)',
  border: '1px solid #1a2a1a',
  borderRadius: 3,
  fontFamily: FONT,
  fontSize: 11,
  zIndex: 20,
  pointerEvents: 'none',
  userSelect: 'none',
};

const headerStyle: React.CSSProperties = {
  padding: '2px 6px',
  background: '#0a140a',
  color: '#446644',
  fontSize: 9,
  letterSpacing: 1,
  textTransform: 'uppercase',
  borderBottom: '1px solid #1a2a1a',
};

const rowStyle = (entry: EventLogEntry, age: number): React.CSSProperties => ({
  display: 'flex',
  gap: 6,
  padding: '1px 6px',
  lineHeight: '16px',
  opacity: Math.max(0.35, 1 - age * 0.08), // fade older entries
  borderBottom: '1px solid rgba(30,50,30,0.4)',
});

export const EventLog: React.FC = () => {
  const eventLog = useGameStore((s) => s.eventLog);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [eventLog.length]);

  if (eventLog.length === 0) return null;

  const recent = eventLog.slice(-10);

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>Event Log</div>
      {recent.map((entry, idx) => {
        const age = recent.length - 1 - idx; // 0 = newest
        const color = entryColor(entry);
        return (
          <div key={entry.id} style={rowStyle(entry, age)}>
            <span style={{ color: '#445544', fontSize: 9, whiteSpace: 'nowrap', alignSelf: 'center' }}>
              {formatTime(entry.timestamp)}
            </span>
            <span style={{ color, fontWeight: 'bold', fontSize: 10, whiteSpace: 'nowrap', minWidth: 36 }}>
              {typeTag(entry)}
            </span>
            <span style={{ color: color, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.message}
            </span>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
