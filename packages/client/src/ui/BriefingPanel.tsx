import React, { useCallback } from 'react';
import { useGameStore } from '../state/GameStore';
import { getGameClient } from '../network/GameClient';
import type { SessionConfig, AirportData, WeatherState } from '@atc-sim/shared';
import { wxCategoryColor } from './weatherGen';
import type { WxCategory } from './weatherGen';

const C = {
  bg: '#000000',
  panelBg: '#0a0f0a',
  border: '#2a4a2a',
  headerBg: '#0d1f0d',
  sectionBg: '#060d06',
  green: '#00cc44',
  amber: '#ffbb00',
  white: '#e8e8e8',
  cyan: '#00cccc',
  red: '#ff4444',
  gray: '#666',
  mutedGreen: '#339944',
  dimWhite: '#aaaaaa',
};

const panel: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: C.bg,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: '"Courier New", Courier, monospace',
  zIndex: 1000,
};

const card: React.CSSProperties = {
  background: C.panelBg,
  border: `1px solid ${C.border}`,
  width: 760,
  maxHeight: '92vh',
  overflowY: 'auto',
  scrollbarWidth: 'thin',
  scrollbarColor: `${C.border} ${C.bg}`,
};

const header: React.CSSProperties = {
  background: C.headerBg,
  borderBottom: `1px solid ${C.border}`,
  padding: '12px 20px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
};

const section: React.CSSProperties = {
  borderBottom: `1px solid ${C.border}`,
  padding: '10px 20px',
};

const sectionTitle: React.CSSProperties = {
  color: C.amber,
  fontSize: 11,
  fontWeight: 'bold',
  letterSpacing: 2,
  marginBottom: 8,
  textTransform: 'uppercase' as const,
};

const row: React.CSSProperties = {
  display: 'flex',
  gap: 24,
  flexWrap: 'wrap' as const,
  marginBottom: 4,
};

const kv = (label: string, value: React.ReactNode, color = C.white): React.ReactNode => (
  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
    <span style={{ color: C.gray, fontSize: 11 }}>{label}</span>
    <span style={{ color, fontSize: 13 }}>{value}</span>
  </span>
);

const bullet = (text: React.ReactNode, color = C.dimWhite): React.ReactNode => (
  <div style={{ color, fontSize: 12, paddingLeft: 16, lineHeight: '1.7' }}>
    <span style={{ color: C.mutedGreen, marginRight: 8 }}>›</span>
    {text}
  </div>
);

const cmd = (text: string): React.ReactNode => (
  <span style={{ color: C.cyan, background: '#001a1a', padding: '1px 5px', borderRadius: 2, fontSize: 11 }}>
    {text}
  </span>
);

function describeStarOrigin(starName: string): string {
  const origins: Record<string, string> = {
    DUCXS5: 'from the southwest via DUCXS',
    POWTN5: 'from the west via POWTN / LYH',
    SPIDR5: 'from the northwest via SPIDR / MOL',
  };
  return origins[starName] ?? starName;
}

function describeStarAltitude(starName: string, airport: AirportData): string {
  const star = airport.stars.find(s => s.name === starName);
  if (!star) return '';
  for (const leg of star.commonLegs) {
    const r = leg.altitudeConstraint;
    if (r && leg.fix?.id) {
      if (r.type === 'at') return `cross ${leg.fix.id} at ${r.altitude.toLocaleString()} ft`;
      if (r.type === 'atOrBelow') return `cross ${leg.fix.id} at or below ${r.altitude.toLocaleString()} ft`;
      if (r.type === 'atOrAbove') return `cross ${leg.fix.id} at or above ${r.altitude.toLocaleString()} ft`;
      if (r.type === 'between') return `cross ${leg.fix.id} between ${r.min.toLocaleString()}-${r.max.toLocaleString()} ft`;
    }
  }
  return '';
}

function describeSidDestination(sidName: string): string {
  const dests: Record<string, string> = {
    COLIN8: 'northeast (COLIN) → ZDC/Dulles area',
    KALLI7: 'southwest (KALLI/READE) → Atlanta/Charlotte',
    LUCYL6: 'northeast (LUCYL/KAMMI) → Boston/New York',
    READE7: 'southwest (READE/SANNY) → Charlotte/Atlanta',
  };
  return dests[sidName] ?? sidName;
}

