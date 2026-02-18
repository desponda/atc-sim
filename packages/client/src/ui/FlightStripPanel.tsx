import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useGameStore, type StripHighlight } from '../state/GameStore';
import { getGameClient } from '../network/GameClient';
import type { AircraftState } from '@atc-sim/shared';
import { formatAltitudeDataBlock } from '@atc-sim/shared';

// ── FAA Flight Strip Colors ──
// Real strips are printed on colored card stock:
// Blue for arrivals, green for departures, white/cream for overflights
const STRIP_COLORS = {
  background: '#f5f0e0',       // Cream/off-white paper
  backgroundHover: '#ede8d4',  // Slightly darker on hover
  arrivalBand: '#4488cc',      // Blue left band for arrivals
  departureBand: '#44aa66',    // Green left band for departures
  alertBand: '#cc3333',        // Red band for conflict aircraft
  text: '#1a1a1a',             // Dark text (pencil/print)
  textDim: '#666666',          // Secondary text
  textBold: '#000000',         // Bold callsign text
  gridLine: '#c8c0a8',        // Thin grid lines between fields
  fieldBg: '#ece7d2',          // Slightly darker field backgrounds
  scratchBg: '#fffde8',        // Scratch pad area background
  scratchText: '#0044aa',      // Blue pen for handwritten notes
  highlightYellow: '#fff3a0',  // Yellow highlight strip
  highlightRed: '#ffcccc',     // Red urgency highlight
  bayHeader: '#1a1a2e',        // Dark header for bay labels
  bayHeaderText: '#ccccaa',    // Dim text in bay headers
  panelBg: '#2a2a2e',         // Dark panel background (matches STARS)
  collapseBtn: '#444450',      // Collapse button
  selectedBorder: '#00ccff',   // Cyan border for selected strip
} as const;

const STRIP_FONT = "'Share Tech Mono', 'Courier New', monospace";

// ── Styles ──

const panelStyle = (collapsed: boolean): React.CSSProperties => ({
  position: 'absolute',
  top: 24,
  right: collapsed ? -260 : 260, // Slide out of view when collapsed, or sit left of CommPanel (260px wide)
  bottom: 32,
  width: 280,
  background: STRIP_COLORS.panelBg,
  borderLeft: '1px solid #333',
  borderRight: '1px solid #333',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  transition: 'right 0.2s ease-in-out',
  zIndex: 10,
});

const collapseTabStyle: React.CSSProperties = {
  position: 'absolute',
  top: 24,
  right: 260,
  width: 20,
  height: 60,
  background: STRIP_COLORS.collapseBtn,
  border: '1px solid #555',
  borderRight: 'none',
  borderRadius: '4px 0 0 4px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  color: '#aaa',
  fontSize: 12,
  fontFamily: STRIP_FONT,
  zIndex: 11,
  userSelect: 'none',
};

const bayStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  minHeight: 0,
};

const bayHeaderStyle: React.CSSProperties = {
  padding: '3px 8px',
  background: STRIP_COLORS.bayHeader,
  color: STRIP_COLORS.bayHeaderText,
  fontSize: 9,
  fontFamily: STRIP_FONT,
  textTransform: 'uppercase',
  letterSpacing: 2,
  borderBottom: '1px solid #444',
  userSelect: 'none',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const bayContentStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  overflowX: 'hidden',
};

const stripContainerStyle = (
  isSelected: boolean,
  highlight: StripHighlight,
  isDragOver: boolean,
): React.CSSProperties => {
  let bg: string = STRIP_COLORS.background;
  if (highlight === 'yellow') bg = STRIP_COLORS.highlightYellow;
  else if (highlight === 'red') bg = STRIP_COLORS.highlightRed;

  return {
    position: 'relative',
    background: bg,
    borderBottom: `1px solid ${STRIP_COLORS.gridLine}`,
    borderTop: isDragOver ? '2px solid #00ccff' : '2px solid transparent',
    outline: isSelected ? `2px solid ${STRIP_COLORS.selectedBorder}` : 'none',
    outlineOffset: -2,
    cursor: 'pointer',
    userSelect: 'none',
    minHeight: 40,
    display: 'flex',
    flexDirection: 'row',
    transition: 'background 0.1s',
  };
};

