import type {
  GameState,
  SessionConfig,
  AirportData,
  SimulationClock,
  WeatherState,
  Alert,
  ScoreMetrics,
  RadioTransmission,
  TRACONLimits,
} from '@atc-sim/shared';
import { AircraftManager } from './AircraftManager.js';
import { PhysicsEngine } from './PhysicsEngine.js';
import { ConflictDetector } from './ConflictDetector.js';
import { PilotAI } from '../ai/PilotAI.js';
import { CommandParser } from '../commands/CommandParser.js';
import { CommandExecutor, type CommandResult } from '../commands/CommandExecutor.js';
import { ScenarioGenerator } from '../game/ScenarioGenerator.js';
import { ScoringEngine } from '../game/ScoringEngine.js';

/**
 * SimulationEngine: main 1Hz game loop.
 * Each tick: update physics, run conflict detection, update scores, broadcast state.
 */
export class SimulationEngine {
  private config: SessionConfig;
  private airportData: AirportData;

  // Sub-engines
  private aircraftManager = new AircraftManager();
  private physicsEngine = new PhysicsEngine();
  private conflictDetector = new ConflictDetector();
  private pilotAI = new PilotAI();
  private commandParser = new CommandParser();
  private commandExecutor: CommandExecutor;
  private scenarioGenerator: ScenarioGenerator;
  private scoringEngine = new ScoringEngine();

  // State
  private clock: SimulationClock;
  private weather: WeatherState;
  private alerts: Alert[] = [];
  private radioLog: RadioTransmission[] = [];
  private atisText = '';
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onStateUpdate: ((state: GameState) => void) | null = null;
  private onRadioMessage: ((msg: RadioTransmission) => void) | null = null;
  private onAlert: ((alert: Alert) => void) | null = null;

  constructor(config: SessionConfig, airportData: AirportData) {
    this.config = config;
    this.airportData = airportData;

    this.aircraftManager.setAirportCenter(airportData.position);
    this.pilotAI.setAirportData(airportData);
    this.pilotAI.setAtisLetter(config.weather.atisLetter || 'A');
    this.conflictDetector.setAirportData(airportData);

    this.commandExecutor = new CommandExecutor(this.aircraftManager, this.pilotAI);
    this.commandExecutor.setAirportData(airportData);
    this.commandExecutor.setWeather({
      ceiling: config.weather.ceiling,
      visibility: config.weather.visibility,
    });

    this.scenarioGenerator = new ScenarioGenerator(
      airportData,
      config,
      this.aircraftManager
    );

    this.weather = { ...config.weather };

    this.clock = {
      time: Date.now(),
      timeScale: 1,
      tickCount: 0,
      running: false,
      paused: false,
    };

    // Generate initial ATIS
    this.atisText = this.generateATIS();
  }

  /** Start the simulation loop */
  start(onStateUpdate: (state: GameState) => void): void {
    this.onStateUpdate = onStateUpdate;
    this.clock.running = true;
    this.clock.paused = false;
    this.clock.time = Date.now();

    // Start the 1Hz game loop
    this.intervalId = setInterval(() => {
      this.tick();
    }, 1000 / this.clock.timeScale);

    console.log('[SimulationEngine] Started');
  }

  /** Pause the simulation */
  pause(): void {
    this.clock.paused = true;
    this.clock.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[SimulationEngine] Paused');
  }

  /** Resume the simulation */
  resume(onStateUpdate: (state: GameState) => void): void {
    this.onStateUpdate = onStateUpdate;
    this.clock.paused = false;
    this.clock.running = true;

    this.intervalId = setInterval(() => {
      this.tick();
    }, 1000 / this.clock.timeScale);

    console.log('[SimulationEngine] Resumed');
  }

  /** Stop the simulation */
  stop(): void {
    this.clock.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[SimulationEngine] Stopped');
  }

