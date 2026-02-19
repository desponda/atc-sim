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
  width: 680,
};

const header: React.CSSProperties = {
  background: C.headerBg,
  borderBottom: `1px solid ${C.border}`,
  padding: '10px 18px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
};

const section: React.CSSProperties = {
  borderBottom: `1px solid ${C.border}`,
  padding: '8px 18px',
};

const sectionTitle: React.CSSProperties = {
  color: C.amber,
  fontSize: 10,
  fontWeight: 'bold',
  letterSpacing: 2,
  marginBottom: 5,
  textTransform: 'uppercase' as const,
};

const row: React.CSSProperties = {
  display: 'flex',
  gap: 20,
  flexWrap: 'wrap' as const,
};

const kv = (label: string, value: React.ReactNode, color = C.white): React.ReactNode => (
  <span style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline' }}>
    <span style={{ color: C.gray, fontSize: 10 }}>{label}</span>
    <span style={{ color, fontSize: 12 }}>{value}</span>
  </span>
);

const cmd = (text: string): React.ReactNode => (
  <span style={{ color: C.cyan, background: '#001a1a', padding: '1px 5px', borderRadius: 2, fontSize: 11 }}>
    {text}
  </span>
);

function wxCategory(wx: WeatherState): WxCategory {
  const vis = wx.visibility;
  const ceil = wx.ceiling;
  if ((ceil !== null && ceil < 500) || vis < 1) return 'LIFR';
  if ((ceil !== null && ceil < 1000) || vis < 3) return 'IFR';
  if ((ceil !== null && ceil < 3000) || vis < 5) return 'MVMC';
  return 'VMC';
}

function windStr(weather: WeatherState): string {
  const w = weather.winds[0];
  if (!w || w.speed === 0) return 'CALM';
  const dir = String(w.direction).padStart(3, '0');
  const spd = `${dir}° at ${w.speed} kt`;
  return w.gusts ? `${spd}, gusts ${w.gusts} kt` : spd;
}

function ceilingStr(weather: WeatherState): string {
  if (weather.ceiling === null) return 'CLR';
  return `${weather.ceiling} ft AGL`;
}

function runwayApproachType(runwayId: string, airport: AirportData): string {
  const rwy = airport.runways.find(r => r.id === runwayId);
  if (!rwy) return runwayId;
  if (rwy.ilsAvailable) return `ILS ${rwy.ilsCourse ?? rwy.heading}°`;
  return 'Visual/RNAV';
}

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

