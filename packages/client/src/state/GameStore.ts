import { create } from 'zustand';
import type {
  AircraftState,
  GameState,
  RadioTransmission,
  Alert,
  ScoreMetrics,
  SessionInfo,
  WeatherState,
  RunwayConfig,
  SimulationClock,
  AirportData,
} from '@atc-sim/shared';

/** Highlight color for a flight strip */
export type StripHighlight = 'none' | 'yellow' | 'red';

/** A single entry in the controller event log */
export interface EventLogEntry {
  id: string;
  timestamp: number;
  type: 'conflict' | 'msaw' | 'runway' | 'wake' | 'score' | 'handoff' | 'info';
  message: string;
  severity: 'warning' | 'caution' | 'info';
}

/** Per-aircraft strip state stored client-side */
export interface StripState {
  aircraftId: string;
  scratchPad: string;
  highlight: StripHighlight;
}

export interface ScopeSettings {
  range: number;       // nm
  showFixes: boolean;
  showSIDs: boolean;
  showSTARs: boolean;
  showAirspace: boolean;
  showRunways: boolean;
  historyTrailLength: number;
  brightness: number;  // 0.0 - 1.0
  enabledVideoMaps: Record<string, boolean>;
  velocityVectorMinutes: number; // 0=off, 1, 2
  altFilterLow: number;   // ft MSL, 0 = no filter
  altFilterHigh: number;  // ft MSL, 99900 = no filter
}

export interface GameStoreState {
  // Connection
  connected: boolean;
  connectionError: string | null;

  // Session
  session: SessionInfo | null;
  inSession: boolean;
  showBriefing: boolean;

  // Game state
  aircraft: AircraftState[];
  clock: SimulationClock | null;
  weather: WeatherState | null;
  runwayConfig: RunwayConfig | null;
  alerts: Alert[];
  score: ScoreMetrics | null;
  atisText: string;

  // Airport data (loaded once)
  airportData: AirportData | null;

  // UI state
  selectedAircraftId: string | null;
  commandHistory: string[];
  commandHistoryIndex: number;
  lastCommandError: string | null;

  // Radio log
  radioLog: RadioTransmission[];

  // Scope settings
  scopeSettings: ScopeSettings;

  // Flight strip state
  stripStates: Record<string, StripState>;
  arrivalStripOrder: string[];
  departureStripOrder: string[];
  stripPanelCollapsed: boolean;

  // Event log (controller awareness panel)
  eventLog: EventLogEntry[];

  // Actions
  setConnected: (connected: boolean) => void;
  setConnectionError: (error: string | null) => void;
  setSession: (session: SessionInfo | null) => void;
  setInSession: (inSession: boolean) => void;
  setShowBriefing: (show: boolean) => void;
  updateGameState: (state: GameState) => void;
  addRadioMessage: (transmission: RadioTransmission) => void;
  addAlert: (alert: Alert) => void;
  updateScore: (score: ScoreMetrics) => void;
  setSelectedAircraft: (id: string | null) => void;
  addCommandToHistory: (command: string) => void;
  setCommandHistoryIndex: (index: number) => void;
  setLastCommandError: (error: string | null) => void;
  setAirportData: (data: AirportData) => void;
  setScopeSettings: (settings: Partial<ScopeSettings>) => void;
  toggleVideoMap: (mapId: string) => void;
  initVideoMapDefaults: (videoMaps: { id: string; defaultVisible: boolean }[]) => void;
  setStripScratchPad: (aircraftId: string, text: string) => void;
  setStripHighlight: (aircraftId: string, highlight: StripHighlight) => void;
  reorderStrips: (category: 'arrival' | 'departure', order: string[]) => void;
  setStripPanelCollapsed: (collapsed: boolean) => void;
  addEventLogEntry: (entry: EventLogEntry) => void;
}

const DEFAULT_SCOPE_SETTINGS: ScopeSettings = {
  range: 25,
  showFixes: true,
  showSIDs: true,
  showSTARs: true,
  showAirspace: true,
  showRunways: true,
  historyTrailLength: 5,
  brightness: 1.0,
  enabledVideoMaps: {},
  velocityVectorMinutes: 1,
  altFilterLow: 0,
  altFilterHigh: 99900,
};

const MAX_RADIO_LOG = 200;

