import React, { useRef, useEffect, useCallback } from 'react';
import { CanvasManager } from './CanvasManager';
import { useGameStore } from '../state/GameStore';
import { getGameClient } from '../network/GameClient';

const scopeContainerStyle = (stripPanelOpen: boolean): React.CSSProperties => ({
  position: 'absolute',
  top: 24,
  left: 200,
  right: stripPanelOpen ? 540 : 260, // 260 CommPanel + 280 StripPanel when open
  bottom: 32,
  overflow: 'hidden',
  transition: 'right 0.2s ease-in-out',
});

/**
 * Main React component wrapping the 4-layer canvas system.
 * Bridges Zustand store state to the imperative CanvasManager.
 */
export const RadarScope: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<CanvasManager | null>(null);

  const aircraft = useGameStore((s) => s.aircraft);
  const alerts = useGameStore((s) => s.alerts);
  const selectedAircraftId = useGameStore((s) => s.selectedAircraftId);
  const airportData = useGameStore((s) => s.airportData);
  const scopeSettings = useGameStore((s) => s.scopeSettings);
  const stripPanelCollapsed = useGameStore((s) => s.stripPanelCollapsed);

  const setSelectedAircraft = useGameStore((s) => s.setSelectedAircraft);
  const setScopeSettings = useGameStore((s) => s.setScopeSettings);
  const initVideoMapDefaults = useGameStore((s) => s.initVideoMapDefaults);

  // Initialize canvas manager
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Default center to KRIC position, will be updated if airportData loads
    const center = airportData?.position ?? { lat: 37.5052, lon: -77.3197 };

    const manager = new CanvasManager(container, center, {
      onSelectAircraft: (id) => {
        setSelectedAircraft(id);
      },
      onCycleLeader: (id) => {
        manager.dataBlockManager.cycleDirection(id);
      },
      onRedrawNeeded: () => {
        // Range may have changed from zoom
        const newRange = manager.projection.getRange();
        setScopeSettings({ range: newRange });
      },
      onRadarHandoff: (id) => {
        getGameClient().sendRadarHandoff(id);
      },
      onAcceptHandoff: (id) => {
        getGameClient().sendAcceptHandoff(id);
      },
    });

    managerRef.current = manager;

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      manager.resize();
    });
    resizeObserver.observe(container);

    // Handle click events on overlay canvas
    const overlayCanvas = container.children[3] as HTMLCanvasElement;
    if (overlayCanvas) {
      const handleClick = (e: MouseEvent) => {
        // Suppress click if the left-button was used to pan the scope
        if (manager.scopeInteraction.didLeftPan) return;
        const rect = overlayCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        manager.scopeInteraction.handleClick(x, y, useGameStore.getState().aircraft, e.shiftKey, e.ctrlKey);
      };

      const handleDoubleClick = (e: MouseEvent) => {
        const rect = overlayCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        manager.scopeInteraction.handleDoubleClick(x, y);
        e.preventDefault();
      };

      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        const rect = overlayCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        manager.scopeInteraction.handleRightClick(x, y);
      };

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          manager.scopeInteraction.clearRBL();
        }
      };

      overlayCanvas.addEventListener('click', handleClick);
      overlayCanvas.addEventListener('dblclick', handleDoubleClick);
      overlayCanvas.addEventListener('contextmenu', handleContextMenu);
      document.addEventListener('keydown', handleKeyDown);

      return () => {
        overlayCanvas.removeEventListener('click', handleClick);
        overlayCanvas.removeEventListener('dblclick', handleDoubleClick);
        overlayCanvas.removeEventListener('contextmenu', handleContextMenu);
        document.removeEventListener('keydown', handleKeyDown);
        resizeObserver.disconnect();
        manager.destroy();
        managerRef.current = null;
      };
    }

    return () => {
      resizeObserver.disconnect();
      manager.destroy();
      managerRef.current = null;
    };
  // Only re-init if airportData reference changes (loaded once)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airportData]);

  // Sync aircraft to canvas manager
  useEffect(() => {
    managerRef.current?.setAircraft(aircraft);
  }, [aircraft]);

  // Sync alerts
  useEffect(() => {
    managerRef.current?.setAlerts(alerts);
  }, [alerts]);

  // Sync selection
  useEffect(() => {
    managerRef.current?.setSelectedAircraft(selectedAircraftId);
    managerRef.current?.scopeInteraction.setSelectedAircraftId(selectedAircraftId);
  }, [selectedAircraftId]);

  // Sync airport data
  useEffect(() => {
    if (airportData) {
      managerRef.current?.setAirportData(airportData);
      if (airportData.videoMaps) {
        initVideoMapDefaults(airportData.videoMaps);
      }
    }
  }, [airportData, initVideoMapDefaults]);

  // Sync scope settings
  useEffect(() => {
    const m = managerRef.current;
    if (!m) return;

    m.setRange(scopeSettings.range);
    m.setHistoryTrailLength(scopeSettings.historyTrailLength);
    m.setVelocityVectorMinutes(scopeSettings.velocityVectorMinutes);
    m.setAltitudeFilter(scopeSettings.altFilterLow, scopeSettings.altFilterHigh);
    m.setMapOptions({
      showFixes: scopeSettings.showFixes,
      showSIDs: scopeSettings.showSIDs,
      showSTARs: scopeSettings.showSTARs,
      showAirspace: scopeSettings.showAirspace,
      showRunways: scopeSettings.showRunways,
      enabledVideoMaps: scopeSettings.enabledVideoMaps,
    });
  }, [scopeSettings]);

  return <div ref={containerRef} style={scopeContainerStyle(!stripPanelCollapsed)} />;
};
