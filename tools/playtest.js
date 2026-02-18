#!/usr/bin/env node
/**
 * Automated playtest script for ATC-Sim.
 *
 * Creates a session, starts at 4x time compression, and issues ATC commands
 * to manage arrivals and departures. Monitors for conflicts, scoring, and
 * aircraft lifecycle.
 *
 * Usage: node tools/playtest.js [--duration <seconds>] [--density heavy|moderate|light]
 */

const WebSocket = require('../packages/server/node_modules/ws');

// ─── Configuration ─────────────────────────────────────────────────────────
const WS_URL = 'ws://localhost:3001';
const DURATION_SEC = parseInt(process.argv.find((_, i, a) => a[i-1] === '--duration') || '300', 10);
const DENSITY = process.argv.find((_, i, a) => a[i-1] === '--density') || 'heavy';
const TIME_SCALE = parseInt(process.argv.find((_, i, a) => a[i-1] === '--timescale') || '4', 10);

// ─── Stats tracking ────────────────────────────────────────────────────────
const stats = {
  tickCount: 0,
  peakAircraft: 0,
  totalAircraftSeen: new Set(),
  arrivalsCleared: 0,
  departuresHandedOff: 0,
  commandsSent: 0,
  commandsFailed: 0,
  conflictAlerts: 0,
  msawAlerts: 0,
  radioMessages: 0,
  errors: [],
  aircraftPhases: {},
  separationViolations: 0,
  lastScore: null,
  startTime: Date.now(),
};

// ─── Aircraft tracking ─────────────────────────────────────────────────────
const aircraftState = new Map(); // callsign -> { state, clearedApproach, handedOff, commandHistory }

function log(tag, msg) {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  console.log(`[${elapsed}s] [${tag}] ${msg}`);
}

function logError(msg) {
  stats.errors.push(msg);
  log('ERROR', msg);
}

// ─── WebSocket client ──────────────────────────────────────────────────────
const ws = new WebSocket(WS_URL);
let sessionId = null;
let airportData = null;
let sessionStarted = false;

ws.on('open', () => {
  log('WS', 'Connected to server');

  // Create heavy traffic session
  ws.send(JSON.stringify({
    type: 'createSession',
    config: {
      airport: 'KRIC',
      difficulty: DENSITY,
      scenarioType: 'mixed',
      runwayConfig: {
        arrivalRunways: ['16'],
        departureRunways: ['16'],
      },
      weather: {
        winds: [{ altitude: 0, direction: 170, speed: 8 }],
        altimeter: 29.92,
        temperature: 15,
        visibility: 10,
        ceiling: null,
        atisLetter: 'A',
      },
    },
  }));
});

ws.on('message', (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (e) {
    logError(`Invalid JSON from server: ${data.toString().substring(0, 100)}`);
    return;
  }

  switch (msg.type) {
    case 'sessionInfo':
      sessionId = msg.session.id;
      log('SESSION', `Session ${sessionId} status=${msg.session.status}`);

      if (msg.session.status === 'lobby' && !sessionStarted) {
        // Start the session
        ws.send(JSON.stringify({ type: 'sessionControl', action: 'start' }));
        sessionStarted = true;
        log('SESSION', 'Starting session...');

        // Set time scale after a short delay
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'sessionControl',
            action: 'setTimeScale',
            timeScale: TIME_SCALE
          }));
          log('SESSION', `Time scale set to ${TIME_SCALE}x`);
        }, 1000);
      }
      break;

    case 'airportData':
      airportData = msg.data;
      const vmCount = msg.data.videoMaps?.length || 0;
      log('DATA', `Airport data received: ${msg.data.icao}, ${msg.data.runways.length} runways, ${msg.data.fixes.length} fixes, ${vmCount} video maps`);
      break;

    case 'gameState':
      handleGameState(msg.state);
      break;

    case 'radioMessage':
      stats.radioMessages++;
      // Only log interesting radio messages
      const radioText = msg.transmission?.message || '';
      const radioFrom = msg.transmission?.from || '?';
      if (radioText.includes('conflict') ||
          radioText.includes('go around') ||
          radioText.includes('unable')) {
        log('RADIO', `${radioFrom}: ${radioText}`);
      }
      break;

    case 'alert':
      handleAlert(msg.alert);
      break;

    case 'commandResponse':
      if (!msg.success) {
        stats.commandsFailed++;
        log('CMD-FAIL', `"${msg.rawText}": ${msg.error}`);
      }
      break;

    case 'error':
      logError(`Server error: ${msg.message}`);
      break;
  }
});

