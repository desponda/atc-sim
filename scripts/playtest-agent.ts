/**
 * ATC-Sim Interactive Playtest Agent
 *
 * Connects to the live WebSocket server, creates a session, and actively
 * manages aircraft like a real TRACON controller. Produces a detailed report.
 */

import WebSocket from 'ws';
import type {
  ServerMessage,
  ClientMessage,
  GameState,
  AircraftState,
  RadioTransmission,
  Alert,
  SessionInfo,
} from '@atc-sim/shared';

// ─── Configuration ──────────────────────────────────────────────────────────
const WS_URL = 'ws://localhost:3001';
const PLAYTEST_DURATION_MS = 4 * 60 * 1000; // 4 minutes real time
const TIME_SCALE = 3;                        // 3x = 12 minutes sim time
const ARR_RUNWAY = '16';
const DEP_RUNWAY = '16';

// KRIC frequencies
const FREQ_TOWER = 121.1;
const FREQ_CENTER = 128.55;

// ─── Logging ────────────────────────────────────────────────────────────────
interface LogEntry {
  ts: number;    // wall clock ms
  simTs?: number; // sim time ms
  kind: 'radio' | 'cmd' | 'alert' | 'state' | 'info' | 'error';
  text: string;
}
const log: LogEntry[] = [];
const radioLog: RadioTransmission[] = [];
const alertLog: Alert[] = [];
const commandErrors: { cmd: string; error: string }[] = [];
const commandSuccesses: string[] = [];

let startWall = Date.now();
let lastGameState: GameState | null = null;
let sessionInfo: SessionInfo | null = null;

function L(kind: LogEntry['kind'], text: string, simTs?: number) {
  const entry: LogEntry = { ts: Date.now() - startWall, simTs, kind, text };
  log.push(entry);
  const prefix = `[${(entry.ts / 1000).toFixed(1)}s]`;
  if (kind === 'error') console.error(`${prefix} ❌ ${text}`);
  else if (kind === 'alert') console.warn(`${prefix} ⚠️  ${text}`);
  else if (kind === 'radio') console.log(`${prefix} 📻 ${text}`);
  else if (kind === 'cmd') console.log(`${prefix} 🎙  ${text}`);
  else console.log(`${prefix}    ${text}`);
}

// ─── State tracking ─────────────────────────────────────────────────────────

/** Commands issued per aircraft so we don't repeat */
const issuedCmds = new Map<string, Set<string>>();
/** Aircraft we've already issued approach clearance to */
const approachCleared = new Set<string>();
/** Aircraft we've already handed off */
const handedOff = new Set<string>();
/** Aircraft that checked in — we said hello */
const checkedIn = new Set<string>();
/** Departure altitude assigned */
const depAltAssigned = new Set<string>();
/** Track command cooldown per aircraft */
const lastCmdTime = new Map<string, number>();
/** Departures we've told to contact center */
const sentToCenter = new Set<string>();

function hasIssuedCmd(callsign: string, key: string): boolean {
  return issuedCmds.get(callsign)?.has(key) ?? false;
}
function markIssuedCmd(callsign: string, key: string) {
  if (!issuedCmds.has(callsign)) issuedCmds.set(callsign, new Set());
  issuedCmds.get(callsign)!.add(key);
}

// ─── Stats ───────────────────────────────────────────────────────────────────
const stats = {
  cmdsSent: 0,
  cmdErrors: 0,
  cmdSuccesses: 0,
  arrivalsCleared: 0,
  departuresHandedOff: 0,
  alertsReceived: 0,
  peakAircraftCount: 0,
  aircraftSeen: new Set<string>(),
};

// ─── WebSocket helpers ────────────────────────────────────────────────────────
let ws: WebSocket;
let cmdQueue: string[] = [];
let cmdInFlight = false;