const bandStyle = (color: string): React.CSSProperties => ({
  width: 6,
  minHeight: '100%',
  background: color,
  flexShrink: 0,
  cursor: 'pointer',
});

const stripBodyStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  padding: '2px 4px 2px 4px',
  minWidth: 0,
  overflow: 'hidden',
};

const stripRow1Style: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  lineHeight: '16px',
};

const stripRow2Style: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  lineHeight: '14px',
};

const callsignStyle: React.CSSProperties = {
  fontFamily: STRIP_FONT,
  fontSize: 13,
  fontWeight: 'bold',
  color: STRIP_COLORS.textBold,
  letterSpacing: 0.5,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

const fieldStyle: React.CSSProperties = {
  fontFamily: STRIP_FONT,
  fontSize: 10,
  color: STRIP_COLORS.text,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const dimFieldStyle: React.CSSProperties = {
  ...fieldStyle,
  color: STRIP_COLORS.textDim,
  fontSize: 9,
};

const altFieldStyle = (isClimbing: boolean, isDescending: boolean): React.CSSProperties => ({
  fontFamily: STRIP_FONT,
  fontSize: 11,
  fontWeight: 'bold',
  color: isClimbing ? '#006600' : isDescending ? '#cc4400' : STRIP_COLORS.text,
  whiteSpace: 'nowrap',
});

const squawkStyle: React.CSSProperties = {
  fontFamily: STRIP_FONT,
  fontSize: 9,
  color: STRIP_COLORS.textDim,
  whiteSpace: 'nowrap',
  borderLeft: `1px solid ${STRIP_COLORS.gridLine}`,
  paddingLeft: 4,
};

const scratchPadContainerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  marginTop: 1,
  background: STRIP_COLORS.scratchBg,
  border: `1px solid ${STRIP_COLORS.gridLine}`,
  borderRadius: 1,
  padding: '0 3px',
  minHeight: 14,
  cursor: 'text',
};

const scratchPadInputStyle: React.CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  fontFamily: STRIP_FONT,
  fontSize: 9,
  color: STRIP_COLORS.scratchText,
  fontStyle: 'italic',
  padding: 0,
  minWidth: 0,
};

const contextMenuStyle: React.CSSProperties = {
  position: 'fixed',
  background: '#1a1a2e',
  border: '1px solid #555',
  borderRadius: 3,
  padding: '2px 0',
  zIndex: 1000,
  fontFamily: STRIP_FONT,
  fontSize: 10,
  color: '#ccc',
  boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
  minWidth: 120,
};

const contextMenuItemStyle = (isDestructive?: boolean): React.CSSProperties => ({
  padding: '4px 12px',
  cursor: 'pointer',
  color: isDestructive ? '#ff6666' : '#ccc',
  whiteSpace: 'nowrap',
});

// ── Helper functions ──

function getProcedureName(ac: AircraftState): string {
  if (ac.category === 'arrival') {
    return ac.flightPlan.star || '';
  }
  return ac.flightPlan.sid || '';
}

function getRouteDisplay(ac: AircraftState): string {
  const parts: string[] = [];
  if (ac.category === 'arrival') {
    // Show current fix target and remaining route fixes
    if (ac.flightPlan.route.length > 0 && ac.currentFixIndex < ac.flightPlan.route.length) {
      const remaining = ac.flightPlan.route.slice(ac.currentFixIndex, ac.currentFixIndex + 4);
      parts.push(...remaining);
    }
  } else {
    // Show route fixes for departures
    if (ac.flightPlan.route.length > 0) {
      parts.push(...ac.flightPlan.route.slice(0, 4));
    }
  }
  return parts.join(' ') || '--';
}

function getCruiseAltDisplay(ac: AircraftState): string {
  const alt = ac.flightPlan.cruiseAltitude;
  if (!alt) return '';
  if (alt >= 18000) return `FL${Math.round(alt / 100)}`;
  return `${Math.round(alt / 100)}`;
}

