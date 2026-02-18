import React, { useEffect, useCallback } from 'react';
import { useGameStore } from '../state/GameStore';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';

interface CmdRow {
  desc: string;
  example: string;
  shorthand?: string;
  note?: string;
}

interface CmdGroup {
  label: string;
  color: string;
  rows: CmdRow[];
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  top: 30,
  right: 220,
  bottom: 36,
  width: 420,
  background: '#051005',
  border: `1px solid ${STARSColors.panelBorder}`,
  fontFamily: STARSFonts.family,
  fontSize: 11,
  color: STARSColors.normal,
  zIndex: 500,
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'hidden',
};

const headerStyle: React.CSSProperties = {
  background: '#0a1e0a',
  borderBottom: `1px solid ${STARSColors.panelBorder}`,
  padding: '5px 10px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  flexShrink: 0,
};

const scrollBody: React.CSSProperties = {
  overflowY: 'auto',
  flex: 1,
  scrollbarWidth: 'thin',
  scrollbarColor: `${STARSColors.panelBorder} #000`,
};

const groupHeader: React.CSSProperties = {
  padding: '4px 10px 2px',
  fontSize: 10,
  letterSpacing: 2,
  fontWeight: 'bold',
  borderTop: `1px solid ${STARSColors.panelBorder}`,
  marginTop: 2,
};

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '38% 1fr',
  gap: '0 8px',
  padding: '1px 10px',
  lineHeight: '1.65',
  alignItems: 'baseline',
};

