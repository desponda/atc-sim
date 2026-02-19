import React, { useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import { getGameClient } from '../network/GameClient';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';
import type { SessionConfig, TrafficDensity, ScenarioType } from '@atc-sim/shared';
import { generateRandomWeather, wxCategoryColor } from './weatherGen';
import {
  KRIC_RUNWAY_INFO,
  KRIC_RUNWAYS,
  approachCapability,
  availableRunways,
  defaultRunwayConfig,
} from '../utils/runwayUtils';

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
  color: '#999999',
  fontSize: 10,
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
  textShadow: 'none',
  fontFamily: STARSFonts.family,
  fontSize: 13,
  cursor: 'pointer',
};

const buttonGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
};

const optionButtonStyle = (active: boolean, disabled = false): React.CSSProperties => ({
  flex: 1,
  padding: '5px 6px',
  background: active ? STARSColors.panelButtonActive : STARSColors.panelButton,
  border: `1px solid ${active ? '#00aa00' : STARSColors.panelBorder}`,
  color: disabled ? '#444' : (active ? STARSColors.normal : '#999999'),
  textShadow: 'none',
  boxShadow: active ? 'inset 0 1px 3px rgba(0,0,0,0.6)' : 'none',
  fontFamily: STARSFonts.family,
  fontSize: 12,
  cursor: disabled ? 'not-allowed' : 'pointer',
  textAlign: 'center',
  opacity: disabled ? 0.35 : 1,
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
  border: `1px solid #00aa00`,
  color: STARSColors.inputText,
  textShadow: 'none',
  boxShadow: `0 0 6px rgba(0,221,0,0.15)`,
  fontFamily: STARSFonts.family,
  fontSize: 14,
  cursor: 'pointer',
  marginTop: 24,
  letterSpacing: 3,
  textTransform: 'uppercase',
};


interface SessionPanelProps {
  onStart?: () => void;
}

export const SessionPanel: React.FC<SessionPanelProps> = ({ onStart }) => {
  const [airport] = useState('KRIC');
  const [density, setDensity] = useState<TrafficDensity>('moderate');
  const [scenarioType, setScenarioType] = useState<ScenarioType>('mixed');

  // Initialize wx and runways together so the selection reflects the initial wind + wx
  const [wxInit] = useState(() => {
    const wx = generateRandomWeather();
    const cfg = defaultRunwayConfig(wx.weather);
    return { wx, cfg };
  });
  const [wxConditions, setWxConditions] = useState(wxInit.wx);
  const [arrRunways, setArrRunways] = useState<string[]>(wxInit.cfg.arr);
  const [depRunways, setDepRunways] = useState<string[]>(wxInit.cfg.dep);

  const rerollWeather = useCallback(() => {
    const newWx = generateRandomWeather();
    const avail = availableRunways(newWx.weather);
    const cfg = defaultRunwayConfig(newWx.weather);
    setWxConditions(newWx);
    // Reapply default config; if a previously selected runway is now unavailable, drop it
    setArrRunways(cfg.arr.filter(r => avail.includes(r)));
    setDepRunways(cfg.dep.filter(r => avail.includes(r)));
  }, []);

  const toggleRunway = useCallback((set: Dispatch<SetStateAction<string[]>>, r: string) => {
    set((prev: string[]) => {
      if (prev.includes(r)) {
        return prev.length > 1 ? prev.filter((x: string) => x !== r) : prev;
      }
      return [...prev, r];
    });
  }, []);

  const handleStart = useCallback(() => {
    const config: SessionConfig = {
      airport,
      density,
      scenarioType,
      runwayConfig: {
        arrivalRunways: arrRunways,
        departureRunways: depRunways,
      },
      weather: wxConditions.weather,
    };

    getGameClient().createSession(config);
    onStart?.();
  }, [airport, density, scenarioType, arrRunways, depRunways, wxConditions, onStart]);

  return (
    <div style={containerStyle}>
      <div style={panelOuterStyle}>
        <div style={titleStyle}>STARS</div>
        <div style={subtitleStyle}>SESSION SETUP</div>

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

        {/* Runways — multi-select toggles */}
        {(() => {
          const avail = availableRunways(wxConditions.weather);
          const flowCfg = defaultRunwayConfig(wxConditions.weather);
          // Flow label: derived from which long runway (16/34) is in the default set
          const flowLabel = flowCfg.arr.includes('34') ? 'NORTH FLOW'
            : flowCfg.arr.includes('16') ? 'SOUTH FLOW'
            : flowCfg.arr.includes('02') ? 'NE FLOW'
            : 'SW FLOW';

          const RunwayButtons = ({
            selected, onToggle,
          }: { selected: string[]; onToggle: (r: string) => void }) => (
            <div style={buttonGroupStyle}>
              {KRIC_RUNWAYS.map((r) => {
                const info = KRIC_RUNWAY_INFO[r];
                const cap = approachCapability(r, wxConditions.weather);
                const isAvail = cap !== null;
                const isActive = selected.includes(r);
                const capColor = cap === 'ILS' ? STARSColors.normal : cap === 'RNAV' ? STARSColors.caution : '#00cc44';
                return (
                  <button
                    key={r}
                    style={optionButtonStyle(isActive, !isAvail)}
                    onClick={() => isAvail && onToggle(r)}
                    title={isAvail ? `RWY ${r} — ${info.lengthFt.toLocaleString()} ft — ${cap} (click to toggle)` : `RWY ${r} — below minimums`}
                  >
                    <div style={{ fontSize: 12, lineHeight: '1.2' }}>{r}</div>
                    <div style={{ fontSize: 9, marginTop: 1, color: isAvail ? capColor : '#444' }}>
                      {isAvail ? cap : 'N/A'}
                    </div>
                    <div style={{ fontSize: 9, color: '#888888' }}>
                      {(info.lengthFt / 1000).toFixed(1)}k
                    </div>
                  </button>
                );
              })}
            </div>
          );

          return (
            <>
              <div style={{ ...fieldGroupStyle, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={labelStyle}>ARRIVAL RUNWAYS</span>
                  <span style={{ fontSize: 9, color: '#999999', letterSpacing: 1 }}>{flowLabel}</span>
                </div>
                <RunwayButtons
                  selected={arrRunways}
                  onToggle={r => toggleRunway(setArrRunways, r)}
                />
              </div>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>DEPARTURE RUNWAYS</label>
                <RunwayButtons
                  selected={depRunways}
                  onToggle={r => toggleRunway(setDepRunways, r)}
                />
              </div>
            </>
          );
        })()}

        {/* Weather */}
        <div style={fieldGroupStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>WEATHER CONDITIONS</label>
            <button
              onClick={rerollWeather}
              style={{
                background: 'transparent',
                border: `1px solid #444444`,
                color: '#999999',
                fontFamily: STARSFonts.family,
                fontSize: 10,
                padding: '2px 7px',
                cursor: 'pointer',
                letterSpacing: 1,
              }}
            >
              RE-ROLL
            </button>
          </div>
          <div style={{
            border: `1px solid ${STARSColors.panelBorder}`,
            padding: '7px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: wxCategoryColor(wxConditions.category), fontSize: 12, fontWeight: 'bold', letterSpacing: 1 }}>
                {wxConditions.category}
              </span>
              <span style={{ color: STARSColors.dimText, fontSize: 10 }}>{wxConditions.description}</span>
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: STARSColors.normal }}>
              <span>
                {String(wxConditions.weather.winds[0]?.direction ?? 0).padStart(3, '0')}°
                {' / '}
                {wxConditions.weather.winds[0]?.speed ?? 0}kt
                {wxConditions.weather.winds[0]?.gusts ? ` G${wxConditions.weather.winds[0].gusts}kt` : ''}
              </span>
              <span>VIS {wxConditions.weather.visibility} SM</span>
              <span>
                {wxConditions.weather.ceiling === null
                  ? 'CLR'
                  : `OVC ${wxConditions.weather.ceiling} ft`}
              </span>
              <span>ALT {wxConditions.weather.altimeter.toFixed(2)}</span>
            </div>
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