function getWakeCategory(ac: AircraftState): string {
  switch (ac.wakeCategory) {
    case 'SUPER': return 'J';
    case 'HEAVY': return 'H';
    case 'LARGE': return 'L';
    case 'SMALL': return 'S';
  }
}

function getBandColor(ac: AircraftState, isAlert: boolean): string {
  if (isAlert) return STRIP_COLORS.alertBand;
  return ac.category === 'departure' ? STRIP_COLORS.departureBand : STRIP_COLORS.arrivalBand;
}

// ── FlightStrip Component ──

interface FlightStripProps {
  ac: AircraftState;
  isSelected: boolean;
  isAlert: boolean;
  stripState: { scratchPad: string; highlight: StripHighlight };
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onHighlightCycle: (id: string) => void;
  onScratchPadChange: (id: string, text: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  isDragOver: boolean;
}

const FlightStrip: React.FC<FlightStripProps> = React.memo(({
  ac,
  isSelected,
  isAlert,
  stripState,
  onSelect,
  onContextMenu,
  onHighlightCycle,
  onScratchPadChange,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
}) => {
  const scratchRef = useRef<HTMLInputElement>(null);
  const [localScratch, setLocalScratch] = useState(stripState.scratchPad);

  // Sync external changes
  useEffect(() => {
    setLocalScratch(stripState.scratchPad);
  }, [stripState.scratchPad]);

  const isClimbing = ac.verticalSpeed > 200;
  const isDescending = ac.verticalSpeed < -200;
  const altHundreds = formatAltitudeDataBlock(ac.altitude);
  const clearedAlt = ac.clearances.altitude
    ? formatAltitudeDataBlock(ac.clearances.altitude)
    : null;
  const speed = Math.round(ac.speed);
  const squawk = ac.flightPlan.squawk;
  const route = getRouteDisplay(ac);
  const procedure = getProcedureName(ac);
  const cruiseAlt = getCruiseAltDisplay(ac);
  const wakeChar = getWakeCategory(ac);
  const typeWake = `${ac.typeDesignator}/${wakeChar}`;
  const dest = ac.category === 'arrival'
    ? (ac.flightPlan.arrival?.replace(/^K/, '') || '')
    : (ac.flightPlan.arrival?.replace(/^K/, '') || '');
  const origin = ac.flightPlan.departure?.replace(/^K/, '') || '';

  const handleClick = useCallback((e: React.MouseEvent) => {
    // Don't select if clicking scratch pad
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    onSelect(ac.id);
  }, [ac.id, onSelect]);

  const handleBandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onHighlightCycle(ac.id);
  }, [ac.id, onHighlightCycle]);

  const handleScratchBlur = useCallback(() => {
    if (localScratch !== stripState.scratchPad) {
      onScratchPadChange(ac.id, localScratch);
    }
  }, [ac.id, localScratch, stripState.scratchPad, onScratchPadChange]);