function wxCategory(wx: WeatherState): WxCategory {
  const vis = wx.visibility;
  const ceil = wx.ceiling;
  if ((ceil !== null && ceil < 500) || vis < 1) return 'LIFR';
  if ((ceil !== null && ceil < 1000) || vis < 3) return 'IFR';
  if ((ceil !== null && ceil < 3000) || vis < 5) return 'MVMC';
  return 'VMC';
}

function approachSuggestion(cat: WxCategory, runway: string, airport: AirportData): React.ReactNode {
  const rwy = airport.runways.find(r => r.id === runway);
  const hasIls = rwy?.ilsAvailable ?? false;

  switch (cat) {
    case 'VMC':
      return (
        <span>
          <span style={{ color: '#00cc44' }}>VMC conditions</span>
          {' — visual approaches available. ILS also available at your discretion.'}
          {' Visual workflow: '}<span style={{ color: '#00cccc' }}>rfs</span>{' (report field in sight), then '}<span style={{ color: '#00cccc' }}>cv{runway}</span>{' once pilot reports field in sight.'}
          {' To sequence behind traffic: '}<span style={{ color: '#00cccc' }}>rts [callsign]</span>{', then '}<span style={{ color: '#00cccc' }}>cv{runway}</span>{'.'}
        </span>
      );
    case 'MVMC':
      return (
        <span>
          <span style={{ color: '#ffbb00' }}>Marginal VMC</span>
          {' — visual approaches are legal but ILS preferred.'}
          {' Ceiling and visibility near minimums — use ILS for positive identification.'}
        </span>
      );
    case 'IFR':
      return (
        <span>
          <span style={{ color: '#ff6633' }}>IFR conditions</span>
          {' — visual approaches NOT authorized.'}
          {hasIls
            ? <span> ILS approaches required. Use <span style={{ color: '#00cccc' }}>ci{runway}</span>.</span>
            : <span> RNAV approaches required. Use <span style={{ color: '#00cccc' }}>cr{runway}</span>.</span>
          }
        </span>
      );
    case 'LIFR':
      return (
        <span>
          <span style={{ color: '#ff2222' }}>Low IFR</span>
          {' — visual approaches NOT authorized.'}
          {hasIls
            ? <span> ILS approaches only. Use <span style={{ color: '#00cccc' }}>ci{runway}</span>. Monitor approach minimums.</span>
            : <span> RNAV approaches only. Use <span style={{ color: '#00cccc' }}>cr{runway}</span>. Monitor approach minimums.</span>
          }
        </span>
      );
  }
}

function windStr(weather: WeatherState): string {
  const w = weather.winds[0];
  if (!w) return 'CALM';
  const dir = String(w.direction).padStart(3, '0');
  const spd = w.speed === 0 ? 'CALM' : `${dir}° at ${w.speed} kt`;
  return w.gusts ? `${spd}, gusts ${w.gusts} kt` : spd;
}

function ceilingStr(weather: WeatherState): string {
  if (weather.ceiling === null) return 'CLR';
  return `${weather.ceiling} ft AGL`;
}

function runwayApproachType(runwayId: string, airport: AirportData): string {
  const rwy = airport.runways.find(r => r.id === runwayId);
  if (!rwy) return runwayId;
  if (rwy.ilsAvailable) return `ILS (course ${rwy.ilsCourse ?? rwy.heading}°)`;
  return 'Visual/RNAV';
}