function sendMsg(msg: ClientMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendCommand(rawText: string) {
  L('cmd', `→ "${rawText}"`);
  stats.cmdsSent++;
  sendMsg({ type: 'command', command: { rawText } as any });
}

// ─── Bearing / distance helpers ───────────────────────────────────────────────
function toRad(d: number) { return d * Math.PI / 180; }

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065; // nm
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function bearingTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// KRIC airport center
const KRIC_LAT = 37.5052;
const KRIC_LON = -77.3197;
// RWY 16 threshold (where ILS starts)
const RWY16_TH_LAT = 37.516636;
const RWY16_TH_LON = -77.323578;
const ILS16_COURSE = 157; // degrees

// ─── Controller logic ─────────────────────────────────────────────────────────

function angDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function vectorToFinal(ac: AircraftState): number {
  // Return a heading that will intercept the ILS for RWY 16
  // Final approach course is 157°. We want to intercept at ~30° angle.
  const distToThr = haversineNm(ac.position.lat, ac.position.lon, RWY16_TH_LAT, RWY16_TH_LON);
  // Extend the localizer back: 10-15nm final
  // FAF is roughly 5nm out on 157° from threshold
  // We'll vector to a base turn ~7nm out
  const fafLat = RWY16_TH_LAT - Math.cos(toRad(ILS16_COURSE)) * 7 / 60;
  const fafLon = RWY16_TH_LON - Math.sin(toRad(ILS16_COURSE)) * 7 / (60 * Math.cos(toRad(RWY16_TH_LAT)));
  const bearToFaf = bearingTo(ac.position.lat, ac.position.lon, fafLat, fafLon);
  return Math.round(bearToFaf / 10) * 10; // round to nearest 10°
}

function controlArrival(ac: AircraftState): void {
  const now = Date.now();
  const lastCmd = lastCmdTime.get(ac.callsign) ?? 0;
  if (now - lastCmd < 3000) return; // 3s cooldown per aircraft

  const distToAirport = haversineNm(ac.position.lat, ac.position.lon, KRIC_LAT, KRIC_LON);
  const distToThr = haversineNm(ac.position.lat, ac.position.lon, RWY16_TH_LAT, RWY16_TH_LON);
  const alt = ac.altitude;
  const cs = ac.callsign;

  // Already cleared for approach — check if we need to handoff to tower
  if (approachCleared.has(cs)) {
    if (!handedOff.has(cs) && (ac.onLocalizer || distToThr < 8) && !hasIssuedCmd(cs, 'ho_tower')) {
      markIssuedCmd(cs, 'ho_tower');
      handedOff.add(cs);
      sendCommand(`${cs} contact tower ${FREQ_TOWER}`);
      lastCmdTime.set(cs, now);
      stats.departuresHandedOff++;
    }
    return;
  }

  // Not yet cleared — sequence and vector

  // Step 1: If high altitude, start descent
  if (alt > 10000 && !hasIssuedCmd(cs, 'desc_10k')) {
    markIssuedCmd(cs, 'desc_10k');
    sendCommand(`${cs} descend and maintain 10000`);
    lastCmdTime.set(cs, now);
    return;
  }

  if (alt > 6000 && distToAirport < 30 && !hasIssuedCmd(cs, 'desc_6k')) {
    markIssuedCmd(cs, 'desc_6k');
    sendCommand(`${cs} descend and maintain 6000`);
    lastCmdTime.set(cs, now);
    return;
  }

  if (alt > 4000 && distToAirport < 20 && !hasIssuedCmd(cs, 'desc_4k')) {
    markIssuedCmd(cs, 'desc_4k');
    sendCommand(`${cs} descend and maintain 4000`);
    lastCmdTime.set(cs, now);
    return;
  }

  if (alt > 3000 && distToAirport < 15 && !hasIssuedCmd(cs, 'desc_3k')) {
    markIssuedCmd(cs, 'desc_3k');
    sendCommand(`${cs} descend and maintain 3000`);
    lastCmdTime.set(cs, now);
    return;
  }

  // Step 2: Vector toward final, ILS clearance
  if (distToAirport < 25 && !approachCleared.has(cs)) {
    // Check if we're close enough and at reasonable altitude
    if (alt <= 5000 && distToThr > 5) {
      const hdgToFinal = vectorToFinal(ac);
      const headingDiff = angDiff(ac.heading, ILS16_COURSE);

      if (!hasIssuedCmd(cs, 'vector')) {
        markIssuedCmd(cs, 'vector');
        sendCommand(`${cs} fly heading ${hdgToFinal}`);
        lastCmdTime.set(cs, now);
        return;
      }

      // Issue approach clearance when roughly aligned
      if (headingDiff < 60 && distToThr < 15 && alt <= 4000 && !hasIssuedCmd(cs, 'ils')) {
        markIssuedCmd(cs, 'ils');
        approachCleared.add(cs);
        sendCommand(`${cs} cleared ILS runway ${ARR_RUNWAY} approach`);
        lastCmdTime.set(cs, now);
        stats.arrivalsCleared++;
        return;
      }
    }
  }
}

function controlDeparture(ac: AircraftState): void {
  const now = Date.now();
  const lastCmd = lastCmdTime.get(ac.callsign) ?? 0;
  if (now - lastCmd < 3000) return;

  const cs = ac.callsign;
  const alt = ac.altitude;
  const distToAirport = haversineNm(ac.position.lat, ac.position.lon, KRIC_LAT, KRIC_LON);

  // Already sent to center
  if (sentToCenter.has(cs)) return;

  // Assign initial climb if not done
  if (!depAltAssigned.has(cs) && !ac.onGround) {
    depAltAssigned.add(cs);
    sendCommand(`${cs} climb and maintain flight level 180`);
    lastCmdTime.set(cs, now);
    return;
  }

  // Handoff to center when above FL100 and departing
  if (alt >= 10000 && distToAirport > 15 && !hasIssuedCmd(cs, 'ho_center')) {
    markIssuedCmd(cs, 'ho_center');
    sentToCenter.add(cs);
    sendCommand(`${cs} contact departure ${FREQ_CENTER}`);
    lastCmdTime.set(cs, now);
    return;
  }
}

function onGameState(state: GameState): void {
  lastGameState = state;
  const acCount = state.aircraft.length;
  if (acCount > stats.peakAircraftCount) stats.peakAircraftCount = acCount;
  state.aircraft.forEach(ac => stats.aircraftSeen.add(ac.callsign));

  // Log summary every 30 ticks
  if (state.clock.tickCount % 30 === 0) {
    const arrCount = state.aircraft.filter(a => a.category === 'arrival').length;
    const depCount = state.aircraft.filter(a => a.category === 'departure').length;
    L('state', `Tick ${state.clock.tickCount} | ${acCount} AC (${arrCount} arr, ${depCount} dep) | Score: ${state.score.overallScore.toFixed(0)} ${state.score.grade} | Alerts: ${state.alerts.length}`, state.clock.time);
  }

  // Process each aircraft
  for (const ac of state.aircraft) {
    if (ac.onGround && ac.flightPhase !== 'departure') continue;
    if (ac.flightPhase === 'landed') continue;
    if (ac.handingOff) continue;

    if (ac.category === 'arrival') {
      controlArrival(ac);
    } else if (ac.category === 'departure') {
      controlDeparture(ac);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runPlaytest(): Promise<void> {
  return new Promise((resolve) => {
    L('info', `Connecting to ${WS_URL}...`);
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      L('info', 'Connected! Creating session...');
      sendMsg({
        type: 'createSession',
        config: {
          airport: 'KRIC',
          density: 'moderate',
          scenarioType: 'mixed',
          runwayConfig: {
            arrivalRunways: [ARR_RUNWAY],
            departureRunways: [DEP_RUNWAY],
          },
          weather: {
            winds: [{ altitude: 0, direction: 170, speed: 8, gusts: null }],
            altimeter: 29.92,
            temperature: 15,
            visibility: 10,
            ceiling: null,
            atisLetter: 'A',
          },
        },
      });
    });

    ws.on('message', (data: Buffer) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        L('error', `Bad JSON: ${data.toString().slice(0, 100)}`);
        return;
      }

      switch (msg.type) {
        case 'sessionInfo': {
          sessionInfo = msg.session;
          L('info', `Session ${msg.session.id} status: ${msg.session.status}`);
          if (msg.session.status === 'lobby') {
            L('info', 'Starting session...');
            sendMsg({ type: 'sessionControl', action: 'start' });
          } else if (msg.session.status === 'running') {
            L('info', `Session running! Setting time scale to ${TIME_SCALE}x`);
            sendMsg({ type: 'sessionControl', action: 'setTimeScale', timeScale: TIME_SCALE });
          }
          break;
        }

        case 'gameState':
          onGameState(msg.state);
          break;

        case 'radioMessage': {
          const t = msg.transmission;
          radioLog.push(t);
          L('radio', `${t.from}: "${t.message}"`);
          break;
        }

        case 'alert': {
          const a = msg.alert;
          alertLog.push(a);
          stats.alertsReceived++;
          L('alert', `${a.type.toUpperCase()} [${a.severity}]: ${a.message}`);
          break;
        }

        case 'commandResponse': {
          if (msg.success) {
            stats.cmdSuccesses++;
            commandSuccesses.push(msg.rawText);
          } else {
            stats.cmdErrors++;
            commandErrors.push({ cmd: msg.rawText, error: msg.error ?? '?' });
            L('error', `CMD FAIL: "${msg.rawText}" → ${msg.error}`);
          }
          break;
        }

        case 'error':
          L('error', `Server error: ${msg.message}`);
          break;

        case 'airportData':
          L('info', `Airport data received for ${(msg.data as any).icao ?? 'KRIC'}`);
          break;
      }
    });

    ws.on('error', (err) => {
      L('error', `WebSocket error: ${err.message}`);
    });

    ws.on('close', () => {
      L('info', 'WebSocket closed.');
      resolve();
    });

    // End session after PLAYTEST_DURATION_MS
    setTimeout(() => {
      L('info', `Ending session after ${PLAYTEST_DURATION_MS / 1000}s real time...`);
      sendMsg({ type: 'sessionControl', action: 'end' });
      setTimeout(() => {
        ws.close();
        resolve();
      }, 2000);
    }, PLAYTEST_DURATION_MS);
  });
}