  const handleScratchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
    e.stopPropagation();
  }, []);

  // Approach clearance display
  const appDisplay = ac.clearances.approach
    ? `${ac.clearances.approach.type === 'ILS' ? 'I' : ac.clearances.approach.type === 'RNAV' ? 'R' : 'V'}${ac.clearances.approach.runway}`
    : ac.flightPlan.runway
    ? `RW${ac.flightPlan.runway}`
    : '';

  return (
    <div
      style={stripContainerStyle(isSelected, stripState.highlight, isDragOver)}
      onClick={handleClick}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, ac.id); }}
      draggable
      onDragStart={(e) => onDragStart(e, ac.id)}
      onDragOver={(e) => onDragOver(e, ac.id)}
      onDrop={(e) => onDrop(e, ac.id)}
    >
      {/* Color band - clickable to cycle highlight */}
      <div
        style={bandStyle(getBandColor(ac, isAlert))}
        onClick={handleBandClick}
        title="Click to cycle highlight color"
      />

      <div style={stripBodyStyle}>
        {/* Row 1: Callsign | TYPE/W | sqk | Origin→Dest */}
        <div style={stripRow1Style}>
          <span style={callsignStyle}>{ac.callsign}</span>
          <span style={{ ...fieldStyle, fontWeight: 'bold', color: '#444', fontSize: 10 }}>
            {typeWake}
          </span>
          <span style={squawkStyle}>{squawk}</span>
          <span style={{ flex: 1 }} />
          <span style={{
            ...fieldStyle,
            fontWeight: 'bold',
            color: '#555',
            fontSize: 10,
          }}>
            {origin}{'\u2192'}{dest}
          </span>
        </div>

        {/* Row 2: filed alt | current alt / cleared alt | STAR/SID | approach/runway */}
        <div style={stripRow2Style}>
          {cruiseAlt && (
            <span style={{ ...dimFieldStyle, fontWeight: 'bold',
              color: ac.category === 'departure' ? '#006600' : '#004488',
              borderRight: `1px solid ${STRIP_COLORS.gridLine}`, paddingRight: 4 }}>
              {cruiseAlt}
            </span>
          )}
          <span style={altFieldStyle(isClimbing, isDescending)}>
            {isClimbing ? '\u2191' : isDescending ? '\u2193' : ' '}
            {altHundreds}
          </span>
          {clearedAlt && clearedAlt !== altHundreds && (
            <span style={{ ...dimFieldStyle, fontWeight: 'bold' }}>
              {'\u2192'}{clearedAlt}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {procedure && (
            <span style={{
              ...fieldStyle,
              fontWeight: 'bold',
              color: '#884400',
              fontSize: 9,
              borderRight: `1px solid ${STRIP_COLORS.gridLine}`,
              paddingRight: 4,
            }}>
              {procedure}
            </span>
          )}
          {appDisplay && (
            <span style={{ ...fieldStyle, fontWeight: 'bold', color: '#0066aa', fontSize: 10 }}>
              {appDisplay}
            </span>
          )}
        </div>

        {/* Row 3: speed | next fix / route */}
        <div style={stripRow2Style}>
          <span style={dimFieldStyle}>{speed}kt</span>
          <span style={{ flex: 1 }} />
          <span style={{ ...dimFieldStyle, maxWidth: 130, textAlign: 'right' }} title={route}>
            {route.length > 24 ? route.slice(0, 24) + '..' : route}
          </span>
        </div>

        {/* Row 3: Scratch pad */}
        <div style={scratchPadContainerStyle} onClick={(e) => {
          e.stopPropagation();
          scratchRef.current?.focus();
        }}>
          <input
            ref={scratchRef}
            type="text"
            value={localScratch}
            onChange={(e) => setLocalScratch(e.target.value)}
            onBlur={handleScratchBlur}
            onKeyDown={handleScratchKeyDown}
            style={scratchPadInputStyle}
            placeholder="scratch pad..."
            spellCheck={false}
            autoComplete="off"
            maxLength={40}
          />
        </div>
      </div>
    </div>
  );
});

FlightStrip.displayName = 'FlightStrip';

// ── StripBay Component ──

interface StripBayProps {
  title: string;
  count: number;
  aircraftIds: string[];
  aircraft: AircraftState[];
  alertIds: Set<string>;
  selectedId: string | null;
  stripStates: Record<string, { scratchPad: string; highlight: StripHighlight }>;
  category: 'arrival' | 'departure';
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onHighlightCycle: (id: string) => void;
  onScratchPadChange: (id: string, text: string) => void;
  onReorder: (category: 'arrival' | 'departure', order: string[]) => void;
}

