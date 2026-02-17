import React, { useState } from 'react';
import { useGameStore } from '../state/GameStore';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';

const barStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  background: STARSColors.panelBg,
  borderBottom: `1px solid ${STARSColors.panelBorder}`,
  padding: '0 12px',
  fontFamily: STARSFonts.family,
  fontSize: STARSFonts.statusBar,
  color: STARSColors.normal,
  textShadow: `0 0 3px ${STARSColors.glow}`,
  userSelect: 'none',
};

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'center',
};

const separatorStyle: React.CSSProperties = {
  color: STARSColors.dimText,
  textShadow: 'none',
};

const atisPopupStyle: React.CSSProperties = {
  position: 'absolute',
  top: 26,
  left: '50%',
  transform: 'translateX(-50%)',
  background: STARSColors.panelBg,
  border: `1px solid ${STARSColors.panelBorder}`,
  padding: '8px 12px',
  fontFamily: STARSFonts.family,
  fontSize: STARSFonts.statusBar,
  color: STARSColors.normal,
  textShadow: `0 0 3px ${STARSColors.glow}`,
  maxWidth: 500,
  zIndex: 100,
  lineHeight: '1.4',
  whiteSpace: 'pre-wrap',
};

const connectedDotStyle = (connected: boolean): React.CSSProperties => ({
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  backgroundColor: connected ? STARSColors.normal : STARSColors.alert,
  boxShadow: connected
    ? `0 0 4px ${STARSColors.glow}`
    : '0 0 4px #ff0000',
  marginRight: 5,
  verticalAlign: 'middle',
});

function formatZuluTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}${m}${s}Z`;
}

export const StatusBar: React.FC = () => {
  const clock = useGameStore((s) => s.clock);
  const weather = useGameStore((s) => s.weather);
  const runwayConfig = useGameStore((s) => s.runwayConfig);
  const connected = useGameStore((s) => s.connected);
  const aircraft = useGameStore((s) => s.aircraft);
  const atisText = useGameStore((s) => s.atisText);

  const [showAtis, setShowAtis] = useState(false);

  const timeStr = clock ? formatZuluTime(clock.time) : '--:--:--Z';
  const timeScale = clock?.timeScale ?? 1;
  const windStr = weather?.winds[0]
    ? `${String(weather.winds[0].direction).padStart(3, '0')}/${String(weather.winds[0].speed).padStart(2, '0')}KT`
    : '---/--KT';
  const altStr = weather ? weather.altimeter.toFixed(2) : '--.--';
  const atisLetter = weather?.atisLetter ?? '-';
  const arrRwys = runwayConfig?.arrivalRunways.join('/') ?? '--';
  const depRwys = runwayConfig?.departureRunways.join('/') ?? '--';
  const acCount = aircraft.length;

  return (
    <div style={barStyle}>
      <div style={sectionStyle}>
        <span style={{ color: STARSColors.inputText }}>{timeStr}</span>
        {timeScale !== 1 && <span style={{ color: STARSColors.caution }}>x{timeScale}</span>}
        <span style={separatorStyle}>|</span>
        <span>WIND {windStr}</span>
        <span style={separatorStyle}>|</span>
        <span
          style={{ cursor: 'pointer', fontWeight: 'bold' }}
          onClick={() => setShowAtis(!showAtis)}
          title="Click to show/hide ATIS"
        >
          ATIS {atisLetter}
        </span>
        <span style={separatorStyle}>|</span>
        <span>ALT {altStr}</span>
      </div>
      <div style={sectionStyle}>
        <span>ARR {arrRwys}</span>
        <span style={separatorStyle}>|</span>
        <span>DEP {depRwys}</span>
        <span style={separatorStyle}>|</span>
        <span>AC {acCount}</span>
        <span style={separatorStyle}>|</span>
        <span style={{ color: connected ? STARSColors.normal : STARSColors.alert }}>
          <span style={connectedDotStyle(connected)} />
          {connected ? 'CONNECTED' : 'OFFLINE'}
        </span>
      </div>
      {showAtis && atisText && (
        <div style={atisPopupStyle}>{atisText}</div>
      )}
    </div>
  );
};
