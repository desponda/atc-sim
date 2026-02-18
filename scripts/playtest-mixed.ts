/**
 * Playtest: Mixed Operations - Departures, Conflicts, Separation
 *
 * Tests:
 * 1. Mixed scenario with departures + arrivals
 * 2. Departure handling (heading, altitude, climb and maintain)
 * 3. Conflict detection (vectoring two aircraft together)
 * 4. Speed commands
 * 5. Descend via STAR
 * 6. Proceed direct to fix
 * 7. Multiple sequential commands
 * 8. MSAW alerts
 */

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3001';

interface TestResult {
  test: string;
  passed: boolean;
  details: string;
  severity?: 'critical' | 'major' | 'minor';
}

const results: TestResult[] = [];
let sessionId = '';
let gameStates: any[] = [];
let alerts: any[] = [];
let commandResponses: any[] = [];
let radioMessages: any[] = [];
let airportData: any = null;

function log(msg: string) {
  console.log(`[PLAYTEST-MIXED] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function record(test: string, passed: boolean, details: string, severity?: 'critical' | 'major' | 'minor') {
  results.push({ test, passed, details, severity });
  const status = passed ? 'PASS' : 'FAIL';
  const sev = severity ? ` [${severity}]` : '';
  log(`  ${status}${sev}: ${test} - ${details}`);
}

function sendMsg(ws: WebSocket, msg: any): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(msg), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sendCommand(ws: WebSocket, rawText: string): Promise<any> {
  return new Promise(async (resolve) => {
    const prevLen = commandResponses.length;
    await sendMsg(ws, {
      type: 'command',
      command: {
        callsign: rawText.split(' ')[0].toUpperCase(),
        commands: [],
        rawText,
        timestamp: Date.now(),
      },
    });
    // Wait for command response
    const timeout = Date.now() + 3000;
    while (commandResponses.length === prevLen && Date.now() < timeout) {
      await sleep(100);
    }
    if (commandResponses.length > prevLen) {
      resolve(commandResponses[commandResponses.length - 1]);
    } else {
      resolve(null);
    }
  });
}

function getLatestState(): any | null {
  return gameStates.length > 0 ? gameStates[gameStates.length - 1] : null;
}

function findAircraftByCategory(category: string): any[] {
  const state = getLatestState();
  if (!state) return [];
  return state.aircraft.filter((a: any) => a.category === category);
}

function findAircraftByCallsign(callsign: string): any | null {
  const state = getLatestState();
  if (!state) return null;
  return state.aircraft.find((a: any) => a.callsign === callsign) ?? null;
}

async function waitForAircraft(ws: WebSocket, minCount: number, maxWait: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const state = getLatestState();
    if (state && state.aircraft.length >= minCount) return;
    await sleep(500);
  }
}

async function waitForSimSeconds(seconds: number, timeScale: number): Promise<void> {
  // At timeScale x, each real second = timeScale sim seconds
  // So to get N sim seconds, wait N / timeScale real seconds
  const realMs = (seconds / timeScale) * 1000;
  await sleep(realMs);
}

async function runTests(ws: WebSocket): Promise<void> {
  // ==========================================
  // STEP 1: Create session - mixed, heavy
  // ==========================================
  log('=== STEP 1: Create mixed/heavy session ===');

  await sendMsg(ws, {
    type: 'createSession',
    config: {
      airport: 'KRIC',
      density: 'heavy',
      scenarioType: 'mixed',
      runwayConfig: {
        arrivalRunways: ['16'],
        departureRunways: ['16'],
      },
      weather: {
        winds: [{ altitude: 0, direction: 180, speed: 8, gusts: null }],
        altimeter: 29.92,
        temperature: 20,
        visibility: 10,
        ceiling: null,
        atisLetter: 'B',
      },
    },
  });

  // Wait for sessionInfo
  await sleep(2000);

  if (!sessionId) {
    record('Session creation', false, 'No session ID received', 'critical');
    return;
  }
  record('Session creation', true, `Session ${sessionId} created for mixed/heavy`);

  // ==========================================
  // STEP 2: Start session and set time scale
  // ==========================================
  log('=== STEP 2: Start session, set 4x speed ===');

  await sendMsg(ws, { type: 'sessionControl', action: 'start' });
  await sleep(1000);

  await sendMsg(ws, { type: 'sessionControl', action: 'setTimeScale', timeScale: 4 });
  await sleep(500);

  const initialState = getLatestState();
  if (initialState) {
    record('Session started', true, `Got initial state with ${initialState.aircraft.length} aircraft`);

    const timeScale = initialState.clock?.timeScale;
    record('Time scale', timeScale === 4, `Time scale is ${timeScale}, expected 4`,
           timeScale === 4 ? undefined : 'major');
  } else {
    record('Session started', false, 'No game state received after start', 'critical');
    return;
  }

  // ==========================================
  // STEP 3: Let aircraft spawn for 30+ sim seconds
  // ==========================================
  log('=== STEP 3: Wait for traffic (30+ sim seconds) ===');

  // At 4x speed, 30 sim seconds = 7.5 real seconds. Wait a bit more.
  await waitForSimSeconds(35, 4);

  const afterSpawn = getLatestState();
  const totalAircraft = afterSpawn?.aircraft?.length ?? 0;
  const departures = findAircraftByCategory('departure');
  const arrivals = findAircraftByCategory('arrival');
  const vfrTraffic = findAircraftByCategory('vfr');

  log(`  Total aircraft: ${totalAircraft}`);
  log(`  Arrivals: ${arrivals.length}, Departures: ${departures.length}, VFR: ${vfrTraffic.length}`);

  record('Mixed traffic spawning', totalAircraft >= 5,
         `${totalAircraft} aircraft spawned (${arrivals.length} arr, ${departures.length} dep, ${vfrTraffic.length} vfr)`,
         totalAircraft < 5 ? 'critical' : undefined);

  record('Has departures', departures.length > 0,
         `${departures.length} departures present`,
         departures.length === 0 ? 'critical' : undefined);

  record('Has arrivals', arrivals.length > 0,
         `${arrivals.length} arrivals present`,
         arrivals.length === 0 ? 'major' : undefined);

  // Check departure initial state
  if (departures.length > 0) {
    const dep = departures[0];
    log(`  Departure sample: ${dep.callsign}, alt=${dep.altitude}, hdg=${dep.heading}, vs=${dep.verticalSpeed}, phase=${dep.flightPhase}`);

    record('Departure is climbing', dep.verticalSpeed > 0 || dep.altitude > 1000,
           `${dep.callsign}: alt=${Math.round(dep.altitude)}, vs=${Math.round(dep.verticalSpeed)}`,
           dep.verticalSpeed <= 0 && dep.altitude <= 1000 ? 'major' : undefined);

    record('Departure flight phase', dep.flightPhase === 'departure' || dep.flightPhase === 'climb',
           `Phase: ${dep.flightPhase}`,
           dep.flightPhase !== 'departure' && dep.flightPhase !== 'climb' ? 'minor' : undefined);
  }

  // ==========================================
  // STEP 4: Test departure commands - heading + altitude
  // ==========================================
  log('=== STEP 4: Test departure commands ===');

  if (departures.length > 0) {
    const dep = departures[0];

    // Test heading command on departure
    log(`  Assigning heading 270 to departure ${dep.callsign}`);
    const headingResp = await sendCommand(ws, `${dep.callsign} turn left heading 270`);

    if (headingResp) {
      record('Departure heading command accepted', headingResp.success === true,
             `Response: success=${headingResp.success}, error=${headingResp.error || 'none'}`,
             headingResp.success !== true ? 'major' : undefined);
    } else {
      record('Departure heading command accepted', false, 'No response received', 'major');
    }

    await waitForSimSeconds(8, 4);

    // Check if heading changed
    const depAfterHdg = findAircraftByCallsign(dep.callsign);
    if (depAfterHdg) {
      const headingSet = depAfterHdg.clearances?.heading === 270;
      record('Departure heading clearance set', headingSet,
             `Clearance heading: ${depAfterHdg.clearances?.heading}, target heading: ${depAfterHdg.targetHeading}`,
             !headingSet ? 'major' : undefined);
    }

    // Test "climb and maintain" on departure
    log(`  Commanding ${dep.callsign} climb and maintain 10000`);
    const climbResp = await sendCommand(ws, `${dep.callsign} climb and maintain 10000`);

    if (climbResp) {
      record('Climb and maintain accepted', climbResp.success === true,
             `Response: success=${climbResp.success}, error=${climbResp.error || 'none'}`,
             climbResp.success !== true ? 'major' : undefined);
    } else {
      record('Climb and maintain accepted', false, 'No response received', 'major');
    }

    await waitForSimSeconds(8, 4);

    const depAfterClimb = findAircraftByCallsign(dep.callsign);
    if (depAfterClimb) {
      record('Climb clearance altitude set', depAfterClimb.clearances?.altitude === 10000,
             `Clearance alt: ${depAfterClimb.clearances?.altitude}, target alt: ${depAfterClimb.targetAltitude}`,
             depAfterClimb.clearances?.altitude !== 10000 ? 'major' : undefined);
    }
  } else {
    record('Departure commands', false, 'No departures available to test', 'critical');
  }

  // ==========================================
  // STEP 5: Test conflict detection
  // ==========================================
  log('=== STEP 5: Test conflict detection ===');

  // Get current arrivals and try to vector them toward each other
  const arrivalsNow = findAircraftByCategory('arrival');
  const allAircraft = getLatestState()?.aircraft ?? [];

  if (arrivalsNow.length >= 2) {
    const ac1 = arrivalsNow[0];
    const ac2 = arrivalsNow[1];

    log(`  Vectoring ${ac1.callsign} (alt=${Math.round(ac1.altitude)}, hdg=${Math.round(ac1.heading)}) and ${ac2.callsign} (alt=${Math.round(ac2.altitude)}, hdg=${Math.round(ac2.heading)}) toward each other`);

    // Set both to the same altitude
    const commonAlt = 6000;

    if (ac1.altitude > commonAlt) {
      await sendCommand(ws, `${ac1.callsign} descend and maintain ${commonAlt}`);
    } else {
      await sendCommand(ws, `${ac1.callsign} climb and maintain ${commonAlt}`);
    }

    if (ac2.altitude > commonAlt) {
      await sendCommand(ws, `${ac2.callsign} descend and maintain ${commonAlt}`);
    } else {
      await sendCommand(ws, `${ac2.callsign} climb and maintain ${commonAlt}`);
    }

    // Calculate bearing from ac1 to ac2 and vice versa
    const bearing1to2 = Math.round(Math.atan2(
      ac2.position.lon - ac1.position.lon,
      ac2.position.lat - ac1.position.lat
    ) * 180 / Math.PI);
    const heading1to2 = ((bearing1to2 % 360) + 360) % 360 || 360;
    const heading2to1 = ((heading1to2 + 180 - 1) % 360) + 1;

    log(`  Setting ${ac1.callsign} heading ${heading1to2} toward ${ac2.callsign}`);
    log(`  Setting ${ac2.callsign} heading ${heading2to1} toward ${ac1.callsign}`);

    const conflictCmd1 = await sendCommand(ws, `${ac1.callsign} fly heading ${heading1to2}`);
    const conflictCmd2 = await sendCommand(ws, `${ac2.callsign} fly heading ${heading2to1}`);

    record('Conflict heading commands accepted',
           conflictCmd1?.success === true && conflictCmd2?.success === true,
           `ac1: ${conflictCmd1?.success}, ac2: ${conflictCmd2?.success}`);

    // Wait for conflict alert (aircraft need time to converge)
    const alertsBefore = alerts.length;
    log(`  Waiting for conflict alert (currently ${alertsBefore} alerts)...`);

    await waitForSimSeconds(45, 4);

    const alertsAfter = alerts.length;
    const conflictAlerts = alerts.filter((a: any) => a.type === 'conflict');

    log(`  Alerts after vectoring: ${alertsAfter} total, ${conflictAlerts.length} conflict alerts`);

    if (conflictAlerts.length > 0) {
      log(`  Latest conflict alert: ${conflictAlerts[conflictAlerts.length - 1].message}`);
    }

    // Check game state alerts too
    const currentState = getLatestState();
    const stateAlerts = currentState?.alerts ?? [];
    const stateConflicts = stateAlerts.filter((a: any) => a.type === 'conflict');

    record('Conflict alert triggered', conflictAlerts.length > 0 || stateConflicts.length > 0,
           `Alert messages: ${conflictAlerts.length} via callback, ${stateConflicts.length} in state`,
           conflictAlerts.length === 0 && stateConflicts.length === 0 ? 'major' : undefined);

    // Check scoring engine too
    const score = currentState?.score;
    if (score) {
      log(`  Score: conflictAlerts=${score.conflictAlerts}, sepViolations=${score.separationViolations}`);
      record('Scoring tracks conflicts', score.conflictAlerts > 0 || score.separationViolations > 0,
             `Conflict alerts tracked: ${score.conflictAlerts}, violations: ${score.separationViolations}`,
             score.conflictAlerts === 0 && score.separationViolations === 0 ? 'minor' : undefined);
    }

    // Now separate them to resolve conflict
    log(`  Separating aircraft to resolve conflict...`);
    await sendCommand(ws, `${ac1.callsign} climb and maintain 8000`);
    await sendCommand(ws, `${ac2.callsign} descend and maintain 4000`);

  } else if (allAircraft.length >= 2) {
    // Use any two aircraft
    const ac1 = allAircraft[0];
    const ac2 = allAircraft[1];
    log(`  Only ${arrivalsNow.length} arrivals, using ${ac1.callsign} and ${ac2.callsign} instead`);

    // Similar vectoring logic
    await sendCommand(ws, `${ac1.callsign} descend and maintain 6000`);
    await sendCommand(ws, `${ac2.callsign} descend and maintain 6000`);

    await waitForSimSeconds(30, 4);

    const conflictAlerts = alerts.filter((a: any) => a.type === 'conflict');
    record('Conflict detection with limited aircraft', conflictAlerts.length > 0,
           `${conflictAlerts.length} conflict alerts triggered`,
           'minor');
  } else {
    record('Conflict detection', false, `Only ${allAircraft.length} aircraft, need at least 2`, 'major');
  }

  // ==========================================
  // STEP 6: Test speed commands
  // ==========================================
  log('=== STEP 6: Test speed commands ===');

  const speedTarget = findAircraftByCategory('arrival')[0] ?? findAircraftByCategory('departure')[0];

  if (speedTarget) {
    const originalSpeed = speedTarget.speed;
    log(`  ${speedTarget.callsign} current speed: ${Math.round(originalSpeed)}`);

    // Reduce speed
    log(`  Commanding ${speedTarget.callsign} reduce speed to 180`);
    const speedResp = await sendCommand(ws, `${speedTarget.callsign} reduce speed to 180`);

    if (speedResp) {
      record('Speed reduce command accepted', speedResp.success === true,
             `Response: success=${speedResp.success}, error=${speedResp.error || 'none'}`,
             speedResp.success !== true ? 'major' : undefined);
    } else {
      record('Speed reduce command accepted', false, 'No response received', 'major');
    }

    await waitForSimSeconds(8, 4);

    const afterSpeed = findAircraftByCallsign(speedTarget.callsign);
    if (afterSpeed) {
      record('Speed clearance set', afterSpeed.clearances?.speed === 180,
             `Clearance speed: ${afterSpeed.clearances?.speed}, target speed: ${afterSpeed.targetSpeed}`,
             afterSpeed.clearances?.speed !== 180 ? 'major' : undefined);

      // Check if aircraft is actually slowing down
      const speedDiff = afterSpeed.speed - originalSpeed;
      log(`  Speed change: ${Math.round(originalSpeed)} -> ${Math.round(afterSpeed.speed)} (diff: ${Math.round(speedDiff)})`);
    }

    // Resume normal speed
    log(`  Commanding ${speedTarget.callsign} resume normal speed`);
    const resumeResp = await sendCommand(ws, `${speedTarget.callsign} resume normal speed`);

    if (resumeResp) {
      record('Resume speed command accepted', resumeResp.success === true,
             `Response: success=${resumeResp.success}, error=${resumeResp.error || 'none'}`,
             resumeResp.success !== true ? 'major' : undefined);
    } else {
      record('Resume speed command accepted', false, 'No response received', 'major');
    }

    await waitForSimSeconds(8, 4);

    const afterResume = findAircraftByCallsign(speedTarget.callsign);
    if (afterResume) {
      record('Speed clearance cleared', afterResume.clearances?.speed === null,
             `Clearance speed after resume: ${afterResume.clearances?.speed}`,
             afterResume.clearances?.speed !== null ? 'minor' : undefined);
    }
  } else {
    record('Speed commands', false, 'No aircraft available for speed test', 'major');
  }

  // ==========================================
  // STEP 7: Test "descend via STAR"
  // ==========================================
  log('=== STEP 7: Test descend via STAR ===');

  const starTarget = findAircraftByCategory('arrival').find((a: any) => a.flightPlan?.star);

  if (starTarget) {
    log(`  ${starTarget.callsign} on STAR: ${starTarget.flightPlan.star}`);
    log(`  Current altitude: ${Math.round(starTarget.altitude)}, descendViaSTAR: ${starTarget.clearances?.descendViaSTAR}`);

    const starResp = await sendCommand(ws, `${starTarget.callsign} descend via star`);

    if (starResp) {
      record('Descend via STAR command accepted', starResp.success === true,
             `Response: success=${starResp.success}, error=${starResp.error || 'none'}`,
             starResp.success !== true ? 'major' : undefined);
    } else {
      record('Descend via STAR command accepted', false, 'No response received', 'major');
    }

    await waitForSimSeconds(8, 4);

    const afterStar = findAircraftByCallsign(starTarget.callsign);
    if (afterStar) {
      record('Descend via STAR clearance set', afterStar.clearances?.descendViaSTAR === true,
             `descendViaSTAR: ${afterStar.clearances?.descendViaSTAR}`,
             afterStar.clearances?.descendViaSTAR !== true ? 'major' : undefined);
    }
  } else {
    const anyArrival = findAircraftByCategory('arrival')[0];
    if (anyArrival) {
      log(`  No arrival with STAR found. Trying on ${anyArrival.callsign} (STAR: ${anyArrival.flightPlan?.star})`);
      const starResp = await sendCommand(ws, `${anyArrival.callsign} descend via star`);
      record('Descend via STAR command accepted (no STAR assigned)', starResp?.success === true,
             `Response: success=${starResp?.success}, error=${starResp?.error || 'none'}`,
             'minor');
    } else {
      record('Descend via STAR', false, 'No arrivals available', 'major');
    }
  }

  // ==========================================
  // STEP 8: Test "proceed direct" to a fix
  // ==========================================
  log('=== STEP 8: Test proceed direct to fix ===');

  const directTarget = findAircraftByCategory('arrival')[0] ?? findAircraftByCategory('departure')[0];

  if (directTarget) {
    // Try to find a fix from the aircraft's route or from airport data
    let fixName = 'CAMRN'; // Common KRIC fix

    if (directTarget.flightPlan?.route?.length > 0) {
      fixName = directTarget.flightPlan.route[0];
      log(`  Using fix from route: ${fixName}`);
    }

    log(`  Commanding ${directTarget.callsign} proceed direct ${fixName}`);
    const directResp = await sendCommand(ws, `${directTarget.callsign} proceed direct ${fixName}`);

    if (directResp) {
      record('Proceed direct command accepted', directResp.success === true,
             `Response: success=${directResp.success}, error=${directResp.error || 'none'}`,
             directResp.success !== true ? 'major' : undefined);
    } else {
      record('Proceed direct command accepted', false, 'No response received', 'major');
    }

    await waitForSimSeconds(8, 4);

    const afterDirect = findAircraftByCallsign(directTarget.callsign);
    if (afterDirect) {
      record('Direct fix clearance set', afterDirect.clearances?.directFix === fixName,
             `directFix: ${afterDirect.clearances?.directFix}, expected: ${fixName}`,
             afterDirect.clearances?.directFix !== fixName ? 'major' : undefined);
    }
  } else {
    record('Proceed direct', false, 'No aircraft available', 'major');
  }

  // ==========================================
  // STEP 9: Test multiple sequential commands
  // ==========================================
  log('=== STEP 9: Test multiple sequential commands ===');

  const multiTarget = findAircraftByCategory('arrival')[1] ?? findAircraftByCategory('arrival')[0] ?? findAircraftByCategory('departure')[0];

  if (multiTarget) {
    log(`  Sending heading + altitude combo to ${multiTarget.callsign}`);

    // Test comma-separated multi-command
    const multiResp = await sendCommand(ws, `${multiTarget.callsign} turn right heading 090, descend and maintain 4000`);

    if (multiResp) {
      record('Multi-command accepted', multiResp.success === true,
             `Response: success=${multiResp.success}, error=${multiResp.error || 'none'}`,
             multiResp.success !== true ? 'major' : undefined);
    } else {
      record('Multi-command accepted', false, 'No response received', 'major');
    }

    await waitForSimSeconds(8, 4);

    const afterMulti = findAircraftByCallsign(multiTarget.callsign);
    if (afterMulti) {
      const hdgOk = afterMulti.clearances?.heading === 90;
      const altOk = afterMulti.clearances?.altitude === 4000;
      record('Multi-command heading set', hdgOk,
             `Heading clearance: ${afterMulti.clearances?.heading}, expected: 90`,
             !hdgOk ? 'major' : undefined);
      record('Multi-command altitude set', altOk,
             `Altitude clearance: ${afterMulti.clearances?.altitude}, expected: 4000`,
             !altOk ? 'major' : undefined);
    }

    // Now send a second different command to the same aircraft
    log(`  Sending speed command to same aircraft ${multiTarget.callsign}`);
    const speedFollowup = await sendCommand(ws, `${multiTarget.callsign} speed 210`);

    if (speedFollowup) {
      record('Sequential command accepted', speedFollowup.success === true,
             `Response: success=${speedFollowup.success}, error=${speedFollowup.error || 'none'}`,
             speedFollowup.success !== true ? 'minor' : undefined);
    }

    await waitForSimSeconds(8, 4);

    const afterSeq = findAircraftByCallsign(multiTarget.callsign);
    if (afterSeq) {
      // Previous heading/altitude should still be set, plus new speed
      const allSet = afterSeq.clearances?.heading === 90 &&
                     afterSeq.clearances?.altitude === 4000 &&
                     afterSeq.clearances?.speed === 210;
      record('Sequential command preserves prior clearances', allSet,
             `After sequential: hdg=${afterSeq.clearances?.heading}, alt=${afterSeq.clearances?.altitude}, spd=${afterSeq.clearances?.speed}`,
             !allSet ? 'major' : undefined);
    }
  } else {
    record('Multiple sequential commands', false, 'No aircraft available', 'major');
  }

  // ==========================================
  // STEP 10: Test MSAW alert
  // ==========================================
  log('=== STEP 10: Test MSAW alert ===');

  // Find the lowest-altitude arrival to minimize descent time to MVA (2000ft).
  // Sort arrivals by altitude ascending and pick the lowest one above 2000ft.
  const msawCandidates = findAircraftByCategory('arrival')
    .filter((a: any) => a.altitude > 2000 && a.flightPhase !== 'final' && a.flightPhase !== 'landed')
    .sort((a: any, b: any) => a.altitude - b.altitude);
  const msawTarget = msawCandidates[0];

  if (msawTarget) {
    log(`  Descending ${msawTarget.callsign} from ${Math.round(msawTarget.altitude)}ft to 1500 (below MVA of 2000)`);
    const msawResp = await sendCommand(ws, `${msawTarget.callsign} descend and maintain 1500`);

    if (msawResp?.success) {
      // Speed up sim for this long wait, then restore
      await sendMsg(ws, { type: 'sessionControl', action: 'setTimeScale', timeScale: 8 });
      await sleep(500);

      // At ~1500 fpm descent, we need (altitude - 2000) / 1500 minutes to reach MVA.
      // Add buffer for PilotAI delay (up to 5s) and descent acceleration.
      const descentNeeded = msawTarget.altitude - 2000;
      const estSimSeconds = Math.ceil((descentNeeded / 1500) * 60) + 15;
      log(`  Need ~${estSimSeconds} sim-seconds to descend ${Math.round(descentNeeded)}ft (at 8x speed)`);

      await waitForSimSeconds(estSimSeconds, 8);

      // Restore time scale
      await sendMsg(ws, { type: 'sessionControl', action: 'setTimeScale', timeScale: 4 });
      await sleep(500);

      const msawAc = findAircraftByCallsign(msawTarget.callsign);
      if (msawAc) {
        log(`  ${msawTarget.callsign} now at ${Math.round(msawAc.altitude)}ft, vs=${Math.round(msawAc.verticalSpeed)}`);
      }

      const msawAlerts = alerts.filter((a: any) => a.type === 'msaw');
      const stateAlerts = getLatestState()?.alerts?.filter((a: any) => a.type === 'msaw') ?? [];

      log(`  MSAW alerts: ${msawAlerts.length} via callback, ${stateAlerts.length} in state`);

      if (msawAlerts.length > 0) {
        log(`  MSAW message: ${msawAlerts[msawAlerts.length - 1].message}`);
      }

      record('MSAW alert triggered', msawAlerts.length > 0 || stateAlerts.length > 0,
             `MSAW alerts: ${msawAlerts.length} callback, ${stateAlerts.length} in state`,
             msawAlerts.length === 0 && stateAlerts.length === 0 ? 'major' : undefined);
    } else {
      record('MSAW test command', false, `Could not descend ${msawTarget.callsign}: ${msawResp?.error}`, 'minor');
    }
  } else {
    record('MSAW alert test', false, 'No suitable aircraft to test MSAW', 'minor');
  }

  // ==========================================
  // STEP 11: Check overall simulation health
  // ==========================================
  log('=== STEP 11: Simulation health checks ===');

  const finalState = getLatestState();
  if (finalState) {
    // Check clock is advancing
    record('Clock advancing', finalState.clock.tickCount > 30,
           `Tick count: ${finalState.clock.tickCount}`,
           finalState.clock.tickCount <= 30 ? 'major' : undefined);

    // Check no aircraft at negative altitude
    const negAlt = finalState.aircraft.filter((a: any) => a.altitude < 0);
    record('No negative altitude aircraft', negAlt.length === 0,
           negAlt.length > 0 ? `${negAlt.length} aircraft below sea level: ${negAlt.map((a: any) => `${a.callsign}=${Math.round(a.altitude)}`).join(', ')}` : 'All aircraft at valid altitudes',
           negAlt.length > 0 ? 'critical' : undefined);

    // Check no aircraft with impossible speed
    const badSpeed = finalState.aircraft.filter((a: any) => a.speed < 0 || a.speed > 600);
    record('No invalid speed aircraft', badSpeed.length === 0,
           badSpeed.length > 0 ? `${badSpeed.length} aircraft with bad speed: ${badSpeed.map((a: any) => `${a.callsign}=${Math.round(a.speed)}`).join(', ')}` : 'All speeds valid',
           badSpeed.length > 0 ? 'critical' : undefined);

    // Check score metrics
    const score = finalState.score;
    log(`  Score: overall=${score.overallScore}, grade=${score.grade}, handled=${score.aircraftHandled}, commands=${score.commandsIssued}`);

    record('Commands tracked in score', score.commandsIssued > 0,
           `Commands issued: ${score.commandsIssued}`,
           score.commandsIssued === 0 ? 'minor' : undefined);

    // Check radio messages
    log(`  Radio messages received: ${radioMessages.length}`);
    record('Radio readbacks received', radioMessages.length > 0,
           `${radioMessages.length} radio messages received`,
           radioMessages.length === 0 ? 'major' : undefined);

    // Check for errors in command responses
    const failedCommands = commandResponses.filter((r: any) => !r.success);
    log(`  Command responses: ${commandResponses.length} total, ${failedCommands.length} failed`);
    for (const fc of failedCommands) {
      log(`    FAILED: ${fc.rawText} - ${fc.error}`);
    }
  }

  // ==========================================
  // STEP 12: Airport data check
  // ==========================================
  log('=== STEP 12: Airport data ===');

  if (airportData) {
    record('Airport data received', true, `ICAO: ${airportData.icao}, name: ${airportData.name}`);
    record('Airport has runways', airportData.runways?.length > 0,
           `${airportData.runways?.length} runways`,
           airportData.runways?.length === 0 ? 'critical' : undefined);
    record('Airport has STARs', airportData.stars?.length > 0,
           `${airportData.stars?.length} STARs: ${airportData.stars?.map((s: any) => s.name).join(', ')}`,
           airportData.stars?.length === 0 ? 'major' : undefined);
    record('Airport has SIDs', airportData.sids?.length > 0,
           `${airportData.sids?.length} SIDs: ${airportData.sids?.map((s: any) => s.name).join(', ')}`,
           airportData.sids?.length === 0 ? 'major' : undefined);
    record('Airport has fixes', airportData.fixes?.length > 0,
           `${airportData.fixes?.length} fixes`,
           airportData.fixes?.length === 0 ? 'major' : undefined);
  } else {
    record('Airport data received', false, 'No airport data received from server', 'major');
  }

  // End session
  await sendMsg(ws, { type: 'sessionControl', action: 'end' });
}

async function main() {
  log('Starting mixed operations playtest...');

  const ws = new WebSocket(WS_URL);

  return new Promise<void>((resolve) => {
    ws.on('open', () => {
      log('Connected to server');
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'sessionInfo':
            sessionId = msg.session.id;
            log(`Session info: id=${msg.session.id}, status=${msg.session.status}`);
            break;
          case 'gameState':
            gameStates.push(msg.state);
            break;
          case 'alert':
            alerts.push(msg.alert);
            log(`  ALERT: ${msg.alert.type} - ${msg.alert.message}`);
            break;
          case 'commandResponse':
            commandResponses.push(msg);
            break;
          case 'radioMessage':
            radioMessages.push(msg.transmission);
            break;
          case 'airportData':
            airportData = msg.data;
            log(`Airport data received: ${msg.data.icao}`);
            break;
          case 'error':
            log(`  ERROR from server: ${msg.message}`);
            break;
          case 'scoreUpdate':
            break;
        }
      } catch (e) {
        log(`Failed to parse message: ${e}`);
      }
    });

    ws.on('error', (err) => {
      log(`WebSocket error: ${err.message}`);
      record('WebSocket connection', false, `Error: ${err.message}`, 'critical');
    });

    ws.on('close', () => {
      log('Connection closed');
    });

    // Wait for connection, then run tests
    ws.on('open', async () => {
      try {
        await runTests(ws);
      } catch (e: any) {
        log(`Test error: ${e.message}\n${e.stack}`);
        record('Test execution', false, `Error: ${e.message}`, 'critical');
      }

      // Print summary
      log('');
      log('========================================');
      log('       PLAYTEST RESULTS SUMMARY         ');
      log('========================================');

      const passed = results.filter(r => r.passed).length;
      const failed = results.filter(r => !r.passed).length;
      const criticals = results.filter(r => !r.passed && r.severity === 'critical');
      const majors = results.filter(r => !r.passed && r.severity === 'major');
      const minors = results.filter(r => !r.passed && r.severity === 'minor');

      log(`Total: ${results.length} tests, ${passed} passed, ${failed} failed`);
      log(`  Critical: ${criticals.length}, Major: ${majors.length}, Minor: ${minors.length}`);
      log('');

      if (criticals.length > 0) {
        log('--- CRITICAL ISSUES ---');
        for (const r of criticals) {
          log(`  [CRITICAL] ${r.test}: ${r.details}`);
        }
        log('');
      }

      if (majors.length > 0) {
        log('--- MAJOR ISSUES ---');
        for (const r of majors) {
          log(`  [MAJOR] ${r.test}: ${r.details}`);
        }
        log('');
      }

      if (minors.length > 0) {
        log('--- MINOR ISSUES ---');
        for (const r of minors) {
          log(`  [MINOR] ${r.test}: ${r.details}`);
        }
        log('');
      }

      log('--- ALL RESULTS ---');
      for (const r of results) {
        const status = r.passed ? 'PASS' : 'FAIL';
        const sev = r.severity ? ` [${r.severity}]` : '';
        log(`  ${status}${sev}: ${r.test} - ${r.details}`);
      }

      ws.close();
      resolve();
    });
  });
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