ws.on('close', () => {
  log('WS', 'Connection closed');
  printFinalReport();
  process.exit(0);
});

ws.on('error', (err) => {
  logError(`WebSocket error: ${err.message}`);
});

// ─── Game state handler ────────────────────────────────────────────────────
function handleGameState(state) {
  stats.tickCount++;
  const aircraft = state.aircraft || [];

  // Track peak count
  if (aircraft.length > stats.peakAircraft) {
    stats.peakAircraft = aircraft.length;
  }

  // Track all aircraft seen
  for (const ac of aircraft) {
    stats.totalAircraftSeen.add(ac.callsign);

    // Track flight phases
    stats.aircraftPhases[ac.flightPhase] = (stats.aircraftPhases[ac.flightPhase] || 0) + 1;

    // Update our tracking
    if (!aircraftState.has(ac.callsign)) {
      aircraftState.set(ac.callsign, {
        firstSeen: stats.tickCount,
        clearedApproach: false,
        handedOff: false,
        commandHistory: [],
        type: ac.category || 'unknown',
      });
      log('SPAWN', `${ac.callsign} (${ac.aircraftType}) ${ac.category || '?'} alt=${Math.round(ac.altitude)}ft hdg=${Math.round(ac.heading)}°`);
    }

    const tracking = aircraftState.get(ac.callsign);
    tracking.lastState = ac;
  }

  // Remove aircraft that disappeared
  for (const [callsign, tracking] of aircraftState) {
    if (!aircraft.find(a => a.callsign === callsign)) {
      const duration = stats.tickCount - tracking.firstSeen;
      log('REMOVE', `${callsign} removed after ${duration} ticks (${tracking.commandHistory.length} commands issued)`);
      aircraftState.delete(callsign);
    }
  }

  // Track score
  if (state.score) {
    stats.lastScore = state.score;
    stats.separationViolations = state.score.separationViolations || 0;
  }

  // Issue ATC commands for aircraft that need them
  issueCommands(aircraft);

  // Periodic status update (every 30 sim ticks)
  if (stats.tickCount % 30 === 0) {
    const arrivals = aircraft.filter(a => a.category === 'arrival').length;
    const departures = aircraft.filter(a => a.category === 'departure').length;
    const score = state.score || {};
    log('STATUS', `Tick ${stats.tickCount} | ${aircraft.length} aircraft (${arrivals}A/${departures}D) | ` +
      `Peak: ${stats.peakAircraft} | Total seen: ${stats.totalAircraftSeen.size} | ` +
      `Score: ${score.overallScore || 0}/100 Grade=${score.grade || '?'} | ` +
      `Violations: ${score.separationViolations || 0} | Alerts: ${stats.conflictAlerts}`);
  }
}

// ─── Alert handler ─────────────────────────────────────────────────────────
function handleAlert(alert) {
  if (alert.type === 'conflict') {
    stats.conflictAlerts++;
    log('ALERT', `CONFLICT: ${alert.message} [${alert.aircraftIds.join(', ')}]`);
  } else if (alert.type === 'msaw') {
    stats.msawAlerts++;
    log('ALERT', `MSAW: ${alert.message} [${alert.aircraftIds.join(', ')}]`);
  } else {
    log('ALERT', `${alert.type}: ${alert.message}`);
  }
}

// ─── ATC Command Logic ─────────────────────────────────────────────────────
function issueCommands(aircraft) {
  for (const ac of aircraft) {
    const tracking = aircraftState.get(ac.callsign);
    if (!tracking) continue;

    const isArrival = ac.category === 'arrival';
    const isDeparture = ac.category === 'departure';

    if (isArrival) {
      handleArrival(ac, tracking);
    } else if (isDeparture) {
      handleDeparture(ac, tracking);
    }
  }
}