const StripBay: React.FC<StripBayProps> = ({
  title,
  count,
  aircraftIds,
  aircraft,
  alertIds,
  selectedId,
  stripStates,
  category,
  onSelect,
  onContextMenu,
  onHighlightCycle,
  onScratchPadChange,
  onReorder,
}) => {
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);

  const acMap = new Map(aircraft.map((a) => [a.id, a]));

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    dragSourceRef.current = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    const sourceId = dragSourceRef.current;
    if (!sourceId || sourceId === targetId) return;

    const newOrder = [...aircraftIds];
    const srcIdx = newOrder.indexOf(sourceId);
    const tgtIdx = newOrder.indexOf(targetId);
    if (srcIdx < 0 || tgtIdx < 0) return;

    newOrder.splice(srcIdx, 1);
    newOrder.splice(tgtIdx, 0, sourceId);
    onReorder(category, newOrder);
    dragSourceRef.current = null;
  }, [aircraftIds, category, onReorder]);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const defaultStripState = { scratchPad: '', highlight: 'none' as StripHighlight };

  return (
    <div style={bayStyle}>
      <div style={bayHeaderStyle}>
        <span>{title}</span>
        <span style={{ fontSize: 8, opacity: 0.7 }}>{count}</span>
      </div>
      <div style={bayContentStyle} onDragLeave={handleDragLeave}>
        {aircraftIds.map((id) => {
          const ac = acMap.get(id);
          if (!ac) return null;
          // Skip landed / on-ground aircraft
          if (ac.onGround && ac.flightPhase === 'landed') return null;
          return (
            <FlightStrip
              key={id}
              ac={ac}
              isSelected={id === selectedId}
              isAlert={alertIds.has(id)}
              stripState={stripStates[id] ?? defaultStripState}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onHighlightCycle={onHighlightCycle}
              onScratchPadChange={onScratchPadChange}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              isDragOver={id === dragOverId}
            />
          );
        })}
        {aircraftIds.length === 0 && (
          <div style={{
            padding: '12px 8px',
            color: '#666',
            fontSize: 9,
            fontFamily: STRIP_FONT,
            textAlign: 'center',
            fontStyle: 'italic',
          }}>
            No strips
          </div>
        )}
      </div>
    </div>
  );
};

// ── Context Menu ──

interface ContextMenuState {
  x: number;
  y: number;
  aircraftId: string;
}

// ── Main FlightStripPanel ──