// ─── Report ───────────────────────────────────────────────────────────────────

function generateReport(): void {
  const finalState = lastGameState;

  console.log('\n');
  console.log('═'.repeat(70));
  console.log('  ATC-SIM PLAYTEST REPORT');
  console.log('═'.repeat(70));

  // Session summary
  console.log('\n── SESSION SUMMARY ──────────────────────────────────────────────────');
  console.log(`  Airport:          KRIC (Richmond International)`);
  console.log(`  Config:           Moderate / Mixed / RWY ${ARR_RUNWAY} arr, ${DEP_RUNWAY} dep`);
  console.log(`  Time scale:       ${TIME_SCALE}x`);
  console.log(`  Real duration:    ~${(PLAYTEST_DURATION_MS / 1000).toFixed(0)}s`);
  if (finalState) {
    const simMinutes = ((finalState.clock.time - (finalState.clock.time % 3600000)) / 60000) % 60;
    console.log(`  Sim ticks:        ${finalState.clock.tickCount}`);
  }

  // Traffic stats
  console.log('\n── TRAFFIC ──────────────────────────────────────────────────────────');
  console.log(`  Unique aircraft:  ${stats.aircraftSeen.size}`);
  console.log(`  Peak on scope:    ${stats.peakAircraftCount}`);
  console.log(`  Arrivals cleared: ${stats.arrivalsCleared}`);
  console.log(`  Dep handed off:   ${stats.departuresHandedOff}`);
  const finalAcList = finalState?.aircraft ?? [];
  const finalArr = finalAcList.filter(a => a.category === 'arrival');
  const finalDep = finalAcList.filter(a => a.category === 'departure');
  console.log(`  At session end:   ${finalAcList.length} AC (${finalArr.length} arr, ${finalDep.length} dep)`);

  // Commands
  console.log('\n── COMMANDS ──────────────────────────────────────────────────────────');
  console.log(`  Sent:             ${stats.cmdsSent}`);
  console.log(`  Successes:        ${stats.cmdSuccesses}`);
  console.log(`  Failures:         ${stats.cmdErrors}`);
  if (commandErrors.length > 0) {
    console.log(`  Failed commands:`);
    commandErrors.slice(0, 10).forEach(e => {
      console.log(`    • "${e.cmd}" → ${e.error}`);
    });
  }

  // Score
  if (finalState) {
    const s = finalState.score;
    console.log('\n── SCORE ────────────────────────────────────────────────────────────');
    console.log(`  Overall:          ${s.overallScore.toFixed(0)}/100 (${s.grade})`);
    console.log(`  Aircraft handled: ${s.aircraftHandled}`);
    console.log(`  Sep violations:   ${s.separationViolations}`);
    console.log(`  Conflict alerts:  ${s.conflictAlerts}`);
    console.log(`  Missed handoffs:  ${s.missedHandoffs}`);
    console.log(`  Avg delay:        ${s.averageDelay.toFixed(0)}s`);
    console.log(`  Handoff quality:  ${s.handoffQuality.toFixed(0)}/100`);
  }

  // Alerts
  console.log('\n── ALERTS ───────────────────────────────────────────────────────────');
  if (alertLog.length === 0) {
    console.log('  No alerts triggered. ✓');
  } else {
    const byType: Record<string, number> = {};
    alertLog.forEach(a => { byType[a.type] = (byType[a.type] ?? 0) + 1; });
    Object.entries(byType).forEach(([t, n]) => {
      console.log(`  ${t.padEnd(20)} ${n}×`);
    });
    console.log(`  Sample alert messages:`);
    alertLog.slice(0, 5).forEach(a => {
      console.log(`    [${a.severity}] ${a.message}`);
    });
  }

  // Radio log sample
  console.log('\n── RADIO LOG (last 20 transmissions) ────────────────────────────────');
  radioLog.slice(-20).forEach(t => {
    console.log(`  ${t.from.padEnd(12)} "${t.message.slice(0, 70)}"`);
  });

  // Observations
  console.log('\n── OBSERVATIONS & BUGS ─────────────────────────────────────────────');

  // Analyze arrivals
  const arrivals = [...stats.aircraftSeen].filter(cs => {
    const ac = finalAcList.find(a => a.callsign === cs);
    return ac?.category === 'arrival';
  });
  const departuresStillHigh = finalAcList.filter(
    a => a.category === 'departure' && a.altitude > 12000 && !sentToCenter.has(a.callsign)
  );
  const arrivalsStuckHigh = finalAcList.filter(
    a => a.category === 'arrival' && a.altitude > 8000
  );
  const unhandledArrivals = finalAcList.filter(
    a => a.category === 'arrival' && !approachCleared.has(a.callsign)
  );

  if (commandErrors.length === 0) {
    console.log('  ✓ All commands parsed successfully — command parser working well');
  } else {
    console.log(`  ✗ ${commandErrors.length} command(s) failed — see Failures above`);
  }

  if (stats.alertsReceived === 0) {
    console.log('  ✓ No conflict alerts — separation maintained');
  } else {
    console.log(`  ⚠ ${stats.alertsReceived} alert(s) triggered during session`);
  }

  if (stats.arrivalsCleared > 0) {
    console.log(`  ✓ ILS clearances issued successfully (${stats.arrivalsCleared} aircraft)`);
  } else if (stats.aircraftSeen.size > 0) {
    console.log('  ⚠ No arrivals cleared — check arrival spawning');
  }

  if (arrivalsStuckHigh.length > 0) {
    console.log(`  ⚠ ${arrivalsStuckHigh.length} arrival(s) still above 8000ft at end — descent rate may be slow`);
    arrivalsStuckHigh.forEach(a => console.log(`    • ${a.callsign}: ${a.altitude}ft, ${haversineNm(a.position.lat, a.position.lon, KRIC_LAT, KRIC_LON).toFixed(1)}nm out`));
  }

  if (unhandledArrivals.length > 0) {
    console.log(`  ⚠ ${unhandledArrivals.length} arrival(s) never cleared for approach`);
  }

  if (stats.aircraftSeen.size === 0) {
    console.log('  ✗ NO AIRCRAFT APPEARED — critical spawning bug');
  } else if (stats.aircraftSeen.size < 3) {
    console.log(`  ⚠ Only ${stats.aircraftSeen.size} aircraft appeared — warm-up spawn rate may be too slow`);
  } else {
    console.log(`  ✓ ${stats.aircraftSeen.size} aircraft appeared over session`);
  }

  // Radio quality
  const pilotReadbacks = radioLog.filter(r => r.from !== 'controller');
  const controllerTx = radioLog.filter(r => r.from === 'controller');
  console.log(`  ✓ ${controllerTx.length} controller tx, ${pilotReadbacks.length} pilot readbacks`);
  const unableCount = pilotReadbacks.filter(r => r.message.toLowerCase().includes('unable')).length;
  if (unableCount > 0) {
    console.log(`  ⚠ Pilot said "unable" ${unableCount} time(s)`);
  }

  // Final aircraft states
  if (finalAcList.length > 0) {
    console.log('\n── FINAL AIRCRAFT STATES ────────────────────────────────────────────');
    finalAcList.forEach(ac => {
      const dist = haversineNm(ac.position.lat, ac.position.lon, KRIC_LAT, KRIC_LON).toFixed(1);
      const phase = ac.flightPhase.padEnd(10);
      const category = ac.category.padEnd(10);
      console.log(`  ${ac.callsign.padEnd(10)} ${category} ${phase} alt:${String(ac.altitude).padStart(6)} spd:${String(ac.speed).padStart(4)} dist:${dist}nm ${ac.onLocalizer ? '🛬LOC' : ''}`);
    });
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  END OF PLAYTEST REPORT');
  console.log('═'.repeat(70) + '\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
startWall = Date.now();
runPlaytest()
  .then(() => {
    generateReport();
    process.exit(0);
  })
  .catch(err => {
    console.error('Playtest error:', err);
    process.exit(1);
  });
