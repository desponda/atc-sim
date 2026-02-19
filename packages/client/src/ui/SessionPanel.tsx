import React, { useState, useCallback } from 'react';
import { getGameClient } from '../network/GameClient';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';
import type { SessionConfig, TrafficDensity, ScenarioType } from '@atc-sim/shared';
import { generateRandomWeather, wxCategoryColor } from './weatherGen';

const KRIC_RUNWAYS = ['16', '34', '07', '25'];

/** Approximate runway heading from designator (e.g. "16" → 160°, "34" → 340°) */
function headingFromRunway(rwyId: string): number {
  return parseInt(rwyId.replace(/[LCR]/g, ''), 10) * 10;
}

/** Return the runway with the smallest headwind angle for the given wind direction */
function bestRunwayForWind(windDir: number, runways: string[] = KRIC_RUNWAYS): string {
  let best = runways[0];
  let bestAngle = 181;
  for (const rwy of runways) {
    const hdg = headingFromRunway(rwy);
    const angle = Math.abs(((windDir - hdg + 180 + 360) % 360) - 180);
    if (angle < bestAngle) { bestAngle = angle; best = rwy; }
  }
  return best;
}

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


interface SessionPanelProps {
  onStart?: () => void;
}

export const SessionPanel: React.FC<SessionPanelProps> = ({ onStart }) => {
  const [airport] = useState('KRIC');
  const [density, setDensity] = useState<TrafficDensity>('moderate');
  const [scenarioType, setScenarioType] = useState<ScenarioType>('mixed');

  // Initialize wx and runways together so the runway reflects the initial wind
  const [wxInit] = useState(() => {
    const wx = generateRandomWeather();
    const best = bestRunwayForWind(wx.weather.winds[0]?.direction ?? 0);
    return { wx, best };
  });
  const [wxConditions, setWxConditions] = useState(wxInit.wx);
  const [arrRunway, setArrRunway] = useState(wxInit.best);
  const [depRunway, setDepRunway] = useState(wxInit.best);

  const rerollWeather = useCallback(() => {
    const newWx = generateRandomWeather();
    const best = bestRunwayForWind(newWx.weather.winds[0]?.direction ?? 0);
    setWxConditions(newWx);
    setArrRunway(best);
    setDepRunway(best);
  }, []);

  const handleStart = useCallback(() => {
    const config: SessionConfig = {
      airport,
      density,
      scenarioType,
      runwayConfig: {
        arrivalRunways: [arrRunway],
        departureRunways: [depRunway],
      },
      weather: wxConditions.weather,
    };

    getGameClient().createSession(config);
    onStart?.();
  }, [airport, density, scenarioType, arrRunway, depRunway, wxConditions, onStart]);

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
        {(() => {
          const windDir = wxConditions.weather.winds[0]?.direction ?? 0;
          const windSpeed = wxConditions.weather.winds[0]?.speed ?? 0;
          const recommended = windSpeed > 0 ? bestRunwayForWind(windDir) : null;
          return (
            <>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>ARRIVAL RUNWAY</label>
                <div style={buttonGroupStyle}>
                  {KRIC_RUNWAYS.map((r) => (
                    <button key={r} style={optionButtonStyle(arrRunway === r)} onClick={() => setArrRunway(r)}>
                      {r}{recommended === r && arrRunway !== r ? <span style={{ color: STARSColors.caution, fontSize: 8 }}> ▲</span> : null}
                    </button>
                  ))}
                </div>
              </div>

              <div style={fieldGroupStyle}>
                <label style={labelStyle}>DEPARTURE RUNWAY</label>
                <div style={buttonGroupStyle}>
                  {KRIC_RUNWAYS.map((r) => (
                    <button key={r} style={optionButtonStyle(depRunway === r)} onClick={() => setDepRunway(r)}>
                      {r}{recommended === r && depRunway !== r ? <span style={{ color: STARSColors.caution, fontSize: 8 }}> ▲</span> : null}
                    </button>
                  ))}
                </div>
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
                border: `1px solid ${STARSColors.panelBorder}`,
                color: STARSColors.dimText,
                fontFamily: STARSFonts.family,
                fontSize: 9,
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