function handleArrival(ac, tracking) {
  const alt = ac.altitude;
  const dist = estimateDistanceFromAirport(ac);

  // Runway 16 heading is ~160 degrees magnetic
  const rwyHeading = 160;

  // Step 1: Descend arrivals when they're high (get them into TRACON altitudes)
  if (alt > 8000 && dist < 40 && !tracking.commandHistory.includes('descend-7000')) {
    sendCommand(`${ac.callsign} descend and maintain 7000`);
    tracking.commandHistory.push('descend-7000');
    return;
  }

  // Step 2: Continue descent to 5000 as they get closer
  if (alt > 6000 && dist < 25 && !tracking.commandHistory.includes('descend-5000')) {
    sendCommand(`${ac.callsign} descend and maintain 5000`);
    tracking.commandHistory.push('descend-5000');
    return;
  }

  // Step 3: Speed assignment per FAA 7110.65 - 210kt+ for jets >20nm, 180kt within 20nm
  if (dist < 20 && alt < 8000 && !tracking.commandHistory.includes('slow-210')) {
    sendCommand(`${ac.callsign} reduce speed to 210`);
    tracking.commandHistory.push('slow-210');
    return;
  }

  // Step 4: Vector to base leg - turn aircraft to intercept the localizer at ~30 degrees
  // Base heading for RWY 16 (heading 160): intercept from left = heading 130, from right = heading 190
  // We'll vector most aircraft to heading 130 (left base) for a proper 30-degree intercept
  if (dist < 18 && dist > 10 && alt < 7000 && !tracking.commandHistory.includes('base-vector')) {
    sendCommand(`${ac.callsign} fly heading 130`);
    tracking.commandHistory.push('base-vector');
    return;
  }

  // Step 5: Further speed reduction within 15nm
  if (dist < 15 && alt < 6000 && !tracking.commandHistory.includes('slow-180')) {
    sendCommand(`${ac.callsign} reduce speed to 180`);
    tracking.commandHistory.push('slow-180');
    return;
  }

  // Step 6: Descend to 3000 for approach - this is the "maintain until established" altitude
  if (alt > 3500 && dist < 15 && !tracking.commandHistory.includes('descend-3000')) {
    sendCommand(`${ac.callsign} descend and maintain 3000`);
    tracking.commandHistory.push('descend-3000');
    return;
  }

  // Step 7: FAA compound clearance with proper vector
  // "turn left heading 160, maintain 3000 until established, cleared ILS runway 16 approach"
  // Per FAA 7110.65 5-9-1/5-9-4: issue when >7nm from threshold, aircraft at appropriate altitude
  // The heading 160 aligns with the localizer for a direct intercept
  if (dist > 7 && dist < 14 && alt < 5500 && !tracking.clearedApproach) {
    sendCommand(`${ac.callsign} maintain 3000 until established on the localizer, cleared ILS runway 16 approach`);
    tracking.clearedApproach = true;
    tracking.commandHistory.push('cleared-approach');
    stats.arrivalsCleared++;
    return;
  }

  // Step 8: Hand off to tower per LOA - typically around 3-4nm from threshold
  if (dist < 4 && alt < 2500 && tracking.clearedApproach && !tracking.handedOff) {
    sendCommand(`${ac.callsign} contact tower 118.3`);
    tracking.handedOff = true;
    tracking.commandHistory.push('handoff-tower');
    return;
  }
}

function handleDeparture(ac, tracking) {
  const alt = ac.altitude;
  const dist = estimateDistanceFromAirport(ac);

  // Step 1: Climb departures - TRACON ceiling is 17000, assign within limits
  if (alt < 4000 && !tracking.commandHistory.includes('climb-10000')) {
    sendCommand(`${ac.callsign} climb and maintain 10000`);
    tracking.commandHistory.push('climb-10000');
    return;
  }

  // Step 2: Hand off departures to center at sufficient altitude and distance
  // Don't wait too long - hand off before they leave TRACON airspace (60nm)
  if ((alt > 6000 || dist > 30) && !tracking.handedOff) {
    sendCommand(`${ac.callsign} contact center 128.35`);
    tracking.handedOff = true;
    tracking.commandHistory.push('handoff-center');
    stats.departuresHandedOff++;
    return;
  }
}

