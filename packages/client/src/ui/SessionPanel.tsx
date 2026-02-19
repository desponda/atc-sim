import React, { useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import { getGameClient } from '../network/GameClient';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';
import type { SessionConfig, TrafficDensity, ScenarioType, WeatherState } from '@atc-sim/shared';
import { generateRandomWeather, wxCategoryColor } from './weatherGen';

/** KRIC runway capabilities.
 *  DA/MDA values match PilotAI.ts which hardcodes: ILS = runway.elevation + 200 ft,
 *  RNAV = runway.elevation + 400 ft. These drive server-side go-around decisions.
 *  The kric.json approach `minimums` field is currently unused by the server.
 *  Vis mins: ILS CAT I = 0.5 SM (RVR 2400), RNAV = 1.0 SM. */
const KRIC_RUNWAY_INFO: Record<string, {
  heading: number;
  lengthFt: number;
  ilsMinimumsAGL: number | null;  // null = no ILS
  rnavMinimumsAGL: number | null; // null = no RNAV
}> = {
  '16': { heading: 157, lengthFt: 9003, ilsMinimumsAGL: 200, rnavMinimumsAGL: 400 },
  '34': { heading: 337, lengthFt: 9003, ilsMinimumsAGL: 200, rnavMinimumsAGL: 400 },
  '02': { heading: 23,  lengthFt: 6607, ilsMinimumsAGL: 200, rnavMinimumsAGL: 400 },
  '20': { heading: 203, lengthFt: 6607, ilsMinimumsAGL: null, rnavMinimumsAGL: 400 },
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
  // ILS CAT I: ceiling ≥ DA (200 ft HAT), vis ≥ 0.5 SM (RVR 2400)
  if (info.ilsMinimumsAGL !== null && ceiling >= info.ilsMinimumsAGL && vis >= 0.5) return 'ILS';
  // RNAV (LPV/LNAV): ceiling ≥ MDA, vis ≥ 1 SM
  if (info.rnavMinimumsAGL !== null && ceiling >= info.rnavMinimumsAGL && vis >= 1.0) return 'RNAV';
  return null; // Below all minimums
}

/** Runways usable under current weather */
function availableRunways(wx: WeatherState): string[] {
  return KRIC_RUNWAYS.filter(r => approachCapability(r, wx) !== null);
}

/**
 * Determine the default active runway set for the given weather.
 *
 * Logic mirrors real-world KRIC operations:
 *   - Flow is determined by whether the wind has a northerly (→ RWY 34) or
 *     southerly (→ RWY 16) component.  Calm/variable defaults to north flow.
 *   - The long runway (16 or 34, 9 003 ft) is always the primary; it stays
 *     preferred unless the crosswind component exceeds ~25 kt on it, which
 *     almost never happens in the weather ranges we generate.
 *   - Opposite-end runways (16 vs 34) are never active simultaneously.
 *   - The crosswind runway (02 or 20) is added as a secondary departure option
 *     when its headwind component is meaningfully better than the primary's
 *     crosswind (i.e. winds are closer to east/west than north/south), AND the
 *     runway is available under the current weather.
 *   - Returns { arr, dep } arrays; caller may still override via the UI.
 */
function defaultRunwayConfig(wx: WeatherState): { arr: string[]; dep: string[] } {
  const avail = availableRunways(wx);
  if (avail.length === 0) return { arr: ['34'], dep: ['34'] }; // shouldn't happen after clamp

  const windDir = wx.winds[0]?.direction ?? 0;
  const windSpd = wx.winds[0]?.speed ?? 0;

  // North flow: wind from 270–090 (inclusive), calm, or variable → use RWY 34
  // South flow: wind from 090–270 → use RWY 16
  const northFlow = windSpd === 0 || windDir >= 270 || windDir <= 90;
  const primary = northFlow ? '34' : '16';
  // Crosswind companion: 02 goes with 34 (north flow), 20 goes with 16 (south flow)
  const crosswind = northFlow ? '02' : '20';

  // Fall back to best available if primary is somehow not available (e.g. deep LIFR)
  const usePrimary = avail.includes(primary) ? primary : avail[0];

  // Add the crosswind runway as a secondary dep option only when:
  //   1. it's available under current weather
  //   2. its headwind angle is < 60° (it actually has a meaningful headwind component)
  const crosswindInfo = KRIC_RUNWAY_INFO[crosswind];
  const crosswindAngle = crosswindInfo
    ? Math.abs(((windDir - crosswindInfo.heading + 180 + 360) % 360) - 180)
    : 180;
  const addCrosswind = avail.includes(crosswind) && crosswindAngle < 60;

  return {
    arr: [usePrimary],
    dep: addCrosswind ? [usePrimary, crosswind] : [usePrimary],
  };
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

        {/* Runways — multi-select toggles */}
        {(() => {
          const avail = availableRunways(wxConditions.weather);
          const flowCfg = defaultRunwayConfig(wxConditions.weather);
          const flowLabel = flowCfg.arr[0] === '34' ? 'NORTH FLOW' : 'SOUTH FLOW';

          const RunwayButtons = ({
            selected, onToggle,
          }: { selected: string[]; onToggle: (r: string) => void }) => (
            <div style={buttonGroupStyle}>
              {KRIC_RUNWAYS.map((r) => {
                const info = KRIC_RUNWAY_INFO[r];
                const cap = approachCapability(r, wxConditions.weather);
                const isAvail = cap !== null;
                const isActive = selected.includes(r);
                const capColor = cap === 'ILS' ? STARSColors.normal : cap === 'RNAV' ? STARSColors.caution : STARSColors.dimText;
                return (
                  <button
                    key={r}
                    style={optionButtonStyle(isActive, !isAvail)}
                    onClick={() => isAvail && onToggle(r)}
                    title={isAvail ? `RWY ${r} — ${info.lengthFt.toLocaleString()} ft — ${cap} (click to toggle)` : `RWY ${r} — below minimums`}
                  >
                    <div style={{ fontSize: 12, lineHeight: '1.2' }}>{r}</div>
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
              <div style={{ ...fieldGroupStyle, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={labelStyle}>ARRIVAL RUNWAYS</span>
                  <span style={{ fontSize: 9, color: STARSColors.dimText, letterSpacing: 1 }}>{flowLabel}</span>
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
