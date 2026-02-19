import React, { useCallback, useState } from 'react';
import { useGameStore } from '../state/GameStore';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 24,
  left: 0,
  bottom: 32,
  width: 200,
  background: STARSColors.panelBg,
  borderRight: `1px solid ${STARSColors.panelBorder}`,
  boxShadow: 'inset -1px 0 2px rgba(0,221,0,0.1)',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: STARSFonts.family,
  fontSize: STARSFonts.panel,
  color: STARSColors.normal,
  overflow: 'hidden',
  userSelect: 'none',
};

const sectionStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: `1px solid ${STARSColors.panelBorder}`,
};

const labelStyle: React.CSSProperties = {
  color: STARSColors.dimText,
  fontSize: 8,
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 2,
};

const buttonStyle = (active: boolean): React.CSSProperties => ({
  padding: '3px 6px',
  background: active ? STARSColors.panelButtonActive : STARSColors.panelButton,
  border: `1px solid ${active ? '#003300' : STARSColors.panelBorder}`,
  color: active ? STARSColors.normal : STARSColors.dimText,
  textShadow: active ? `0 0 4px ${STARSColors.glow}` : 'none',
  boxShadow: active ? 'inset 0 1px 3px rgba(0,0,0,0.6)' : 'none',
  fontFamily: STARSFonts.family,
  fontSize: STARSFonts.panel,
  cursor: 'pointer',
  minWidth: 32,
  textAlign: 'center',
});

const RANGE_OPTIONS = [5, 10, 20, 25, 30, 40, 60];
const TRAIL_OPTIONS = [0, 1, 3, 5, 7, 10];

/** Compact two-column row: cyan command + dim description */
const CmdLine: React.FC<{ cmd: string; desc: string }> = ({ cmd, desc }) => (
  <div style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
    <span style={{ color: '#00cccc', minWidth: 78, flexShrink: 0 }}>{cmd}</span>
    <span style={{ color: '#445544' }}>{desc}</span>
  </div>
);

import type { VideoMap } from '@atc-sim/shared';

interface VideoMapSectionProps {
  videoMaps: VideoMap[];
  enabledVideoMaps: Record<string, boolean>;
  toggleVideoMap: (id: string) => void;
  buttonStyle: (active: boolean) => React.CSSProperties;
}