  /** Set time scale (1x, 2x, 4x) */
  setTimeScale(scale: number): void {
    const clamped = Math.max(1, Math.min(4, scale));
    this.clock.timeScale = clamped;

    // Restart interval with new rate
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = setInterval(() => {
        this.tick();
      }, 1000 / clamped);
    }
  }

  /** Process a raw command string. Returns result. */
  processCommand(rawText: string): CommandResult {
    const parseResult = this.commandParser.parse(rawText);
    if (!parseResult.success || !parseResult.command) {
      return {
        success: false,
        callsign: '',
        rawText,
        error: parseResult.error ?? 'Parse failed',
      };
    }

    this.scoringEngine.recordCommand();
    const result = this.commandExecutor.execute(parseResult.command, this.clock.time);

    if (result.readback && this.onRadioMessage) {
      this.onRadioMessage(result.readback);
    }

    return result;
  }

  /** Get current score */
  getScore(): ScoreMetrics {
    return this.scoringEngine.getMetrics();
  }

  /** Set radio message callback */
  setOnRadioMessage(cb: (msg: RadioTransmission) => void): void {
    this.onRadioMessage = cb;
  }

  /** Set alert callback */
  setOnAlert(cb: (alert: Alert) => void): void {
    this.onAlert = cb;
  }

  /** Update scratch pad text on an aircraft */
  updateScratchPad(aircraftId: string, text: string): void {
    const ac = this.aircraftManager.getById(aircraftId);
    if (ac) {
      ac.scratchPad = text;
    }
  }

  /** Get current game state snapshot */
  getState(): GameState {
    return {
      sessionId: '',
      aircraft: this.aircraftManager.getAll(),
      clock: { ...this.clock },
      weather: this.weather,
      runwayConfig: this.config.runwayConfig,
      alerts: this.alerts,
      score: this.scoringEngine.getMetrics(),
      atisText: this.atisText,
      traconLimits: {
        lateralRadiusNm: 60,
        ceiling: 17000,
        floor: 0,
      },
    };
  }

  /**
   * Generate ATIS text from current weather and runway configuration.
   */
  private generateATIS(): string {
    const w = this.weather;
    const letter = w.atisLetter || 'A';
    const zuluTime = new Date(this.clock.time);
    const timeStr =
      String(zuluTime.getUTCHours()).padStart(2, '0') +
      String(zuluTime.getUTCMinutes()).padStart(2, '0');

    const airportName = this.airportData.name || this.airportData.icao;

    // Wind string
    const surfaceWind = w.winds.length > 0 ? w.winds[0] : null;
    let windStr = 'calm';
    if (surfaceWind && surfaceWind.speed > 0) {
      const dir = String(Math.round(surfaceWind.direction / 10) * 10).padStart(3, '0');
      const spd = String(surfaceWind.speed).padStart(2, '0');
      windStr = `${dir} at ${spd}`;
      if (surfaceWind.gusts) {
        windStr += ` gusts ${surfaceWind.gusts}`;
      }
    }

    // Visibility
    const visStr =
      w.visibility >= 10 ? 'one zero' : String(w.visibility);

    // Ceiling
    const ceilStr = w.ceiling !== null
      ? `ceiling ${w.ceiling} broken`
      : 'sky clear';

    // Temperature
    const tempStr = `temperature ${w.temperature}`;

    // Altimeter
    const altStr = `altimeter ${w.altimeter.toFixed(2)}`;

    // Runways
    const arrRwys = this.config.runwayConfig.arrivalRunways;
    const depRwys = this.config.runwayConfig.departureRunways;

    const arrRwyStr = arrRwys.length > 0
      ? arrRwys.map(r => `runway ${r}`).join(' and ')
      : 'runway 16';
    const depRwyStr = depRwys.length > 0
      ? depRwys.map(r => `runway ${r}`).join(' and ')
      : 'runway 16';

    // Check if ILS available on arrival runways
    const ilsRwys = arrRwys.filter(r => {
      const rwy = this.airportData.runways.find(rw => rw.id === r);
      return rwy?.ilsAvailable;
    });
    const approachStr = ilsRwys.length > 0
      ? `ILS ${ilsRwys.map(r => `runway ${r}`).join(' and ')} approach in use`
      : `RNAV ${arrRwyStr} approach in use`;

    return (
      `${airportName} information ${letter}, ${timeStr} zulu. ` +
      `Winds ${windStr}. Visibility ${visStr}. ${ceilStr}. ${tempStr}. ${altStr}. ` +
      `${approachStr}. ` +
      `Landing ${arrRwyStr}, departing ${depRwyStr}. ` +
      `Advise on initial contact you have information ${letter}.`
    );
  }

  /** Main tick function */
  private tick(): void {
    this.clock.tickCount++;
    this.clock.time += 1000; // Advance sim time by 1 second

    const aircraft = this.aircraftManager.getAll();
    const dt = 1; // 1 second per tick

    // 1. Run scenario generator (spawn new traffic)
    const spawned = this.scenarioGenerator.update(this.clock.tickCount, this.clock.timeScale);

    // 1b. Generate initial contact radio call for newly spawned aircraft
    if (spawned) {
      const contactMsg = this.pilotAI.generateInitialContact(spawned);
      if (contactMsg && this.onRadioMessage) {
        this.onRadioMessage(contactMsg);
      }
    }

    // 1c. Generate initial contacts for any aircraft that haven't checked in yet
    for (const ac of aircraft) {
      const contactMsg = this.pilotAI.generateInitialContact(ac);
      if (contactMsg && this.onRadioMessage) {
        this.onRadioMessage(contactMsg);
      }
    }

    // 2. Run pilot AI (process pending commands, follow flight plans)
    const radioMsgs = this.pilotAI.update(aircraft, this.clock.time);
    for (const msg of radioMsgs) {
      if (this.onRadioMessage) this.onRadioMessage(msg);
    }

    // 2b. Remove aircraft that have completed handoff (after coast period)
    const handoffDone = this.pilotAI.getHandoffCompleteIds();
    for (const id of handoffDone) {
      this.aircraftManager.remove(id);
      this.pilotAI.clearHandoffComplete(id);
      this.scoringEngine.recordAircraftHandled(0);
    }

    // 3. Update physics for all aircraft
    for (const ac of this.aircraftManager.getAll()) {
      if (ac.flightPhase !== 'landed' && !ac.onGround) {
        this.physicsEngine.updateAircraft(ac, this.weather, dt);
      }
    }

    // 4. Run conflict detection
    const currentAircraft = this.aircraftManager.getAll();
    const newAlerts = this.conflictDetector.detect(currentAircraft, this.clock.time);
    this.alerts = this.conflictDetector.getActiveAlerts();
    for (const alert of newAlerts) {
      this.scoringEngine.recordAlert(alert);
      if (this.onAlert) this.onAlert(alert);
    }
    // Sync active violations: clear scoring violations for resolved conflicts
    this.scoringEngine.syncActiveViolations(this.conflictDetector.getActiveConflictPairKeys());

    // 4b. Process automatic go-around triggers from conflict detection
    const goAroundTriggers = this.conflictDetector.getGoAroundTriggers();
    for (const trigger of goAroundTriggers) {
      const ac = this.aircraftManager.getById(trigger.aircraftId);
      if (ac && ac.flightPhase !== 'missed' && ac.flightPhase !== 'landed') {
        const goAroundMsg = this.pilotAI.executeGoAround(ac, trigger.reason);
        if (this.onRadioMessage) this.onRadioMessage(goAroundMsg);
      }
    }

    // 5. Cleanup: remove landed/exited aircraft
    // Before cleanup, check for aircraft about to leave without handoff
    const allBeforeCleanup = this.aircraftManager.getAll();
    const aboutToLeave = new Map<string, { callsign: string; handedOff: boolean; category: string }>();
    for (const ac of allBeforeCleanup) {
      if (ac.flightPhase === 'landed') {
        aboutToLeave.set(ac.id, { callsign: ac.callsign, handedOff: true, category: ac.category });
      } else {
        aboutToLeave.set(ac.id, {
          callsign: ac.callsign,
          handedOff: ac.handingOff || ac.clearances.handoffFrequency !== null,
          category: ac.category,
        });
      }
    }
    const removed = this.aircraftManager.cleanup();
    for (const id of removed) {
      const info = aboutToLeave.get(id);
      if (info && !info.handedOff && info.category !== 'vfr') {
        // Aircraft left airspace without proper handoff - major penalty
        this.scoringEngine.recordMissedHandoff();
        const alert: Alert = {
          id: `missed-handoff-${id}`,
          type: 'airspace',
          severity: 'warning',
          aircraftIds: [id],
          message: `MISSED HANDOFF: ${info.callsign} left airspace without frequency change`,
          timestamp: this.clock.time,
        };
        this.alerts.push(alert);
        if (this.onAlert) this.onAlert(alert);
      } else {
        this.scoringEngine.recordAircraftHandled(0);
      }
    }

    // 6. Update scoring
    this.scoringEngine.update();

    // 7. Broadcast state
    if (this.onStateUpdate) {
      this.onStateUpdate(this.getState());
    }
  }
}
