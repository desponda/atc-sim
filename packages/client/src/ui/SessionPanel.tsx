import React, { useState, useCallback } from 'react';
import { getGameClient } from '../network/GameClient';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';
import type { SessionConfig, TrafficDensity, ScenarioType, WeatherState } from '@atc-sim/shared';

const containerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: STARSColors.background,
  fontFamily: STARSFonts.family,
  color: STARSColors.normal,
};

const panelOuterStyle: React.CSSProperties = {
  border: `1px solid ${STARSColors.panelBorder}`,
  boxShadow: `0 0 8px rgba(0,221,0,0.08), inset 0 0 30px rgba(0,221,0,0.02)`,
  background: STARSColors.panelBg,
  padding: 32,
  minWidth: 400,
  maxWidth: 500,
};

const titleStyle: React.CSSProperties = {
  fontSize: 16,
  marginBottom: 8,
  textAlign: 'center',
  letterSpacing: 3,
  textTransform: 'uppercase',
  color: STARSColors.inputText,
  textShadow: `0 0 6px ${STARSColors.glow}`,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 8,
  marginBottom: 24,
  textAlign: 'center',
  letterSpacing: 2,
  textTransform: 'uppercase',
  color: STARSColors.dimText,
};

const fieldGroupStyle: React.CSSProperties = {
  marginBottom: 16,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  color: STARSColors.dimText,
  fontSize: 8,
  textTransform: 'uppercase',
  letterSpacing: 1,
  marginBottom: 6,
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  background: STARSColors.panelBg,
  border: `1px solid ${STARSColors.panelBorder}`,
  color: STARSColors.normal,
  textShadow: `0 0 3px ${STARSColors.glow}`,
  fontFamily: STARSFonts.family,
  fontSize: 13,
  cursor: 'pointer',
};

const buttonGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
};

const optionButtonStyle = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '6px 8px',
  background: active ? STARSColors.panelButtonActive : STARSColors.panelButton,
  border: `1px solid ${active ? '#003300' : STARSColors.panelBorder}`,
  color: active ? STARSColors.normal : STARSColors.dimText,
  textShadow: active ? `0 0 4px ${STARSColors.glow}` : 'none',
  boxShadow: active ? 'inset 0 1px 3px rgba(0,0,0,0.6)' : 'none',
  fontFamily: STARSFonts.family,
  fontSize: 12,
  cursor: 'pointer',
  textAlign: 'center',
});

const inputFieldStyle: React.CSSProperties = {
  ...selectStyle,
  width: 80,
  outline: 'none',
};

const startButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px',
  background: STARSColors.panelButtonActive,
  border: `1px solid #003300`,
  color: STARSColors.inputText,
  textShadow: `0 0 6px ${STARSColors.glow}`,
  boxShadow: `0 0 6px rgba(0,221,0,0.15)`,
  fontFamily: STARSFonts.family,
  fontSize: 14,
  cursor: 'pointer',
  marginTop: 24,
  letterSpacing: 3,
  textTransform: 'uppercase',
};

const defaultWeather: WeatherState = {
  winds: [{ altitude: 0, direction: 200, speed: 8, gusts: null }],
  altimeter: 29.92,
  temperature: 15,
  visibility: 10,
  ceiling: null,
  atisLetter: 'A',
};

interface SessionPanelProps {
  onStart?: () => void;
}

export const SessionPanel: React.FC<SessionPanelProps> = ({ onStart }) => {
  const [airport] = useState('KRIC');
  const [density, setDensity] = useState<TrafficDensity>('moderate');
  const [scenarioType, setScenarioType] = useState<ScenarioType>('mixed');
  const [arrRunway, setArrRunway] = useState('16');
  const [depRunway, setDepRunway] = useState('16');
  const [windDir, setWindDir] = useState(200);
  const [windSpd, setWindSpd] = useState(8);

  const handleStart = useCallback(() => {
    const config: SessionConfig = {
      airport,
      density,
      scenarioType,
      runwayConfig: {
        arrivalRunways: [arrRunway],
        departureRunways: [depRunway],
      },
      weather: {
        ...defaultWeather,
        winds: [{ altitude: 0, direction: windDir, speed: windSpd, gusts: null }],
      },
    };

    getGameClient().createSession(config);
    onStart?.();
  }, [airport, density, scenarioType, arrRunway, depRunway, windDir, windSpd, onStart]);

  return (
    <div style={containerStyle}>
      <div style={panelOuterStyle}>
        <div style={titleStyle}>STARS</div>
        <div style={subtitleStyle}>STANDARD TERMINAL AUTOMATION REPLACEMENT SYSTEM</div>

        {/* Airport */}
        <div style={fieldGroupStyle}>
          <label style={labelStyle}>FACILITY</label>
          <select style={selectStyle} value={airport} disabled>
            <option value="KRIC">KRIC - Richmond International</option>
          </select>
        </div>

        {/* Traffic Density */}
        <div style={fieldGroupStyle}>
          <label style={labelStyle}>TRAFFIC DENSITY</label>
          <div style={buttonGroupStyle}>
            {(['light', 'moderate', 'heavy'] as TrafficDensity[]).map((d) => (
              <button key={d} style={optionButtonStyle(density === d)} onClick={() => setDensity(d)}>
                {d.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Scenario Type */}
        <div style={fieldGroupStyle}>
          <label style={labelStyle}>SCENARIO</label>
          <div style={buttonGroupStyle}>
            {(['arrivals', 'departures', 'mixed'] as ScenarioType[]).map((s) => (
              <button key={s} style={optionButtonStyle(scenarioType === s)} onClick={() => setScenarioType(s)}>
                {s.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Runways */}
        <div style={fieldGroupStyle}>
          <label style={labelStyle}>ARRIVAL RUNWAY</label>
          <div style={buttonGroupStyle}>
            {['16', '34', '07', '25'].map((r) => (
              <button key={r} style={optionButtonStyle(arrRunway === r)} onClick={() => setArrRunway(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>

        <div style={fieldGroupStyle}>
          <label style={labelStyle}>DEPARTURE RUNWAY</label>
          <div style={buttonGroupStyle}>
            {['16', '34', '07', '25'].map((r) => (
              <button key={r} style={optionButtonStyle(depRunway === r)} onClick={() => setDepRunway(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Wind */}
        <div style={fieldGroupStyle}>
          <label style={labelStyle}>SURFACE WIND</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              value={windDir}
              onChange={(e) => setWindDir(Math.max(0, Math.min(360, parseInt(e.target.value) || 0)))}
              style={inputFieldStyle}
              min={0}
              max={360}
            />
            <span style={{ color: STARSColors.dimText }}>@</span>
            <input
              type="number"
              value={windSpd}
              onChange={(e) => setWindSpd(Math.max(0, Math.min(50, parseInt(e.target.value) || 0)))}
              style={{ ...inputFieldStyle, width: 60 }}
              min={0}
              max={50}
            />
            <span style={{ color: STARSColors.dimText }}>KT</span>
          </div>
        </div>

        {/* Start */}
        <button style={startButtonStyle} onClick={handleStart}>
          INITIALIZE SESSION
        </button>
      </div>
      <style>{`
        select:focus, input:focus {
          outline: 1px solid #003300 !important;
          box-shadow: 0 0 4px rgba(0,221,0,0.1) !important;
        }
        select option {
          background: #000000;
          color: #00dd00;
        }
        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button {
          opacity: 0.3;
        }
      `}</style>
    </div>
  );
};