function estimateDistanceFromAirport(ac) {
  if (!airportData) return 99;
  const dLat = ac.position.lat - airportData.position.lat;
  const dLon = ac.position.lon - airportData.position.lon;
  // Rough nm conversion
  const latNm = dLat * 60;
  const lonNm = dLon * 60 * Math.cos(ac.position.lat * Math.PI / 180);
  return Math.sqrt(latNm * latNm + lonNm * lonNm);
}

function sendCommand(rawText) {
  if (ws.readyState !== WebSocket.OPEN) return;

  stats.commandsSent++;
  ws.send(JSON.stringify({
    type: 'command',
    command: { rawText },
  }));

  log('CMD', rawText);
}

// ─── Session timer ─────────────────────────────────────────────────────────
setTimeout(() => {
  log('TIMER', `${DURATION_SEC}s playtest duration reached. Ending session.`);

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'sessionControl', action: 'end' }));

    setTimeout(() => {
      printFinalReport();
      ws.close();
      process.exit(0);
    }, 2000);
  } else {
    printFinalReport();
    process.exit(0);
  }
}, DURATION_SEC * 1000);

// ─── Final report ──────────────────────────────────────────────────────────
function printFinalReport() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);

  console.log('\n' + '═'.repeat(70));
  console.log('  PLAYTEST REPORT');
  console.log('═'.repeat(70));
  console.log(`  Duration:            ${elapsed}s real-time (${TIME_SCALE}x time scale)`);
  console.log(`  Sim ticks:           ${stats.tickCount}`);
  console.log(`  Density:             ${DENSITY}`);
  console.log('─'.repeat(70));
  console.log('  TRAFFIC');
  console.log(`  Total aircraft seen: ${stats.totalAircraftSeen.size}`);
  console.log(`  Peak concurrent:     ${stats.peakAircraft}`);
  console.log(`  Arrivals cleared:    ${stats.arrivalsCleared}`);
  console.log(`  Departures handed:   ${stats.departuresHandedOff}`);
  console.log('─'.repeat(70));
  console.log('  COMMANDS');
  console.log(`  Commands sent:       ${stats.commandsSent}`);
  console.log(`  Commands failed:     ${stats.commandsFailed}`);
  console.log(`  Radio messages:      ${stats.radioMessages}`);
  console.log('─'.repeat(70));
  console.log('  SAFETY');
  console.log(`  Conflict alerts:     ${stats.conflictAlerts}`);
  console.log(`  MSAW alerts:         ${stats.msawAlerts}`);
  console.log(`  Sep violations:      ${stats.separationViolations}`);
  console.log('─'.repeat(70));
  if (stats.lastScore) {
    console.log('  SCORING');
    console.log(`  Overall score:       ${stats.lastScore.overallScore}/100`);
    console.log(`  Grade:               ${stats.lastScore.grade}`);
    console.log(`  Aircraft handled:    ${stats.lastScore.aircraftHandled}`);
    console.log(`  Average delay:       ${stats.lastScore.averageDelay?.toFixed(1) || 0}s`);
    console.log(`  Handoff quality:     ${stats.lastScore.handoffQuality}/100`);
  }
  console.log('─'.repeat(70));
  if (stats.errors.length > 0) {
    console.log('  ERRORS');
    for (const err of stats.errors) {
      console.log(`    - ${err}`);
    }
  } else {
    console.log('  ERRORS: None');
  }
  console.log('═'.repeat(70));

  // Assessment
  const totalAc = stats.totalAircraftSeen.size;
  const pass = totalAc >= 10 && stats.commandsFailed < stats.commandsSent * 0.5;
  console.log(`\n  RESULT: ${pass ? 'PASS' : 'NEEDS ATTENTION'}`);
  if (totalAc < 20) {
    console.log(`  NOTE: Only ${totalAc} aircraft seen. Target was 40 (20 arr + 20 dep).`);
    console.log(`  Consider running longer or increasing density.`);
  }
  console.log('');
}
