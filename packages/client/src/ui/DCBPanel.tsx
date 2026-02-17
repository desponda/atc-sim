import React, { useCallback } from 'react';
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

const RANGE_OPTIONS = [5, 10, 20, 30, 40, 60];
const TRAIL_OPTIONS = [0, 1, 3, 5, 7, 10];

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
        <div style={sectionStyle}>
          <div style={labelStyle}>VMAP</div>
          <div style={buttonRowStyle}>
            {airportData.videoMaps.map((vm) => (
              <button
                key={vm.id}
                style={buttonStyle(!!scopeSettings.enabledVideoMaps[vm.id])}
                onClick={() => toggleVideoMap(vm.id)}
                title={vm.name}
              >
                {vm.shortName}
              </button>
            ))}
          </div>
        </div>
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

      {/* Score display */}
      {score && (
        <div style={sectionStyle}>
          <div style={labelStyle}>SCORE</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 9 }}>
            <span>
              GRADE:{' '}
              <span style={{ color: score.grade === 'A' ? STARSColors.normal : score.grade === 'F' ? STARSColors.alert : STARSColors.caution }}>
                {score.grade}
              </span>
            </span>
            <span>SCORE: {score.overallScore}</span>
            <span>SEP VIO: {score.separationViolations}</span>
            <span>AC: {score.aircraftHandled}</span>
            <span>CMDS: {score.commandsIssued}</span>
          </div>
        </div>
      )}

      {/* Commands reference */}
      <div style={{ ...sectionStyle, flex: 1, overflow: 'auto' }}>
        <div style={labelStyle}>COMMANDS</div>
        <div style={{ color: STARSColors.dimText, fontSize: 9, lineHeight: 1.5 }}>
          H/HDG nnn [L/R]<br />
          C/CLB nnn<br />
          D/DES nnn<br />
          S/SPD nnn|NORM<br />
          DIR fix<br />
          APP ILS/RNAV rwy<br />
          HO freq<br />
          GA - Go Around<br />
          CVS - Climb via SID<br />
          DVS - Descend via STAR<br />
          RON - Resume nav<br />
          CA - Cancel approach
        </div>
      </div>
    </div>
  );
};