const VideoMapSection: React.FC<VideoMapSectionProps> = ({ videoMaps, enabledVideoMaps, toggleVideoMap, buttonStyle }) => {
  const [expanded, setExpanded] = useState(false);

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    cursor: 'pointer',
    marginBottom: expanded ? 4 : 0,
  };

  return (
    <div style={sectionStyle}>
      <div style={headerStyle} onClick={() => setExpanded(e => !e)}>
        <div style={labelStyle}>VMAP</div>
        <span style={{ color: STARSColors.dimText, fontSize: 8, lineHeight: 1 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={buttonRowStyle}>
          {videoMaps.map((vm) => (
            <button
              key={vm.id}
              style={buttonStyle(!!enabledVideoMaps[vm.id])}
              onClick={() => toggleVideoMap(vm.id)}
              title={vm.name}
            >
              {vm.shortName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

function gradeColor(grade: string): string {
  if (grade === 'A+' || grade === 'A') return '#00ff88';
  if (grade === 'B') return '#88ff00';
  if (grade === 'C') return '#ffff00';
  if (grade === 'D') return '#ffaa00';
  return '#ff3333'; // F
}

export const DCBPanel: React.FC = () => {
  const scopeSettings = useGameStore((s) => s.scopeSettings);
  const setScopeSettings = useGameStore((s) => s.setScopeSettings);
  const score = useGameStore((s) => s.score);
  const toggleVideoMap = useGameStore((s) => s.toggleVideoMap);
  const airportData = useGameStore((s) => s.airportData);

  const toggleMap = useCallback(
    (key: 'showFixes' | 'showSIDs' | 'showSTARs' | 'showAirspace' | 'showRunways') => {
      setScopeSettings({ [key]: !scopeSettings[key] });
    },
    [scopeSettings, setScopeSettings]
  );

  return (
    <div style={panelStyle}>
      {/* Score — prominent, top of panel */}
      {score && (
        <div style={{ ...sectionStyle, background: '#030b03', padding: '8px 8px 6px' }}>
          <div style={labelStyle}>SCORE</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              fontSize: 36,
              fontWeight: 'bold',
              color: gradeColor(score.grade),
              textShadow: `0 0 10px ${gradeColor(score.grade)}66`,
              lineHeight: 1,
              minWidth: 28,
            }}>
              {score.grade}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 11 }}>
              <span style={{ color: STARSColors.normal, fontWeight: 'bold' }}>{score.overallScore} pts</span>
              <span style={{ color: STARSColors.dimText, fontSize: 9 }}>
                AC: {score.aircraftHandled} · CMD: {score.commandsIssued}
              </span>
            </div>
          </div>
          {(score.separationViolations > 0 || score.missedHandoffs > 0) && (
            <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 1, fontSize: 9 }}>
              {score.separationViolations > 0 && (
                <span style={{ color: STARSColors.alert }}>SEP VIO: {score.separationViolations}</span>
              )}
              {score.missedHandoffs > 0 && (
                <span style={{ color: STARSColors.caution }}>MISSED HO: {score.missedHandoffs}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Range */}
      <div style={sectionStyle}>
        <div style={labelStyle}>RANGE (NM)</div>
        <div style={buttonRowStyle}>
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r}
              style={buttonStyle(scopeSettings.range === r)}
              onClick={() => setScopeSettings({ range: r })}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Map Toggles */}
      <div style={sectionStyle}>
        <div style={labelStyle}>MAP</div>
        <div style={buttonRowStyle}>
          <button style={buttonStyle(scopeSettings.showFixes)} onClick={() => toggleMap('showFixes')}>
            FIX
          </button>
          <button style={buttonStyle(scopeSettings.showSIDs)} onClick={() => toggleMap('showSIDs')}>
            SID
          </button>
          <button style={buttonStyle(scopeSettings.showSTARs)} onClick={() => toggleMap('showSTARs')}>
            STR
          </button>
          <button style={buttonStyle(scopeSettings.showAirspace)} onClick={() => toggleMap('showAirspace')}>
            AS
          </button>
          <button style={buttonStyle(scopeSettings.showRunways)} onClick={() => toggleMap('showRunways')}>
            RWY
          </button>
        </div>
      </div>

      {/* Video Maps */}
      {airportData?.videoMaps && airportData.videoMaps.length > 0 && (
        <VideoMapSection
          videoMaps={airportData.videoMaps}
          enabledVideoMaps={scopeSettings.enabledVideoMaps}
          toggleVideoMap={toggleVideoMap}
          buttonStyle={buttonStyle}
        />
      )}

      {/* History Trail */}
      <div style={sectionStyle}>
        <div style={labelStyle}>HISTORY TRAIL</div>
        <div style={buttonRowStyle}>
          {TRAIL_OPTIONS.map((t) => (
            <button
              key={t}
              style={buttonStyle(scopeSettings.historyTrailLength === t)}
              onClick={() => setScopeSettings({ historyTrailLength: t })}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Velocity Vectors */}
      <div style={sectionStyle}>
        <div style={labelStyle}>PTL (MIN)</div>
        <div style={buttonRowStyle}>
          {[0, 1, 2].map((v) => (
            <button
              key={v}
              style={buttonStyle(scopeSettings.velocityVectorMinutes === v)}
              onClick={() => setScopeSettings({ velocityVectorMinutes: v })}
            >
              {v === 0 ? 'OFF' : v}
            </button>
          ))}
        </div>
      </div>

      {/* Altitude Filter */}
      <div style={sectionStyle}>
        <div style={labelStyle}>ALT FILTER</div>
        <div style={buttonRowStyle}>
          <button
            style={buttonStyle(scopeSettings.altFilterLow === 0 && scopeSettings.altFilterHigh === 99900)}
            onClick={() => setScopeSettings({ altFilterLow: 0, altFilterHigh: 99900 })}
          >
            ALL
          </button>
          <button
            style={buttonStyle(scopeSettings.altFilterLow === 0 && scopeSettings.altFilterHigh === 5000)}
            onClick={() => setScopeSettings({ altFilterLow: 0, altFilterHigh: 5000 })}
          >
            &lt;50
          </button>
          <button
            style={buttonStyle(scopeSettings.altFilterLow === 5000 && scopeSettings.altFilterHigh === 10000)}
            onClick={() => setScopeSettings({ altFilterLow: 5000, altFilterHigh: 10000 })}
          >
            50-100
          </button>
          <button
            style={buttonStyle(scopeSettings.altFilterLow === 10000 && scopeSettings.altFilterHigh === 99900)}
            onClick={() => setScopeSettings({ altFilterLow: 10000, altFilterHigh: 99900 })}
          >
            &gt;100
          </button>
        </div>
      </div>

      {/* Frequencies */}
      {airportData?.frequencies && (
        <div style={sectionStyle}>
          <div style={labelStyle}>FREQUENCIES</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 9 }}>
            {airportData.frequencies.tower?.[0] && (
              <span>TWR  {airportData.frequencies.tower[0].toFixed(1)}</span>
            )}
            {airportData.frequencies.approach?.[0] && (
              <span>APP  {airportData.frequencies.approach[0].toFixed(1)}</span>
            )}
            {airportData.frequencies.departure?.[0] && (
              <span>DEP  {airportData.frequencies.departure[0].toFixed(1)}</span>
            )}
            {airportData.frequencies.center?.[0] && (
              <span>CTR  {airportData.frequencies.center[0].toFixed(2)}</span>
            )}
            {airportData.frequencies.ground?.[0] && (
              <span>GND  {airportData.frequencies.ground[0].toFixed(1)}</span>
            )}
          </div>
        </div>
      )}


      {/* Commands quick reference */}
      <div style={{ ...sectionStyle, flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        <div style={labelStyle}>QUICK REF  <span style={{ color: '#333', fontWeight: 'normal' }}>press ? for full</span></div>
        <div style={{ fontSize: 9, lineHeight: 1.7 }}>
          {/* Altitude */}
          <div style={{ color: '#00cc88', marginTop: 2, marginBottom: 1, letterSpacing: 1 }}>ALT</div>
          <CmdLine cmd="cm 18000" desc="climb & maint" />
          <CmdLine cmd="dm 8000"  desc="descend & maint" />
          <CmdLine cmd="m 5000"   desc="maintain" />
          <CmdLine cmd="cvs"      desc="climb via SID" />
          <CmdLine cmd="dvs"      desc="descend via STAR" />

          {/* Heading */}
          <div style={{ color: '#00cccc', marginTop: 4, marginBottom: 1, letterSpacing: 1 }}>HDG</div>
          <CmdLine cmd="fh 270"   desc="fly heading" />
          <CmdLine cmd="tlh 210"  desc="turn left hdg" />
          <CmdLine cmd="trh 090"  desc="turn right hdg" />

          {/* Speed */}
          <div style={{ color: '#ccaa00', marginTop: 4, marginBottom: 1, letterSpacing: 1 }}>SPD</div>
          <CmdLine cmd="s 180"    desc="assign speed" />
          <CmdLine cmd="s 0"      desc="resume normal" />

          {/* Approach */}
          <div style={{ color: '#ffbb00', marginTop: 4, marginBottom: 1, letterSpacing: 1 }}>APPR</div>
          <CmdLine cmd="ci16"     desc="cleared ILS 16" />
          <CmdLine cmd="int 16"   desc="intercept loc 16" />
          <CmdLine cmd="cr16"     desc="cleared RNAV 16" />
          <CmdLine cmd="rfs"      desc="report field in sight" />
          <CmdLine cmd="cv16"     desc="cleared visual 16" />
          <CmdLine cmd="ga"       desc="go around" />

          {/* Nav */}
          <div style={{ color: '#88bbff', marginTop: 4, marginBottom: 1, letterSpacing: 1 }}>NAV</div>
          <CmdLine cmd="pd FIX"   desc="proceed direct" />
          <CmdLine cmd="hold FIX" desc="hold at fix" />
          <CmdLine cmd="ron"      desc="resume own nav" />
          <CmdLine cmd="ca"       desc="cancel approach" />

          {/* Handoff */}
          <div style={{ color: '#ff8844', marginTop: 4, marginBottom: 1, letterSpacing: 1 }}>HO</div>
          <CmdLine cmd=".ho"       desc="handoff (or Ctrl+↓)" />
          <CmdLine cmd="rts CALL"  desc="report traffic in sight" />

          {/* Chain */}
          <div style={{ color: '#cc88ff', marginTop: 4, marginBottom: 1, letterSpacing: 1 }}>CHAIN  (comma-sep)</div>
          <CmdLine cmd="fh 180, dm 5000"  desc="hdg + descend" />
          <CmdLine cmd="dm 8000, s 200"   desc="descend + speed" />
          <CmdLine cmd="cm 18000, .ho"    desc="climb + handoff" />
        </div>
      </div>
    </div>
  );
};