export const BriefingPanel: React.FC = () => {
  const session = useGameStore(s => s.session);
  const airportData = useGameStore(s => s.airportData);
  const weather = useGameStore(s => s.weather);

  const handleBegin = useCallback(() => {
    getGameClient().sessionControl('start');
  }, []);

  if (!session || !airportData) {
    return (
      <div style={panel}>
        <div style={{ color: C.green, fontFamily: '"Courier New"', fontSize: 14 }}>
          LOADING BRIEFING DATA...
        </div>
      </div>
    );
  }

  const cfg: SessionConfig = session.config;
  const wx = weather ?? cfg.weather;
  const cat = wxCategory(wx);
  const arrRwys = cfg.runwayConfig.arrivalRunways;
  const depRwys = cfg.runwayConfig.departureRunways;
  const scenType = cfg.scenarioType;
  const hasArrivals = scenType === 'arrivals' || scenType === 'mixed';
  const hasDepartures = scenType === 'departures' || scenType === 'mixed';

  // Active STARs and SIDs (all of them — airport-specific)
  const activeStars = airportData.stars.map(s => s.name);
  const activeSids = airportData.sids.map(s => s.name);

  // Airport frequencies
  const freqs = airportData.frequencies;
  const towerFreq = freqs.tower[0]?.toFixed(1);
  const centerFreqs = freqs.center.map(f => f.toFixed(2)).join(', ');
  const atisFreq = freqs.atis.toFixed(2);
  const approachFreqs = freqs.approach.map(f => f.toFixed(2)).join(', ');

  const densityLabel = cfg.density.charAt(0).toUpperCase() + cfg.density.slice(1);
  const scenLabel = scenType.charAt(0).toUpperCase() + scenType.slice(1);

  return (
    <div style={panel}>
      <div style={card}>

        {/* ── HEADER ── */}
        <div style={header}>
          <div>
            <div style={{ color: C.green, fontSize: 16, fontWeight: 'bold', letterSpacing: 1 }}>
              {airportData.name.toUpperCase()} TRACON — SECTOR BRIEFING
            </div>
            <div style={{ color: C.gray, fontSize: 11, marginTop: 2 }}>
              {airportData.icao} · Potomac TRACON — James River Sector
            </div>
          </div>
          <div style={{ textAlign: 'right' as const }}>
            <div style={{ color: C.amber, fontSize: 12 }}>{scenLabel} · {densityLabel} Traffic</div>
            <div style={{ color: C.gray, fontSize: 11, marginTop: 2 }}>ATIS: Information {atisInfoLetter(session.config)}</div>
          </div>
        </div>

        {/* ── METEOROLOGY ── */}
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={sectionTitle}>Meteorological Conditions</div>
            <span style={{
              color: wxCategoryColor(cat),
              fontSize: 12,
              fontWeight: 'bold',
              letterSpacing: 2,
              border: `1px solid ${wxCategoryColor(cat)}`,
              padding: '1px 7px',
            }}>
              {cat}
            </span>
          </div>
          <div style={row}>
            {kv('WIND', windStr(wx), wx.winds[0]?.speed === 0 ? C.dimWhite : C.white)}
            {kv('VIS', `${wx.visibility} SM`)}
            {kv('CEILING', ceilingStr(wx))}
            {kv('ALTIMETER', wx.altimeter.toFixed(2))}
          </div>
        </div>

        {/* ── ACTIVE RUNWAYS ── */}
        <div style={section}>
          <div style={sectionTitle}>Active Runway Configuration</div>
          {hasArrivals && (
            <div style={row}>
              {kv('ARRIVAL', arrRwys.map(r => (
                <span key={r}>RWY {r} — {runwayApproachType(r, airportData)}</span>
              )), C.cyan)}
            </div>
          )}
          {hasDepartures && (
            <div style={row}>
              {kv('DEPARTURE', depRwys.map(r => <span key={r}>RWY {r}</span>), C.green)}
            </div>
          )}
        </div>

        {/* ── AIRSPACE ── */}
        <div style={section}>
          <div style={sectionTitle}>Controlled Airspace</div>
          {airportData.tracon ? (
            <div style={row}>
              {kv('SECTOR', airportData.tracon.name, C.cyan)}
            </div>
          ) : null}
          <div style={row}>
            {kv('VERTICAL LIMITS',
              airportData.tracon
                ? `SFC – FL${Math.floor(airportData.tracon.ceiling / 100)}`
                : 'SFC – FL170',
              C.white
            )}
            {kv('LATERAL',
              airportData.tracon
                ? `${airportData.tracon.lateralRadiusNm} nm radius`
                : '40 nm radius',
              C.white
            )}
            {kv('MAX ASSIGNABLE ALT',
              airportData.tracon
                ? `FL${Math.floor(airportData.tracon.ceiling / 100)}`
                : 'FL170',
              C.amber
            )}
          </div>
          <div style={{ color: C.dimWhite, fontSize: 11, marginTop: 4 }}>
            Aircraft may not be climbed above FL{airportData.tracon ? Math.floor(airportData.tracon.ceiling / 100) : 170}.
            {' '}Hand off to Center before aircraft reach the ceiling.
          </div>
        </div>

        {/* ── ARRIVALS ── */}
        {hasArrivals && (
          <div style={section}>
            <div style={sectionTitle}>Arrivals — Your Responsibilities</div>

            <div style={{ color: C.dimWhite, fontSize: 11, marginBottom: 8 }}>
              You receive arrivals from Washington Center below{' '}
              {airportData.tracon ? `${airportData.tracon.ceiling.toLocaleString()} ft` : '17,000 ft'}.
              {' '}Sequence them for{' '}
              {arrRwys.map(r => `Runway ${r}`).join(' / ')}.
            </div>

            <div style={{ marginBottom: 8, fontSize: 12, lineHeight: '1.5' }}>
              {approachSuggestion(cat, arrRwys[0] ?? '16', airportData)}
            </div>

            {activeStars.length > 0 && (
              <>
                <div style={{ color: C.amber, fontSize: 11, marginBottom: 4 }}>Active STARs:</div>
                {activeStars.map(name => {
                  const altNote = describeStarAltitude(name, airportData);
                  return (
                    <div key={name} style={{ marginBottom: 2 }}>
                      {bullet(
                        <span>
                          <span style={{ color: C.white, fontWeight: 'bold' }}>{name}</span>
                          {' — '}
                          <span>{describeStarOrigin(name)}</span>
                          {altNote && <span style={{ color: C.amber }}>{'. Published restriction: '}{altNote}</span>}
                        </span>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            <div style={{ marginTop: 10 }}>
              <div style={{ color: C.amber, fontSize: 11, marginBottom: 4 }}>Inbound Handoff — Required Before Check-in:</div>
              {bullet(
                <span>
                  Arrivals appear <span style={{ color: '#ffaa00', fontWeight: 'bold' }}>amber blinking</span> with a{' '}
                  <span style={{ color: '#ffaa00' }}>^</span> suffix — Washington Center is offering the handoff to you.
                </span>
              )}
              {bullet(
                <span>
                  <span style={{ color: C.white }}>Click</span> the amber data block to accept.
                  The aircraft will check in on your frequency 3–5 seconds later.
                  <span style={{ color: C.red }}> Ignoring an offer for &gt;90 s: −30 pts penalty.</span>
                </span>
              )}
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ color: C.amber, fontSize: 11, marginBottom: 4 }}>Sequencing Workflow:</div>
              {bullet(<span>After check-in, <span style={{ color: C.white }}>step them down</span> as needed: {cmd('AAL101 dm 8000')}</span>)}
              {bullet(<span>Issue <span style={{ color: C.white }}>vectors to final</span>: {cmd('AAL101 tl200')} then {cmd('AAL101 tl160 dm3000 ci16')}</span>)}
              {bullet(
                <span>
                  Hand off to <span style={{ color: C.white }}>Tower ({towerFreq})</span> by 2,500 ft / inside 8 nm on final:{' '}
                  {cmd(`AAL101 ho ${towerFreq ?? '121.1'}`)}.{' '}
                  <span style={{ color: C.red }}>Late (&lt;3 nm): −50 pts. Missed (lands without HO): −100 pts.</span>
                </span>
              )}
              {bullet(<span>Maintain <span style={{ color: C.white }}>3 nm / 1,000 ft separation</span> between all aircraft at all times.</span>)}
            </div>
          </div>
        )}

        {/* ── DEPARTURES ── */}
        {hasDepartures && (
          <div style={section}>
            <div style={sectionTitle}>Departures — Your Responsibilities</div>

            <div style={{ color: C.dimWhite, fontSize: 11, marginBottom: 8 }}>
              Tower hands off departures from Runway {depRwys.join('/')} climbing through ~2,000 ft.
              Your job: climb them to their filed altitude and hand off to Washington Center.
            </div>

            {activeSids.length > 0 && (
              <>
                <div style={{ color: C.amber, fontSize: 11, marginBottom: 4 }}>Active SIDs:</div>
                {activeSids.map(name => (
                  <div key={name} style={{ marginBottom: 2 }}>
                    {bullet(
                      <span>
                        <span style={{ color: C.white, fontWeight: 'bold' }}>{name}</span>
                        {' — '}
                        {describeSidDestination(name)}
                      </span>
                    )}
                  </div>
                ))}
              </>
            )}

            <div style={{ marginTop: 10 }}>
              <div style={{ color: C.amber, fontSize: 11, marginBottom: 4 }}>Workflow:</div>
              {bullet(<span>Accept check-in from Tower. Issue climb clearance: {cmd('DAL202 cm 18000')}</span>)}
              {bullet(<span>Check their <span style={{ color: C.white }}>flight strip</span> for filed cruise altitude and SID.</span>)}
              {bullet(
                <span>
                  <span style={{ color: C.white }}>Step 1 — Radar handoff:</span>{' '}
                  Before issuing radio handoff, offer a radar handoff to Center:{' '}
                  {cmd('UAL123 .ho ctr')}.
                  Aircraft turns <span style={{ color: '#ffaa00' }}>amber+*</span>.
                  Center accepts in 3–5 s — aircraft turns <span style={{ color: '#00ff88' }}>green+J</span>.
                </span>
              )}
              {bullet(
                <span>
                  <span style={{ color: C.white }}>Step 2 — Radio handoff</span>{' '}
                  (only after green): {cmd(`UAL123 ho ${freqs.center[0]?.toFixed(2) ?? '128.55'}`)}.{' '}
                  <span style={{ color: C.amber }}>Cannot climb above FL{airportData.tracon ? Math.floor(airportData.tracon.ceiling / 100) : 170}.</span>{' '}
                  <span style={{ color: C.red }}>Late (FL160 no radar HO): −50 pts. Missed (&gt;40 nm no HO): −100 pts.</span>
                </span>
              )}
              {bullet(<span>Maintain <span style={{ color: C.white }}>3 nm / 1,000 ft separation</span> from arrivals and other departures.</span>)}
            </div>
          </div>
        )}

        {/* ── FREQUENCIES ── */}
        <div style={section}>
          <div style={sectionTitle}>Facility Frequencies</div>
          <div style={row}>
            {kv('TOWER', towerFreq ?? '—', C.white)}
            {kv('GROUND', freqs.ground[0]?.toFixed(1) ?? '—')}
            {kv('APPROACH', approachFreqs)}
            {kv('CENTER', centerFreqs, C.white)}
            {kv('ATIS', atisFreq)}
          </div>
        </div>

        {/* ── QUICK REFERENCE ── */}
        <div style={section}>
          <div style={sectionTitle}>Command Quick Reference</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 24px' }}>
            {[
              ['Descend/maintain 8,000', 'AAL101 dm 8000'],
              ['Climb to FL180', 'UAL123 cm 18000'],
              ['Turn left hdg 180', 'AAL101 tl 180'],
              ['Turn right hdg 270', 'DAL202 tr 270'],
              ['Speed 180 kt', 'AAL101 s 180'],
              ['Direct to fix', 'AAL101 pd DUCXS'],
              ['Cleared ILS RWY 16', 'AAL101 ci16'],
              ['Turn+descend+ILS (any order)', 'AAL101 tl160 dm3000 ci16'],
              ['Accept inbound handoff', 'Click amber ^ target'],
              ['Offer radar HO to Center', 'UAL123 .ho ctr'],
              ['Radio HO to Tower', `AAL101 ho ${towerFreq ?? '121.1'}`],
              ['Radio HO to Center (after green)', `UAL123 ho ${freqs.center[0]?.toFixed(2) ?? '128.55'}`],
            ].map(([desc, example]) => (
              <div key={desc} style={{ fontSize: 11, lineHeight: '1.9', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ color: C.gray, minWidth: 170 }}>{desc}</span>
                {cmd(example)}
              </div>
            ))}
          </div>
        </div>

        {/* ── BEGIN BUTTON ── */}
        <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={handleBegin}
            style={{
              background: '#0d2b0d',
              border: `1px solid ${C.green}`,
              color: C.green,
              fontFamily: '"Courier New", Courier, monospace',
              fontSize: 14,
              fontWeight: 'bold',
              letterSpacing: 3,
              padding: '10px 48px',
              cursor: 'pointer',
              textTransform: 'uppercase' as const,
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { (e.target as HTMLButtonElement).style.background = '#1a4a1a'; }}
            onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = '#0d2b0d'; }}
          >
            ACKNOWLEDGE & BEGIN
          </button>
        </div>

      </div>
    </div>
  );
};

function atisInfoLetter(config: SessionConfig): string {
  const PHONETIC: Record<string, string> = {
    A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo',
    F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliet',
    K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar',
    P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango',
  };
  const letter = config.weather?.atisLetter ?? 'A';
  return PHONETIC[letter.toUpperCase()] ?? 'Alpha';
}
