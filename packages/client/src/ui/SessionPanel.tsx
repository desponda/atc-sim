import React, { useState, useCallback } from 'react';
import { getGameClient } from '../network/GameClient';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';
import type { SessionConfig, TrafficDensity, ScenarioType, WeatherState } from '@atc-sim/shared';
import { generateRandomWeather, wxCategoryColor } from './weatherGen';

/** KRIC runway capabilities sourced from kric.json + real-world approach plates.
 *  minimumsAGL = DA/MDA in feet above field elevation (KRIC elev = 167ft MSL). */
const KRIC_RUNWAY_INFO: Record<string, {
  heading: number;
  lengthFt: number;
  approaches: Array<{ type: 'ILS' | 'RNAV' }>;
  minimumsAGL: number; // lowest available minimums for this runway
}> = {
  '16': { heading: 157, lengthFt: 9003, approaches: [{ type: 'ILS' }, { type: 'RNAV' }], minimumsAGL: 342 },
  '34': { heading: 337, lengthFt: 9003, approaches: [{ type: 'ILS' }, { type: 'RNAV' }], minimumsAGL: 322 },
  '02': { heading: 23,  lengthFt: 6607, approaches: [{ type: 'ILS' }, { type: 'RNAV' }], minimumsAGL: 316 },
  '20': { heading: 203, lengthFt: 6607, approaches: [{ type: 'RNAV' }],                  minimumsAGL: 337 },
};

const KRIC_RUNWAYS = ['16', '34', '02', '20'];

/** Best available approach type for a runway given current weather */
function approachCapability(rwyId: string, wx: WeatherState): 'ILS' | 'RNAV' | 'VISUAL' | null {
  const info = KRIC_RUNWAY_INFO[rwyId];
  if (!info) return null;
  const ceiling = wx.ceiling ?? Infinity;
  const vis = wx.visibility;
  // Visual: ceiling ≥ 1000 ft AGL, vis ≥ 3 SM (FAA VFR minima)
  if (ceiling >= 1000 && vis >= 3) return 'VISUAL';
  // ILS: ceiling above DA, vis ≥ 0.75 SM (CAT I minima)
  if (info.approaches.some(a => a.type === 'ILS') && ceiling >= info.minimumsAGL && vis >= 0.75) return 'ILS';
  // RNAV: ceiling above MDA, vis ≥ 1 SM
  if (info.approaches.some(a => a.type === 'RNAV') && ceiling >= info.minimumsAGL && vis >= 1.0) return 'RNAV';
  return null; // Below all minimums
}

/** Runways usable under current weather */
function availableRunways(wx: WeatherState): string[] {
  return KRIC_RUNWAYS.filter(r => approachCapability(r, wx) !== null);
}

/** Runway with best headwind from available list; prefers longer runway as tiebreaker */
function bestRunwayForWind(windDir: number, available: string[]): string {
  if (available.length === 0) return KRIC_RUNWAYS[0];
  let best = available[0];
  let bestScore = -Infinity;
  for (const rwyId of available) {
    const info = KRIC_RUNWAY_INFO[rwyId];
    const angle = Math.abs(((windDir - info.heading + 180 + 360) % 360) - 180);
    // Headwind preference (lower angle = better) + tiny length bonus as tiebreaker
    const score = (180 - angle) + info.lengthFt / 100_000;
    if (score > bestScore) { bestScore = score; best = rwyId; }
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

const optionButtonStyle = (active: boolean, disabled = false): React.CSSProperties => ({
  flex: 1,
  padding: '5px 6px',
  background: active ? STARSColors.panelButtonActive : STARSColors.panelButton,
  border: `1px solid ${active ? '#003300' : STARSColors.panelBorder}`,
  color: disabled ? '#333' : (active ? STARSColors.normal : STARSColors.dimText),
  textShadow: active && !disabled ? `0 0 4px ${STARSColors.glow}` : 'none',
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

  // Initialize wx and runways together so the runway reflects the initial wind + wx
  const [wxInit] = useState(() => {
    const wx = generateRandomWeather();
    const avail = availableRunways(wx.weather);
    const best = bestRunwayForWind(wx.weather.winds[0]?.direction ?? 0, avail);
    return { wx, best };
  });
  const [wxConditions, setWxConditions] = useState(wxInit.wx);
  const [arrRunway, setArrRunway] = useState(wxInit.best);
  const [depRunway, setDepRunway] = useState(wxInit.best);

  const rerollWeather = useCallback(() => {
    const newWx = generateRandomWeather();
    const avail = availableRunways(newWx.weather);
    const best = bestRunwayForWind(newWx.weather.winds[0]?.direction ?? 0, avail);
    setWxConditions(newWx);
    // If the current runway is no longer available under the new wx, switch to best
    setArrRunway(prev => avail.includes(prev) ? prev : best);
    setDepRunway(prev => avail.includes(prev) ? prev : best);
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
          const avail = availableRunways(wxConditions.weather);
          const recommended = windSpeed > 0 ? bestRunwayForWind(windDir, avail) : avail[0] ?? null;

          const RunwayButtons = ({ selected, onSelect }: { selected: string; onSelect: (r: string) => void }) => (
            <div style={buttonGroupStyle}>
              {KRIC_RUNWAYS.map((r) => {
                const info = KRIC_RUNWAY_INFO[r];
                const cap = approachCapability(r, wxConditions.weather);
                const isAvail = cap !== null;
                const isActive = selected === r;
                const isRec = r === recommended && !isActive;
                const capColor = cap === 'ILS' ? STARSColors.normal : cap === 'RNAV' ? STARSColors.caution : STARSColors.dimText;
                return (
                  <button
                    key={r}
                    style={optionButtonStyle(isActive, !isAvail)}
                    onClick={() => isAvail && onSelect(r)}
                    title={isAvail ? `RWY ${r} — ${info.lengthFt} ft — ${cap}` : `RWY ${r} — below minimums`}
                  >
                    <div style={{ fontSize: 12, lineHeight: '1.2' }}>
                      {r}{isRec ? <span style={{ color: STARSColors.caution, fontSize: 8 }}> ▲</span> : null}
                    </div>
                    <div style={{ fontSize: 8, marginTop: 1, color: isAvail ? capColor : '#333' }}>
                      {isAvail ? cap : 'N/A'}
                    </div>
                    <div style={{ fontSize: 8, color: STARSColors.dimText }}>
                      {(info.lengthFt / 1000).toFixed(1)}k
                    </div>
                  </button>
                );
              })}
            </div>
          );

          return (
            <>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>ARRIVAL RUNWAY</label>
                <RunwayButtons selected={arrRunway} onSelect={setArrRunway} />
              </div>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>DEPARTURE RUNWAY</label>
                <RunwayButtons selected={depRunway} onSelect={setDepRunway} />
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