function openFullBriefing(
  session: ReturnType<typeof useGameStore>['session'],
  airportData: AirportData,
  weather: WeatherState,
  towerFreq: string,
  centerFreq: string,
): void {
  if (!session) return;
  const cfg = session.config;
  const arrRwys = cfg.runwayConfig.arrivalRunways;
  const depRwys = cfg.runwayConfig.departureRunways;
  const freqs = airportData.frequencies;

  const html = `<!DOCTYPE html>
<html>
<head>
<title>${airportData.icao} TRACON Sector Briefing</title>
<style>
  body { background:#000; color:#ccc; font-family:"Courier New",monospace; padding:24px; max-width:760px; margin:0 auto; font-size:13px; line-height:1.6; }
  h1 { color:#00cc44; font-size:18px; margin:0 0 2px; letter-spacing:1px; }
  h2 { color:#ffbb00; font-size:12px; letter-spacing:2px; text-transform:uppercase; border-bottom:1px solid #2a4a2a; padding-bottom:4px; margin:18px 0 8px; }
  .sub { color:#666; font-size:11px; }
  .row { display:flex; gap:20px; flex-wrap:wrap; margin-bottom:6px; }
  .kv { display:inline-flex; gap:6px; }
  .kv-label { color:#555; font-size:11px; }
  .kv-val { color:#e8e8e8; font-size:12px; }
  .cyan { color:#00cccc; background:#001a1a; padding:1px 5px; border-radius:2px; font-size:11px; }
  .amber { color:#ffbb00; }
  .red { color:#ff4444; }
  .green { color:#00cc44; }
  .dim { color:#aaa; font-size:11px; }
  .bullet { padding-left:16px; }
  .bullet::before { content:"› "; color:#339944; }
  table { border-collapse:collapse; width:100%; }
  td { padding:2px 8px 2px 0; font-size:11px; vertical-align:top; }
  td:first-child { color:#555; min-width:160px; }
  td:last-child { color:#00cccc; background:#001a1a; padding:1px 5px; border-radius:2px; white-space:nowrap; }
</style>
</head>
<body>
<h1>${airportData.name.toUpperCase()} TRACON — SECTOR BRIEFING</h1>
<div class="sub">${airportData.icao} · Potomac TRACON — James River Sector · ${cfg.scenarioType.charAt(0).toUpperCase() + cfg.scenarioType.slice(1)} · ${cfg.density.charAt(0).toUpperCase() + cfg.density.slice(1)} Traffic</div>

<h2>Meteorological Conditions</h2>
<div class="row">
  <span class="kv"><span class="kv-label">WIND</span><span class="kv-val">${windStr(weather)}</span></span>
  <span class="kv"><span class="kv-label">VIS</span><span class="kv-val">${weather.visibility} SM</span></span>
  <span class="kv"><span class="kv-label">CEILING</span><span class="kv-val">${ceilingStr(weather)}</span></span>
  <span class="kv"><span class="kv-label">ALTIMETER</span><span class="kv-val">${weather.altimeter.toFixed(2)}</span></span>
</div>

<h2>Active Runway Configuration</h2>
<div class="row">
  ${arrRwys.length > 0 ? `<span class="kv"><span class="kv-label">ARRIVAL</span><span style="color:#00cccc">${arrRwys.map(r => `RWY ${r} — ${runwayApproachType(r, airportData)}`).join(', ')}</span></span>` : ''}
  ${depRwys.length > 0 ? `<span class="kv"><span class="kv-label">DEPARTURE</span><span class="green">${depRwys.map(r => `RWY ${r}`).join(', ')}</span></span>` : ''}
</div>

<h2>Frequencies</h2>
<div class="row">
  <span class="kv"><span class="kv-label">TOWER</span><span class="kv-val">${freqs.tower[0]?.toFixed(1) ?? '—'}</span></span>
  <span class="kv"><span class="kv-label">APPROACH</span><span class="kv-val">${freqs.approach.map(f => f.toFixed(2)).join(', ')}</span></span>
  <span class="kv"><span class="kv-label">CENTER</span><span class="kv-val">${freqs.center.map(f => f.toFixed(2)).join(', ')}</span></span>
  <span class="kv"><span class="kv-label">ATIS</span><span class="kv-val">${freqs.atis.toFixed(2)}</span></span>
</div>

${airportData.stars.length > 0 ? `
<h2>Active STARs</h2>
${airportData.stars.map(s => `<div class="bullet"><strong style="color:#e8e8e8">${s.name}</strong></div>`).join('')}
` : ''}

${airportData.sids.length > 0 ? `
<h2>Active SIDs</h2>
${airportData.sids.map(s => `<div class="bullet"><strong style="color:#e8e8e8">${s.name}</strong></div>`).join('')}
` : ''}

<h2>Arrivals — Responsibilities</h2>
<div class="dim" style="margin-bottom:8px">Receive arrivals from Washington Center, sequence for ${arrRwys.map(r => 'Runway ' + r).join(' / ')}.</div>
<div class="bullet">Arrivals appear <span class="amber">amber blinking with ^ suffix</span> — click to accept inbound handoff from Center.</div>
<div class="bullet">After check-in, step them down as needed: <span class="cyan">AAL101 dm 8000</span></div>
<div class="bullet">Vector to final: <span class="cyan">AAL101 tl200</span> then <span class="cyan">AAL101 tl160 dm3000 ci16</span></div>
<div class="bullet">Hand off to Tower (${towerFreq}) before 2,500 ft / inside 8 nm on final: <span class="cyan">AAL101 ho ${towerFreq}</span></div>
<div class="bullet">Maintain <strong>3 nm / 1,000 ft separation</strong> between all aircraft at all times.</div>

<h2>Departures — Responsibilities</h2>
<div class="dim" style="margin-bottom:8px">Tower hands off departures climbing through ~2,000 ft. Climb them to their filed altitude and hand off to Center.</div>
<div class="bullet">Accept check-in, issue climb: <span class="cyan">DAL202 cm 18000</span></div>
<div class="bullet">Offer radar handoff to Center: <span class="cyan">UAL123 .ho ctr</span> — wait for green, then: <span class="cyan">UAL123 ho ${centerFreq}</span></div>
<div class="bullet">Cannot climb aircraft above FL${airportData.tracon ? Math.floor(airportData.tracon.ceiling / 100) : 170}.</div>

<h2>Full Command Reference</h2>
<table>
  <tr><td>Descend to altitude</td><td><span class="cyan">AAL101 dm 8000</span></td></tr>
  <tr><td>Climb to altitude</td><td><span class="cyan">UAL123 cm 18000</span></td></tr>
  <tr><td>Turn left / right</td><td><span class="cyan">AAL101 tl 180</span> / <span class="cyan">AAL101 tr 270</span></td></tr>
  <tr><td>Speed restriction</td><td><span class="cyan">AAL101 s 180</span></td></tr>
  <tr><td>Direct to fix</td><td><span class="cyan">AAL101 pd DUCXS</span></td></tr>
  <tr><td>Cleared ILS approach</td><td><span class="cyan">AAL101 ci16</span></td></tr>
  <tr><td>Cleared visual approach</td><td><span class="cyan">AAL101 cv16</span></td></tr>
  <tr><td>Cleared RNAV approach</td><td><span class="cyan">AAL101 cr16</span></td></tr>
  <tr><td>Report field in sight</td><td><span class="cyan">AAL101 rfs</span></td></tr>
  <tr><td>Radar HO to Center</td><td><span class="cyan">UAL123 .ho ctr</span></td></tr>
  <tr><td>Radio HO to Tower</td><td><span class="cyan">AAL101 ho ${towerFreq}</span></td></tr>
  <tr><td>Radio HO to Center</td><td><span class="cyan">UAL123 ho ${centerFreq}</span></td></tr>
  <tr><td>Hold at fix</td><td><span class="cyan">AAL101 hold CAGER</span></td></tr>
  <tr><td>Combo (turn+descend+ILS)</td><td><span class="cyan">AAL101 tl160 dm3000 ci16</span></td></tr>
</table>

<p class="dim" style="margin-top:20px">Press <strong style="color:#e8e8e8">?</strong> in the simulator for a quick command reference overlay.</p>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
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
  const freqs = airportData.frequencies;
  const towerFreq = freqs.tower[0]?.toFixed(1) ?? '121.1';
  const centerFreq = freqs.center[0]?.toFixed(2) ?? '128.55';
  const atisFreq = freqs.atis.toFixed(2);
  const densityLabel = cfg.density.charAt(0).toUpperCase() + cfg.density.slice(1);
  const scenLabel = scenType.charAt(0).toUpperCase() + scenType.slice(1);

  const handleFullBriefing = () => openFullBriefing(session, airportData, wx, towerFreq, centerFreq);

  return (
    <div style={panel}>
      <div style={card}>

        {/* ── HEADER ── */}
        <div style={header}>
          <div>
            <div style={{ color: C.green, fontSize: 15, fontWeight: 'bold', letterSpacing: 1 }}>
              {airportData.name.toUpperCase()} TRACON
            </div>
            <div style={{ color: C.gray, fontSize: 10, marginTop: 1 }}>
              {airportData.icao} · ATIS Information {atisInfoLetter(cfg)}
            </div>
          </div>
          <div style={{ textAlign: 'right' as const }}>
            <div style={{ color: C.amber, fontSize: 11 }}>{scenLabel} · {densityLabel} Traffic</div>
          </div>
        </div>

        {/* ── WEATHER ── */}
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={row}>
              {kv('WIND', windStr(wx))}
              {kv('VIS', `${wx.visibility} SM`)}
              {kv('CEILING', ceilingStr(wx))}
              {kv('ALTIMETER', wx.altimeter.toFixed(2))}
            </div>
            <span style={{
              color: wxCategoryColor(cat),
              fontSize: 11,
              fontWeight: 'bold',
              letterSpacing: 2,
              border: `1px solid ${wxCategoryColor(cat)}`,
              padding: '1px 6px',
              marginLeft: 12,
              whiteSpace: 'nowrap' as const,
            }}>
              {cat}
            </span>
          </div>
        </div>

        {/* ── RUNWAYS + STARs/SIDs ── */}
        <div style={section}>
          <div style={row}>
            {hasArrivals && arrRwys.length > 0 && kv('ARR', arrRwys.map(r => (
              <span key={r} style={{ marginRight: 8 }}>RWY {r} — {runwayApproachType(r, airportData)}</span>
            )), C.cyan)}
            {hasDepartures && depRwys.length > 0 && kv('DEP', depRwys.map(r => (
              <span key={r} style={{ marginRight: 8 }}>RWY {r}</span>
            )), C.green)}
          </div>
          <div style={{ ...row, marginTop: 4 }}>
            {airportData.stars.length > 0 && kv('STARs', airportData.stars.map(s => s.name).join(', '))}
            {airportData.sids.length > 0 && kv('SIDs', airportData.sids.map(s => s.name).join(', '))}
          </div>
        </div>

        {/* ── FREQUENCIES ── */}
        <div style={section}>
          <div style={row}>
            {kv('TOWER', towerFreq, C.white)}
            {kv('APPROACH', freqs.approach.map(f => f.toFixed(2)).join(', '))}
            {kv('CENTER', freqs.center.map(f => f.toFixed(2)).join(', '), C.white)}
            {kv('ATIS', atisFreq)}
          </div>
        </div>

        {/* ── HANDOFF TIP ── */}
        {hasArrivals && (
          <div style={{ ...section, background: '#0a1a0a' }}>
            <div style={sectionTitle}>Inbound Handoffs</div>
            <div style={{ fontSize: 11, color: C.amber, marginBottom: 3 }}>
              Arrivals from Center appear with an <span style={{ color: C.amber, fontWeight: 'bold' }}>amber blinking ▲</span> — click the target to accept the handoff.
            </div>
            <div style={{ fontSize: 10, color: C.dimWhite }}>
              After acceptance the aircraft checks in on your frequency and the data tag turns white. Issue descent and sequencing from there.
            </div>
          </div>
        )}

        {/* ── QUICK COMMANDS ── */}
        <div style={section}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px 24px' }}>
            {[
              ['Descend/maintain', 'AAL101 dm 8000'],
              ['Climb to altitude', 'UAL123 cm 18000'],
              ['Turn left / right', 'AAL101 tl 200'],
              hasArrivals && ['Cleared ILS approach', `AAL101 ci${arrRwys[0] ?? '16'}`],
              hasDepartures && ['Radar HO → Center', 'UAL123 .ho ctr'],
              ['Radio HO → Tower', `AAL101 ho ${towerFreq}`],
            ].filter(Boolean).map((pair) => {
              const [desc, example] = pair as [string, string];
              return (
                <div key={desc} style={{ fontSize: 10, lineHeight: '1.9', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ color: C.gray, minWidth: 140 }}>{desc}</span>
                  {cmd(example)}
                </div>
              );
            })}
          </div>
          <div style={{ color: C.gray, fontSize: 10, marginTop: 4 }}>
            Press <span style={{ color: C.white }}>?</span> during the session for the full command reference.
          </div>
        </div>

        {/* ── BUTTONS ── */}
        <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            onClick={handleFullBriefing}
            style={{
              background: 'transparent',
              border: `1px solid ${C.border}`,
              color: C.dimWhite,
              fontFamily: '"Courier New", Courier, monospace',
              fontSize: 11,
              padding: '6px 14px',
              cursor: 'pointer',
              letterSpacing: 1,
            }}
            onMouseEnter={e => { (e.target as HTMLButtonElement).style.color = C.white; }}
            onMouseLeave={e => { (e.target as HTMLButtonElement).style.color = C.dimWhite; }}
          >
            FULL BRIEFING ↗
          </button>
          <button
            onClick={handleBegin}
            style={{
              background: '#0d2b0d',
              border: `1px solid ${C.green}`,
              color: C.green,
              fontFamily: '"Courier New", Courier, monospace',
              fontSize: 13,
              fontWeight: 'bold',
              letterSpacing: 3,
              padding: '8px 36px',
              cursor: 'pointer',
              textTransform: 'uppercase' as const,
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { (e.target as HTMLButtonElement).style.background = '#1a4a1a'; }}
            onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = '#0d2b0d'; }}
          >
            ACKNOWLEDGE &amp; BEGIN
          </button>
        </div>

      </div>
    </div>
  );
};