export const useGameStore = create<GameStoreState>((set) => ({
  // Initial state
  connected: false,
  connectionError: null,
  session: null,
  inSession: false,
  showBriefing: false,
  aircraft: [],
  clock: null,
  weather: null,
  runwayConfig: null,
  alerts: [],
  score: null,
  atisText: '',
  airportData: null,
  selectedAircraftId: null,
  commandHistory: [],
  commandHistoryIndex: -1,
  lastCommandError: null,
  radioLog: [],
  scopeSettings: { ...DEFAULT_SCOPE_SETTINGS },
  stripStates: {},
  arrivalStripOrder: [],
  departureStripOrder: [],
  stripPanelCollapsed: false,
  eventLog: [],

  // Actions
  setConnected: (connected) => set({ connected, connectionError: connected ? null : undefined }),
  setConnectionError: (connectionError) => set({ connectionError }),

  setSession: (session) => set({ session }),
  setInSession: (inSession) => set({ inSession }),
  setShowBriefing: (showBriefing) => set({ showBriefing }),

  updateGameState: (state) =>
    set((s) => {
      // Auto-manage strip ordering: add new aircraft, keep existing order stable
      const activeIds = new Set(state.aircraft.map((a) => a.id));
      const arrIds = new Set(
        state.aircraft.filter((a) => a.category === 'arrival' || a.category === 'overflight').map((a) => a.id)
      );
      const depIds = new Set(
        state.aircraft.filter((a) => a.category === 'departure').map((a) => a.id)
      );

      // Filter out departed/landed aircraft, append new ones at end
      const arrOrder = s.arrivalStripOrder.filter((id) => arrIds.has(id));
      for (const id of arrIds) {
        if (!arrOrder.includes(id)) arrOrder.push(id);
      }
      const depOrder = s.departureStripOrder.filter((id) => depIds.has(id));
      for (const id of depIds) {
        if (!depOrder.includes(id)) depOrder.push(id);
      }

      // Clean up strip states for aircraft no longer present
      const stripStates = { ...s.stripStates };
      for (const id of Object.keys(stripStates)) {
        if (!activeIds.has(id)) delete stripStates[id];
      }

      return {
        aircraft: state.aircraft,
        clock: state.clock,
        weather: state.weather,
        runwayConfig: state.runwayConfig,
        alerts: state.alerts,
        score: state.score,
        atisText: state.atisText ?? '',
        arrivalStripOrder: arrOrder,
        departureStripOrder: depOrder,
        stripStates,
      };
    }),

  addRadioMessage: (transmission) =>
    set((s) => ({
      radioLog: [...s.radioLog.slice(-(MAX_RADIO_LOG - 1)), transmission],
    })),

  addAlert: (alert) =>
    set((s) => ({
      alerts: [...s.alerts.filter((a) => a.id !== alert.id), alert],
    })),

  updateScore: (score) => set({ score }),

  setSelectedAircraft: (id) => set({ selectedAircraftId: id }),

  addCommandToHistory: (command) =>
    set((s) => ({
      commandHistory: [...s.commandHistory, command],
      commandHistoryIndex: -1,
    })),

  setCommandHistoryIndex: (index) => set({ commandHistoryIndex: index }),

  setLastCommandError: (error) => set({ lastCommandError: error }),

  setAirportData: (data) => set({ airportData: data }),

  setScopeSettings: (settings) =>
    set((s) => ({
      scopeSettings: { ...s.scopeSettings, ...settings },
    })),

  toggleVideoMap: (mapId) =>
    set((s) => ({
      scopeSettings: {
        ...s.scopeSettings,
        enabledVideoMaps: {
          ...s.scopeSettings.enabledVideoMaps,
          [mapId]: !s.scopeSettings.enabledVideoMaps[mapId],
        },
      },
    })),

  initVideoMapDefaults: (videoMaps) =>
    set((s) => {
      const enabledVideoMaps: Record<string, boolean> = {};
      for (const vm of videoMaps) {
        enabledVideoMaps[vm.id] = vm.defaultVisible;
      }
      return {
        scopeSettings: {
          ...s.scopeSettings,
          enabledVideoMaps,
        },
      };
    }),

  setStripScratchPad: (aircraftId, text) =>
    set((s) => ({
      stripStates: {
        ...s.stripStates,
        [aircraftId]: {
          ...(s.stripStates[aircraftId] ?? { aircraftId, scratchPad: '', highlight: 'none' as StripHighlight }),
          scratchPad: text,
        },
      },
    })),

  setStripHighlight: (aircraftId, highlight) =>
    set((s) => ({
      stripStates: {
        ...s.stripStates,
        [aircraftId]: {
          ...(s.stripStates[aircraftId] ?? { aircraftId, scratchPad: '', highlight: 'none' as StripHighlight }),
          highlight,
        },
      },
    })),

  reorderStrips: (category, order) =>
    set(category === 'arrival' ? { arrivalStripOrder: order } : { departureStripOrder: order }),

  setStripPanelCollapsed: (collapsed) => set({ stripPanelCollapsed: collapsed }),

  addEventLogEntry: (entry) =>
    set((s) => ({ eventLog: [...s.eventLog.slice(-49), entry] })), // keep last 50
}));
