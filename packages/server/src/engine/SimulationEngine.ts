import type {
  GameState,
  SessionConfig,
  AirportData,
  AircraftState,
  SimulationClock,
  WeatherState,
  Alert,
  ScoreMetrics,
  RadioTransmission,
  TRACONLimits,
} from '@atc-sim/shared';
import { haversineDistance } from '@atc-sim/shared';
import { AircraftManager } from './AircraftManager.js';
import { PhysicsEngine } from './PhysicsEngine.js';
import { ConflictDetector } from './ConflictDetector.js';
import { PilotAI } from '../ai/PilotAI.js';
import { CommandParser } from '../commands/CommandParser.js';
import { CommandExecutor, type CommandResult } from '../commands/CommandExecutor.js';
import { ScenarioGenerator } from '../game/ScenarioGenerator.js';
import { ScoringEngine } from '../game/ScoringEngine.js';
import { RadioComms } from '../ai/RadioComms.js';

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
  private radioComms = new RadioComms();

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

  /** Departures that have spawned but haven't checked in with approach yet.
   *  They check in once airborne and above the checkin altitude threshold. */
  private pendingDepartureCheckin = new Set<string>();
  private readonly DEPARTURE_CHECKIN_AGL = 800; // ft above airport elevation

  constructor(config: SessionConfig, airportData: AirportData) {
    this.config = config;
    this.airportData = airportData;

    this.aircraftManager.setAirportCenter(airportData.position);
    this.pilotAI.setAirportData(airportData);
    this.pilotAI.setAtisLetter(config.weather.atisLetter || 'A');
    this.pilotAI.setWeather({
      ceiling: config.weather.ceiling,
      visibility: config.weather.visibility,
    });
    this.conflictDetector.setAirportData(airportData);
    this.physicsEngine.setAirportData(airportData);

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

    if (this.onRadioMessage) {
      if (result.success) {
        const isDataLink = parseResult.command.commands.every(c => c.type === 'radarHandoff');
        if (isDataLink) {
          // Radar handoff is ATC-to-ATC data link — log as system event, no radio call.
          const tick = Math.floor(this.clock.time / 1000);
          this.radioComms.systemEvent(
            `\u25b8 ${parseResult.command.callsign} — radar handoff initiated`,
            tick
          );
        } else {
          // Controller instruction is immediate; pilot readback is delayed (queued in
          // RadioComms and delivered via pilotAI.update() on upcoming ticks)
          const controllerMsg = this.radioComms.controllerInstruction(
            parseResult.command.callsign,
            parseResult.command.commands
          );
          if (controllerMsg) this.onRadioMessage(controllerMsg);
        }
        // result.readback is no longer populated — readback comes via update() drain
      } else if (result.pilotUnable) {
        // Controller transmitted, pilot responds "unable" with a brief radio delay
        const controllerMsg = this.radioComms.controllerInstruction(
          parseResult.command.callsign,
          parseResult.command.commands
        );
        if (controllerMsg) this.onRadioMessage(controllerMsg);

        const ac = this.aircraftManager.getByCallsign(parseResult.command.callsign);
        if (ac) {
          // Enqueue "unable" via pilotAI so it is drained in the update() loop
          this.pilotAI.enqueueUnable(ac, "I don't recognize that frequency", this.clock.time);
        }

        // Penalty for issuing an invalid frequency
        this.scoringEngine.recordBadCommand(2);
      }
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

  /**
   * Accept an inbound handoff from center for an arrival aircraft.
   * Sets inboundHandoff to 'accepted' and schedules a check-in after a short delay.
   */
  processAcceptHandoff(aircraftId: string): CommandResult {
    const ac = this.aircraftManager.getById(aircraftId);
    if (!ac) {
      return { success: false, callsign: '', rawText: 'acceptHandoff', error: 'Aircraft not found' };
    }
    if (ac.inboundHandoff !== 'offered') {
      return {
        success: false,
        callsign: ac.callsign,
        rawText: 'acceptHandoff',
        error: `${ac.callsign} has no pending inbound handoff offer`,
      };
    }
    ac.inboundHandoff = 'accepted';
    ac.handoffAcceptedAt = Date.now();
    // 3–5 tick delay before aircraft checks in (randomised per aircraft)
    ac.checkInDelayTicks = 3 + Math.floor(Math.random() * 3);
    return { success: true, callsign: ac.callsign, rawText: 'acceptHandoff' };
  }

  /** Initiate a radar handoff for an aircraft (click on data block). */
  processRadarHandoff(aircraftId: string): CommandResult {
    const ac = this.aircraftManager.getById(aircraftId);
    if (!ac) return { success: false, callsign: '', rawText: 'radar handoff', error: 'Aircraft not found' };
    if (ac.handingOff) return { success: false, callsign: ac.callsign, rawText: 'radar handoff', error: `${ac.callsign} already handed off` };
    if (ac.radarHandoffState === 'offered' || ac.radarHandoffState === 'accepted') {
      return { success: false, callsign: ac.callsign, rawText: 'radar handoff', error: `Radar handoff already ${ac.radarHandoffState}` };
    }
    ac.radarHandoffState = 'offered';
    ac.radarHandoffOfferedAt = this.clock.time;
    // Log ATC-to-ATC system event
    const tick = Math.floor(this.clock.time / 1000);
    this.radioComms.systemEvent(`\u25b8 ${ac.callsign} — radar handoff initiated`, tick);
    return { success: true, callsign: ac.callsign, rawText: 'radar handoff' };
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
   * Tower runway clearance check: true when it is safe for the departure to begin
   * its takeoff roll.  Mirrors real tower logic:
   *   - No aircraft currently occupying the runway (prior landing still rolling out)
   *   - No other departure already rolling on the same runway
   *   - No arrival cleared for approach to this runway within 8nm of the threshold
   *     (gives the arrival time to land and clear before the departure turns onto a SID
   *     that might cross the localizer path)
   */
  private isRunwayClearForDeparture(departure: AircraftState): boolean {
    const rwyId = departure.flightPlan.runway;
    if (!rwyId) return true;

    const runway = this.airportData.runways.find(r => r.id === rwyId);
    if (!runway) return true;

    for (const ac of this.aircraftManager.getAll()) {
      if (ac.id === departure.id) continue;

      // Landed aircraft still occupying the runway
      if (ac.runwayOccupying === rwyId) return false;

      // Another departure already rolling on the same runway
      if (
        ac.onGround &&
        ac.flightPhase === 'departure' &&
        ac.flightPlan.runway === rwyId &&
        ac.speed > 5
      ) return false;

      // Arrival cleared for approach to this runway and within 8nm of threshold
      if (
        ac.clearances.approach?.runway === rwyId &&
        (ac.flightPhase === 'approach' || ac.flightPhase === 'final')
      ) {
        const dist = haversineDistance(ac.position, runway.threshold);
        if (dist < 5) return false;
      }
    }

    return true;
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
    this.aircraftManager.incrementTick();
    const dt = 1; // 1 second per tick

    // 1. Run scenario generator (spawn new traffic)
    const spawned = this.scenarioGenerator.update(this.clock.tickCount, this.clock.timeScale);

    // 1b. Generate initial contact radio call for newly spawned aircraft.
    // Arrivals check in immediately UNLESS inboundHandoff is set (center offered
    // handoff; controller must accept before the aircraft checks in).
    // Departures wait until airborne ~800ft AGL.
    if (spawned) {
      if (spawned.category === 'departure') {
        this.pendingDepartureCheckin.add(spawned.id);
      } else if (!spawned.inboundHandoff) {
        // Arrival with no pending inbound handoff — enqueue check-in with radio delay
        this.pilotAI.generateInitialContact(spawned, this.clock.time);
      }
      // else: arrival has inboundHandoff set — suppress check-in until accepted
    }

    // 1c. Check pending departures — trigger check-in once airborne above threshold
    const checkinAlt = this.airportData.elevation + this.DEPARTURE_CHECKIN_AGL;
    for (const id of this.pendingDepartureCheckin) {
      const ac = this.aircraftManager.getById(id);
      if (!ac) {
        this.pendingDepartureCheckin.delete(id);
        continue;
      }
      if (!ac.onGround && ac.altitude >= checkinAlt) {
        // Enqueue check-in with radio delay; delivered via pilotAI.update() drain
        this.pilotAI.generateInitialContact(ac, this.clock.time);
        this.pendingDepartureCheckin.delete(id);
      }
    }

    // 1d. Safety-net check-in for any non-departure aircraft that slipped through
    // (e.g. arrivals that were already in-sim when a session reconnected).
    // Skip departures still on the ground — those are handled by pendingDepartureCheckin above.
    // Skip arrivals with inboundHandoff set — they check in via PilotAI after acceptance.
    for (const ac of aircraft) {
      if (this.pendingDepartureCheckin.has(ac.id)) continue;
      if (ac.onGround) continue;
      if (ac.inboundHandoff) continue; // suppress until handoff accepted
      // generateInitialContact is idempotent — no-op if already checked in
      this.pilotAI.generateInitialContact(ac, this.clock.time);
    }

    // 2. Run pilot AI (process pending commands, follow flight plans)
    const radioMsgs = this.pilotAI.update(aircraft, this.clock.time);
    for (const msg of radioMsgs) {
      if (this.onRadioMessage) this.onRadioMessage(msg);
    }

    // 2b. Score aircraft at the moment they are handed off to tower.
    // In real TRACON operations, the controller's job is done at handoff —
    // landing is tower's responsibility.  We record "handled" as soon as
    // the handoff command is accepted so that the score reflects the
    // controller's work even if the sim ends before the aircraft lands.
    const newlyHandedOff = this.pilotAI.getNewlyHandedOffIds();
    for (const id of newlyHandedOff) {
      this.scoringEngine.recordAircraftHandled(0);
      this.pilotAI.acknowledgeHandoffScored(id);
    }

    // 2c. Remove aircraft that have completed handoff coast period.
    // Landed aircraft are NOT removed here — AircraftManager.cleanup() handles
    // them with a multi-tick delay so the landed state is broadcast to clients.
    const handoffDone = this.pilotAI.getHandoffCompleteIds();
    for (const id of handoffDone) {
      const acForHandoff = this.aircraftManager.getById(id);
      if (acForHandoff && acForHandoff.flightPhase === 'landed') continue;
      this.aircraftManager.remove(id);
      this.pilotAI.clearHandoffComplete(id);
    }

    // 3. Update physics for all aircraft
    for (const ac of this.aircraftManager.getAll()) {
      if (ac.flightPhase === 'landed' && ac.onGround) {
        this.physicsEngine.updateGroundRollout(ac, dt);
      } else if (ac.onGround && ac.flightPhase === 'departure') {
        if (ac.targetAltitude > ac.altitude + 100) {
          // Tower runway management: hold departure at threshold until the
          // runway is clear and no arrival is on short/medium final.
          // Once rolling (speed > 5kt) the aircraft is committed.
          if (ac.speed > 5 || this.isRunwayClearForDeparture(ac)) {
            this.physicsEngine.updateTakeoffRoll(ac, dt);
          }
          // else: frozen at threshold — speed remains 0, position unchanged
        }
      } else if (!ac.onGround) {
        this.physicsEngine.updateAircraft(ac, this.weather, dt);
      }
    }

    // 3b. Transition center's 'pending' arrivals to 'offered'.
    // Two triggers: (a) aircraft crosses inside 45nm, or (b) a scheduled tick
    // is reached (used for close-in session-start arrivals that need a brief delay).
    const HANDOFF_OFFER_NM = 45;
    for (const ac of this.aircraftManager.getAll()) {
      if (ac.inboundHandoff === 'pending' && ac.category === 'arrival') {
        const dist = haversineDistance(ac.position, this.airportData.position);
        const withinRange = dist <= HANDOFF_OFFER_NM;
        const scheduledReady = ac.handoffOfferAfterTick === undefined
          || this.clock.tickCount >= ac.handoffOfferAfterTick;
        if (withinRange && scheduledReady) {
          ac.inboundHandoff = 'offered';
          ac.inboundHandoffOfferedAt = this.clock.tickCount;
          ac.handoffOfferAfterTick = undefined;
        }
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
        // Go-around triggered by conflict detector — radio call enqueued with delay
        this.pilotAI.executeGoAround(ac, trigger.reason, this.clock.time);
      }
    }

    // 5. Cleanup: remove landed/exited aircraft
    // Before cleanup, check for aircraft about to leave without handoff
    const allBeforeCleanup = this.aircraftManager.getAll();
    const aboutToLeave = new Map<string, { callsign: string; handedOff: boolean; scoredAtHandoff: boolean; category: string; inboundAccepted: boolean }>();
    for (const ac of allBeforeCleanup) {
      const alreadyScored = this.pilotAI.wasHandoffScored(ac.id);
      if (ac.flightPhase === 'landed') {
        aboutToLeave.set(ac.id, { callsign: ac.callsign, handedOff: true, scoredAtHandoff: alreadyScored, category: ac.category, inboundAccepted: true });
      } else {
        aboutToLeave.set(ac.id, {
          callsign: ac.callsign,
          handedOff: ac.handingOff || ac.clearances.handoffFrequency !== null,
          scoredAtHandoff: alreadyScored,
          category: ac.category,
          // Player is only responsible for an arrival once they accepted the
          // inbound handoff from center.  Aircraft still showing as 'offered'
          // were never under player control — don't penalise for their exit.
          inboundAccepted: ac.category !== 'arrival' || ac.inboundHandoff === 'accepted',
        });
      }
    }
    const removed = this.aircraftManager.cleanup(this.airportData);
    for (const id of removed) {
      const info = aboutToLeave.get(id);
      if (info && !info.handedOff && info.category !== 'vfr' && info.inboundAccepted) {
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
      } else if (info && !info.scoredAtHandoff) {
        // Only count as "handled" if not already scored at handoff time
        this.scoringEngine.recordAircraftHandled(0);
      }
      // If scoredAtHandoff is true, the aircraft was already counted when
      // the handoff command was issued — don't double-count.
      this.pilotAI.clearHandoffScored(id);
    }

    // 5b. Check handoff timing penalties (tower, center, inbound acceptance)
    this.scoringEngine.checkHandoffPenalties(
      this.aircraftManager.getAll(),
      this.airportData,
      this.clock.tickCount
    );

    // 6. Update scoring
    this.scoringEngine.update();

    // 7. Broadcast state
    if (this.onStateUpdate) {
      this.onStateUpdate(this.getState());
    }
  }
}