function buildGroups(towerFreq: string, centerFreq: string, arrRwys: string[], depRwys: string[]): CmdGroup[] {
  const arrRwy = arrRwys[0] ?? '16';
  const depRwy = depRwys[0] ?? '16';

  return [
    {
      label: 'ALTITUDE',
      color: '#00cc88',
      rows: [
        { desc: 'Descend & maintain', shorthand: `AAL101 dm 8000`, example: `AAL101 descend and maintain 8000` },
        { desc: 'Climb & maintain',   shorthand: `UAL123 cm 18000`, example: `UAL123 climb and maintain 18000` },
        { desc: 'Maintain (level)',    shorthand: `AAL101 m 5000`,   example: `AAL101 maintain 5000` },
        { desc: 'Descend via STAR',   shorthand: `AAL101 dvs`,      example: `AAL101 descend via the STAR` },
        { desc: 'Climb via SID',      shorthand: `UAL123 cvs`,      example: `UAL123 climb via the SID` },
      ],
    },
    {
      label: 'HEADING / VECTORS',
      color: '#00cccc',
      rows: [
        { desc: 'Turn left heading',  shorthand: `AAL101 tlh 210`, example: `AAL101 turn left heading 210`, note: 'also: tl' },
        { desc: 'Turn right heading', shorthand: `AAL101 trh 270`, example: `AAL101 turn right heading 270`, note: 'also: tr' },
        { desc: 'Fly heading (any)',  shorthand: `AAL101 fh 180`,  example: `AAL101 fly heading 180`, note: 'also: h, hdg' },
        { desc: 'Expect vectors ILS', shorthand: `AAL101 evi ${arrRwy}`, example: `AAL101 expect vectors ILS runway ${arrRwy}`, note: 'informs pilot' },
        { desc: 'Expect vectors RNAV',shorthand: `AAL101 evr ${arrRwy}`, example: `AAL101 expect vectors RNAV runway ${arrRwy}` },
        { desc: 'Expect visual',      shorthand: `AAL101 evv ${arrRwy}`, example: `AAL101 expect visual approach runway ${arrRwy}` },
      ],
    },
    {
      label: 'SPEED',
      color: '#ccaa00',
      rows: [
        { desc: 'Assign speed',       shorthand: `AAL101 s 180`, example: `AAL101 speed 180`, note: 'also: spd' },
        { desc: 'Resume normal speed',shorthand: `AAL101 s 0`,   example: `AAL101 resume normal speed` },
      ],
    },
    {
      label: 'APPROACH CLEARANCE',
      color: '#ffbb00',
      rows: [
        { desc: 'Intercept localizer',
          shorthand: `AAL101 int${arrRwy}`,
          example: `AAL101 cleared ILS runway ${arrRwy} approach`,
          note: 'auto DA check; go-around if no visual' },
        { desc: 'Cleared ILS',
          shorthand: `AAL101 ci${arrRwy}`,
          example: `AAL101 cleared ILS runway ${arrRwy} approach` },
        { desc: 'ILS + maintain',
          shorthand: `AAL101 ci${arrRwy} m3000`,
          example: `AAL101 maintain 3000 until established, cleared ILS runway ${arrRwy}` },
        { desc: 'ILS + maintain + right turn',
          shorthand: `AAL101 ci${arrRwy} m3000 r080`,
          example: `AAL101 turn right hdg 080, maintain 3000, cleared ILS ${arrRwy}` },
        { desc: 'ILS + maintain + left turn',
          shorthand: `AAL101 ci${arrRwy} m3000 l260`,
          example: `AAL101 turn left hdg 260, maintain 3000, cleared ILS ${arrRwy}` },
        { desc: 'ILS + cross fix at',
          shorthand: `AAL101 ci${arrRwy} x TONCE 3000`,
          example: `AAL101 cross TONCE at 3000, cleared ILS runway ${arrRwy}` },
        { desc: 'ILS + cross fix at/above',
          shorthand: `AAL101 ci${arrRwy} xa TONCE 3000`,
          example: `AAL101 cross TONCE at or above 3000, cleared ILS ${arrRwy}` },
        { desc: 'Cleared RNAV',
          shorthand: `AAL101 cr${arrRwy}`,
          example: `AAL101 cleared RNAV runway ${arrRwy} approach` },
        { desc: 'RNAV + maintain',
          shorthand: `AAL101 cr${arrRwy} m3000`,
          example: `AAL101 maintain 3000 until established, cleared RNAV runway ${arrRwy}` },
        { desc: 'Report field in sight',
          shorthand: `AAL101 rfs`,
          example: `AAL101 report field in sight`,
          note: 'ask pilot; wait for response' },
        { desc: 'Report traffic in sight',
          shorthand: `AAL101 rts UAL202`,
          example: `AAL101 report traffic in sight UAL202`,
          note: 'for visual sequencing' },
        { desc: 'Cleared visual',
          shorthand: `AAL101 cv${arrRwy}`,
          example: `AAL101 cleared visual approach runway ${arrRwy}`,
          note: 'requires field/traffic in sight first' },
        { desc: 'Go around',
          shorthand: `AAL101 ga`,
          example: `AAL101 go around` },
      ],
    },
    {
      label: 'NAVIGATION',
      color: '#88bbff',
      rows: [
        { desc: 'Proceed direct fix', shorthand: `AAL101 pd DUCXS`, example: `AAL101 proceed direct DUCXS` },
        { desc: 'Hold at fix',        shorthand: `AAL101 hold DUCXS`, example: `AAL101 hold at DUCXS as published` },
        { desc: 'Resume own nav',     shorthand: `AAL101 ron`,       example: `AAL101 resume own navigation` },
        { desc: 'Cancel approach',    shorthand: `AAL101 ca`,        example: `AAL101 cancel approach clearance` },
      ],
    },
    {
      label: 'HANDOFF',
      color: '#ff8844',
      rows: [
        { desc: 'Contact tower',      shorthand: `AAL101 ho ${towerFreq}`,  example: `AAL101 contact tower ${towerFreq}` },
        { desc: 'Contact center',     shorthand: `UAL123 ho ${centerFreq}`, example: `UAL123 contact center ${centerFreq}` },
        { desc: 'Contact tower (ct)', shorthand: `AAL101 ct ${towerFreq}`,  example: `AAL101 contact tower ${towerFreq}` },
      ],
    },
    {
      label: 'CHAIN  (comma-separated, one readback)',
      color: '#cc88ff',
      rows: [
        { desc: 'Hdg + descend',        shorthand: `AAL101 tlh 180, dm 5000`,          example: `turn left 180, descend 5000` },
        { desc: 'Hdg + speed',          shorthand: `AAL101 fh 270, s 180`,             example: `fly heading 270, speed 180` },
        { desc: 'Descend + speed',      shorthand: `AAL101 dm 8000, s 200`,            example: `descend 8000, speed 200` },
        { desc: 'Hdg + descend + spd',  shorthand: `AAL101 tlh 180, dm 5000, s 210`,   example: `full vector package` },
        { desc: 'Direct + descend',     shorthand: `AAL101 pd CAMRN, dm 8000`,         example: `direct CAMRN, descend 8000` },
        { desc: 'Ron + descend',        shorthand: `AAL101 ron, dm 8000`,              example: `resume own nav, descend` },
        { desc: 'Climb + handoff',      shorthand: `UAL123 cm 18000, ho ${centerFreq}`,example: `climb FL180, contact center` },
        { desc: 'Climb via SID',        shorthand: `UAL123 cm 18000, cvs`,             example: `climb FL180, climb via SID` },
        { desc: 'Approach (compound)',  shorthand: `AAL101 ci${arrRwy} m3000 r080`,    example: `hdg+maint+ILS in one token — not a chain` },
      ],
    },
    {
      label: 'DO NOT CHAIN',
      color: '#cc4444',
      rows: [
        { desc: 'Two headings',         example: `tlh 300, trh 270 — last wins, use one` },
        { desc: 'Two altitudes',        example: `dm 5000, dm 8000 — last wins, use one` },
        { desc: 'Approach + direct',    example: `ci${arrRwy} + pd — contradictory` },
        { desc: 'DVS/CVS + heading',    example: `dvs + tlh — DVS is own nav, can't vector` },
        { desc: 'Hold + anything',      example: `hold is its own clearance, don't chain` },
      ],
    },
  ];
}