export const FlightStripPanel: React.FC = () => {
  const aircraft = useGameStore((s) => s.aircraft);
  const alerts = useGameStore((s) => s.alerts);
  const selectedAircraftId = useGameStore((s) => s.selectedAircraftId);
  const stripStates = useGameStore((s) => s.stripStates);
  const arrivalStripOrder = useGameStore((s) => s.arrivalStripOrder);
  const departureStripOrder = useGameStore((s) => s.departureStripOrder);
  const stripPanelCollapsed = useGameStore((s) => s.stripPanelCollapsed);

  const setSelectedAircraft = useGameStore((s) => s.setSelectedAircraft);
  const setStripScratchPad = useGameStore((s) => s.setStripScratchPad);
  const setStripHighlight = useGameStore((s) => s.setStripHighlight);
  const reorderStrips = useGameStore((s) => s.reorderStrips);
  const setStripPanelCollapsed = useGameStore((s) => s.setStripPanelCollapsed);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Build alert ID set
  const alertIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const alert of alerts) {
      for (const id of alert.aircraftIds) ids.add(id);
    }
    return ids;
  }, [alerts]);

  // Count active strips per bay
  const arrCount = arrivalStripOrder.filter((id) =>
    aircraft.some((a) => a.id === id && !(a.onGround && a.flightPhase === 'landed'))
  ).length;
  const depCount = departureStripOrder.filter((id) =>
    aircraft.some((a) => a.id === id && !(a.onGround && a.flightPhase === 'landed'))
  ).length;

  const handleSelect = useCallback((id: string) => {
    setSelectedAircraft(id);
  }, [setSelectedAircraft]);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    setContextMenu({ x: e.clientX, y: e.clientY, aircraftId: id });
  }, []);

  const handleHighlightCycle = useCallback((id: string) => {
    const current = stripStates[id]?.highlight ?? 'none';
    const next: StripHighlight = current === 'none' ? 'yellow' : current === 'yellow' ? 'red' : 'none';
    setStripHighlight(id, next);
  }, [stripStates, setStripHighlight]);

  const handleScratchPadChange = useCallback((id: string, text: string) => {
    setStripScratchPad(id, text);
    getGameClient().updateScratchPad(id, text);
  }, [setStripScratchPad]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  // Context menu actions
  const handleContextAction = useCallback((action: string) => {
    if (!contextMenu) return;
    const id = contextMenu.aircraftId;
    switch (action) {
      case 'highlight-yellow':
        setStripHighlight(id, 'yellow');
        break;
      case 'highlight-red':
        setStripHighlight(id, 'red');
        break;
      case 'highlight-none':
        setStripHighlight(id, 'none');
        break;
      case 'note-urgent':
        setStripScratchPad(id, 'URGENT ' + (stripStates[id]?.scratchPad ?? ''));
        break;
      case 'select':
        setSelectedAircraft(id);
        break;
    }
    setContextMenu(null);
  }, [contextMenu, setStripHighlight, setStripScratchPad, stripStates, setSelectedAircraft]);

  const toggleCollapsed = useCallback(() => {
    setStripPanelCollapsed(!stripPanelCollapsed);
  }, [stripPanelCollapsed, setStripPanelCollapsed]);

  return (
    <>
      {/* Collapse/expand tab */}
      <div
        style={{
          ...collapseTabStyle,
          right: stripPanelCollapsed ? 260 : 540,
          transition: 'right 0.2s ease-in-out',
        }}
        onClick={toggleCollapsed}
        title={stripPanelCollapsed ? 'Show flight strips' : 'Hide flight strips'}
      >
        {stripPanelCollapsed ? '\u25C0' : '\u25B6'}
      </div>

      {/* Panel */}
      <div style={panelStyle(stripPanelCollapsed)}>
        {/* Arrivals bay */}
        <StripBay
          title="ARRIVALS"
          count={arrCount}
          aircraftIds={arrivalStripOrder}
          aircraft={aircraft}
          alertIds={alertIds}
          selectedId={selectedAircraftId}
          stripStates={stripStates}
          category="arrival"
          onSelect={handleSelect}
          onContextMenu={handleContextMenu}
          onHighlightCycle={handleHighlightCycle}
          onScratchPadChange={handleScratchPadChange}
          onReorder={reorderStrips}
        />

        {/* Divider */}
        <div style={{ height: 1, background: '#555' }} />

        {/* Departures bay */}
        <StripBay
          title="DEPARTURES"
          count={depCount}
          aircraftIds={departureStripOrder}
          aircraft={aircraft}
          alertIds={alertIds}
          selectedId={selectedAircraftId}
          stripStates={stripStates}
          category="departure"
          onSelect={handleSelect}
          onContextMenu={handleContextMenu}
          onHighlightCycle={handleHighlightCycle}
          onScratchPadChange={handleScratchPadChange}
          onReorder={reorderStrips}
        />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          style={{ ...contextMenuStyle, left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={contextMenuItemStyle()}
            onClick={() => handleContextAction('select')}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#333'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
          >
            Select on scope
          </div>
          <div
            style={contextMenuItemStyle()}
            onClick={() => handleContextAction('highlight-yellow')}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#333'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
          >
            Highlight yellow
          </div>
          <div
            style={contextMenuItemStyle()}
            onClick={() => handleContextAction('highlight-red')}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#333'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
          >
            Highlight red
          </div>
          <div
            style={contextMenuItemStyle()}
            onClick={() => handleContextAction('highlight-none')}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#333'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
          >
            Clear highlight
          </div>
          <div style={{ height: 1, background: '#444', margin: '2px 0' }} />
          <div
            style={contextMenuItemStyle(true)}
            onClick={() => handleContextAction('note-urgent')}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#333'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
          >
            Mark URGENT
          </div>
        </div>
      )}

      {/* Scrollbar styling for strip bays */}
      <style>{`
        .strip-bay-scroll::-webkit-scrollbar {
          width: 4px;
        }
        .strip-bay-scroll::-webkit-scrollbar-track {
          background: #1a1a2e;
        }
        .strip-bay-scroll::-webkit-scrollbar-thumb {
          background: #444;
          border-radius: 2px;
        }
      `}</style>
    </>
  );
};