export const CommandReference: React.FC<{
  onClose: () => void;
}> = ({ onClose }) => {
  const airportData = useGameStore(s => s.airportData);
  const runwayConfig = useGameStore(s => s.runwayConfig);

  const freqs = airportData?.frequencies;
  const towerFreq = freqs?.tower[0]?.toFixed(1) ?? '121.1';
  const centerFreq = freqs?.center[0]?.toFixed(2) ?? '128.55';
  const arrRwys = runwayConfig?.arrivalRunways ?? ['16'];
  const depRwys = runwayConfig?.departureRunways ?? ['16'];

  const groups = buildGroups(towerFreq, centerFreq, arrRwys, depRwys);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div style={overlay}>
      <div style={headerStyle}>
        <span style={{ color: '#ffbb00', letterSpacing: 1, fontWeight: 'bold', fontSize: 11 }}>
          COMMAND REFERENCE
        </span>
        <span
          style={{ cursor: 'pointer', color: STARSColors.dimText, fontSize: 13, lineHeight: 1 }}
          onClick={onClose}
          title="Close (Esc or ?)"
        >
          ✕
        </span>
      </div>

      <div style={scrollBody}>
        {/* Frequencies quick reference */}
        {freqs && (
          <div style={{ padding: '4px 10px 3px', borderBottom: `1px solid ${STARSColors.panelBorder}`, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <FreqBadge label="TWR" freq={towerFreq} />
            <FreqBadge label="GND" freq={freqs.ground[0]?.toFixed(1) ?? '—'} />
            {freqs.center.map(f => (
              <FreqBadge key={f} label="CTR" freq={f.toFixed(2)} />
            ))}
            <FreqBadge label="ATIS" freq={freqs.atis.toFixed(2)} />
          </div>
        )}

        {groups.map(group => (
          <div key={group.label}>
            <div style={{ ...groupHeader, color: group.color }}>{group.label}</div>
            {group.rows.map((row, i) => (
              <div key={i} style={rowStyle}>
                <span style={{ color: STARSColors.dimText }}>{row.desc}</span>
                <div>
                  {row.shorthand ? (
                    <>
                      <span style={{ color: '#00cccc' }}>{row.shorthand}</span>
                      <span style={{ color: '#333', fontSize: 10 }}> · </span>
                      <span style={{ color: '#336633', fontSize: 10 }}>{row.example}</span>
                    </>
                  ) : (
                    <span style={{ color: '#00cccc' }}>{row.example}</span>
                  )}
                  {row.note && (
                    <span style={{ color: '#555', fontSize: 10 }}> ({row.note})</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        <div style={{ padding: '6px 10px', color: STARSColors.dimText, fontSize: 10, borderTop: `1px solid ${STARSColors.panelBorder}`, marginTop: 4 }}>
          Press <span style={{ color: STARSColors.normal }}>?</span> or <span style={{ color: STARSColors.normal }}>ESC</span> to close · Click aircraft on scope to pre-fill callsign
        </div>
      </div>
    </div>
  );
};

const FreqBadge: React.FC<{ label: string; freq: string }> = ({ label, freq }) => (
  <span style={{ fontSize: 10 }}>
    <span style={{ color: STARSColors.dimText }}>{label} </span>
    <span style={{ color: STARSColors.normal }}>{freq}</span>
  </span>
);

/** Small toggle button rendered in the status bar / command input area */
export const CommandRefButton: React.FC<{ onToggle: () => void; active: boolean }> = ({ onToggle, active }) => (
  <button
    onClick={onToggle}
    title="Command reference (press ?)"
    style={{
      background: active ? '#0a2a0a' : 'transparent',
      border: `1px solid ${active ? STARSColors.normal : STARSColors.panelBorder}`,
      color: active ? STARSColors.normal : STARSColors.dimText,
      fontFamily: STARSFonts.family,
      fontSize: 11,
      padding: '1px 7px',
      cursor: 'pointer',
      lineHeight: '1',
    }}
  >
    ?
  </button>
);
