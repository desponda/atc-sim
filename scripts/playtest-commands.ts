/**
 * Exhaustive Command Playtest for ATC-Sim
 *
 * Tests EVERY command type (natural language + shorthand), partial callsign
 * matching, and error cases against a live game session.
 */

import { WebSocket } from 'ws';

const WS_URL = 'ws://localhost:3001';
const TIMEOUT_MS = 60000; // 60s overall
const CMD_DELAY_MS = 300;  // delay between commands

// ─── Result tracking ─────────────────────────────────────────────────────────

interface TestResult {
  category: string;
  command: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function log(msg: string): void {
  console.log(`[TEST] ${msg}`);
}

function record(category: string, command: string, pass: boolean, detail: string): void {
  results.push({ category, command, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${category} | ${command} => ${detail}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main test runner ────────────────────────────────────────────────────────

async function runTest(): Promise<void> {
  log(`Connecting to ${WS_URL}`);

  const ws = new WebSocket(WS_URL);
  const messageQueue: any[] = [];
  let wsReady = false;

  // Collect messages
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      messageQueue.push(msg);
    } catch {
      // ignore
    }
  });

  // Wait for open
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      wsReady = true;
      resolve();
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 10000);
  });

  log('Connected');

  // Helper: drain messages of a specific type
  function drainType(type: string): any[] {
    const found: any[] = [];
    const remaining: any[] = [];
    for (const m of messageQueue) {
      if (m.type === type) found.push(m);
      else remaining.push(m);
    }
    messageQueue.length = 0;
    messageQueue.push(...remaining);
    return found;
  }

  // Helper: wait for a message of a given type
  async function waitForType(type: string, timeoutMs = 10000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = drainType(type);
      if (found.length > 0) return found[0];
      await sleep(100);
    }
    throw new Error(`Timeout waiting for message type "${type}"`);
  }

  // Helper: wait for message type, return null on timeout
  async function waitForTypeSafe(type: string, timeoutMs = 5000): Promise<any | null> {
    try {
      return await waitForType(type, timeoutMs);
    } catch {
      return null;
    }
  }

  // ─── Step 1: Create session ──────────────────────────────────────────────
  log('Creating session...');
  ws.send(JSON.stringify({
    type: 'createSession',
    config: {
      airport: 'KRIC',
      density: 'heavy',
      scenarioType: 'arrivals',
      runwayConfig: {
        arrivalRunways: ['16'],
        departureRunways: ['16'],
      },
      weather: {
        winds: [
          { altitude: 0, direction: 180, speed: 8, gusts: null },
          { altitude: 5000, direction: 200, speed: 15, gusts: null },
          { altitude: 10000, direction: 220, speed: 25, gusts: null },
        ],
        altimeter: 29.92,
        temperature: 20,
        visibility: 10,
        ceiling: null,
        atisLetter: 'A',
      },
    },
  }));

  const sessionInfo = await waitForType('sessionInfo');
  log(`Session created: ${sessionInfo.session.id}`);

  // ─── Step 2: Start session ───────────────────────────────────────────────
  log('Starting session...');
  ws.send(JSON.stringify({ type: 'sessionControl', action: 'start' }));
  await waitForType('sessionInfo');
  log('Session started');

  // Speed up time
  ws.send(JSON.stringify({ type: 'sessionControl', action: 'setTimeScale', timeScale: 4 }));

  // ─── Step 3: Wait for aircraft ───────────────────────────────────────────
  log('Waiting for aircraft to spawn...');
  let callsign: string | null = null;
  let acData: any = null;
  const spawnStart = Date.now();

  while (Date.now() - spawnStart < 30000) {
    const gs = await waitForTypeSafe('gameState', 3000);
    if (gs && gs.state?.aircraft?.length > 0) {
      acData = gs.state.aircraft[0];
      callsign = acData.callsign;
      log(`Aircraft spawned: ${callsign} (${acData.typeDesignator}) at ${acData.altitude}ft hdg=${Math.round(acData.heading)} spd=${Math.round(acData.speed)} phase=${acData.flightPhase}`);
      break;
    }
  }

  if (!callsign) {
    record('SETUP', 'Wait for aircraft', false, 'No aircraft spawned within 30s');
    ws.close();
    printSummary();
    return;
  }

  record('SETUP', 'Aircraft spawn', true, `${callsign} (${acData.typeDesignator})`);

  // ─── Helper: Send a command and check response ───────────────────────────
  async function sendCommand(
    category: string,
    rawText: string,
    expectSuccess: boolean,
    extraCheck?: (resp: any) => string | null
  ): Promise<any> {
    // drain any old commandResponse
    drainType('commandResponse');

    ws.send(JSON.stringify({
      type: 'command',
      command: {
        callsign: callsign!,
        commands: [],
        rawText,
        timestamp: Date.now(),
      },
    }));

    const resp = await waitForTypeSafe('commandResponse', 5000);

    if (!resp) {
      record(category, rawText, false, 'No commandResponse received');
      return null;
    }

    if (expectSuccess) {
      if (resp.success) {
        let detail = `success, callsign=${resp.callsign}`;
        if (extraCheck) {
          const issue = extraCheck(resp);
          if (issue) {
            record(category, rawText, false, issue);
            return resp;
          }
        }
        record(category, rawText, true, detail);
      } else {
        record(category, rawText, false, `Expected success but got error: ${resp.error}`);
      }
    } else {
      // Expect failure
      if (!resp.success) {
        record(category, rawText, true, `Correctly rejected: ${resp.error}`);
      } else {
        record(category, rawText, false, `Expected failure but command succeeded`);
      }
    }

    await sleep(CMD_DELAY_MS);
    return resp;
  }

  // ─── SECTION 1: Natural language altitude commands ───────────────────────
  log('\n=== ALTITUDE COMMANDS ===');
  await sendCommand('Altitude', `${callsign} climb and maintain 10000`, true);
  await sendCommand('Altitude', `${callsign} descend and maintain 5000`, true);
  await sendCommand('Altitude', `${callsign} maintain 7000`, true);
  await sendCommand('Altitude', `${callsign} climb to 9000`, true);
  await sendCommand('Altitude', `${callsign} descend to 4000`, true);
  await sendCommand('Altitude', `${callsign} descend and maintain FL350`, true);

  // ─── SECTION 2: Natural language heading commands ────────────────────────
  log('\n=== HEADING COMMANDS ===');
  await sendCommand('Heading', `${callsign} turn left heading 270`, true);
  await sendCommand('Heading', `${callsign} turn right heading 090`, true);
  await sendCommand('Heading', `${callsign} fly heading 180`, true);
  await sendCommand('Heading', `${callsign} heading 360`, true);

  // ─── SECTION 3: Natural language speed commands ──────────────────────────
  log('\n=== SPEED COMMANDS ===');
  await sendCommand('Speed', `${callsign} reduce speed to 180`, true);
  await sendCommand('Speed', `${callsign} resume normal speed`, true);
  await sendCommand('Speed', `${callsign} speed 210`, true);
  await sendCommand('Speed', `${callsign} increase speed 250`, true);

  // ─── SECTION 4: Approach clearances ──────────────────────────────────────
  log('\n=== APPROACH COMMANDS ===');
  await sendCommand('Approach', `${callsign} cleared ILS runway 16 approach`, true);
  await sendCommand('Approach', `${callsign} cleared RNAV runway 16 approach`, true);
  await sendCommand('Approach', `${callsign} cleared visual approach runway 16`, true);

  // ─── SECTION 5: Direct-to commands ───────────────────────────────────────
  log('\n=== DIRECT COMMANDS ===');
  await sendCommand('Direct', `${callsign} proceed direct CAMRN`, true);
  await sendCommand('Direct', `${callsign} direct CAMRN`, true);

  // ─── SECTION 6: Expect commands ──────────────────────────────────────────
  log('\n=== EXPECT COMMANDS ===');
  await sendCommand('Expect', `${callsign} expect ILS runway 16 approach`, true);
  await sendCommand('Expect', `${callsign} expect RNAV runway 16 approach`, true);
  await sendCommand('Expect', `${callsign} expect runway 16`, true);
  await sendCommand('Expect', `${callsign} expect visual approach runway 16`, true);

  // ─── SECTION 7: Hold commands ────────────────────────────────────────────
  log('\n=== HOLD COMMANDS ===');
  await sendCommand('Hold', `${callsign} hold at CAMRN as published`, true);
  await sendCommand('Hold', `${callsign} hold at CAMRN`, true);

  // ─── SECTION 8: Descend via STAR / Climb via SID ─────────────────────────
  log('\n=== STAR/SID COMMANDS ===');
  await sendCommand('STAR/SID', `${callsign} descend via STAR`, true);
  await sendCommand('STAR/SID', `${callsign} descend via the STAR`, true);
  await sendCommand('STAR/SID', `${callsign} climb via SID`, true);

  // ─── SECTION 9: Go around ───────────────────────────────────────────────
  log('\n=== GO AROUND COMMANDS ===');
  await sendCommand('GoAround', `${callsign} go around`, true);
  await sendCommand('GoAround', `${callsign} missed approach`, true);

  // ─── SECTION 10: Handoff / Contact ───────────────────────────────────────
  log('\n=== HANDOFF COMMANDS ===');
  // Handoff may fail if aircraft is already handed off - we test parsing works
  await sendCommand('Handoff', `${callsign} contact tower 118.3`, true);

  // Need to wait for new aircraft or test separately - handoff marks aircraft
  // Wait for a fresh gameState with aircraft
  await sleep(2000);
  drainType('gameState'); // clear queue
  const gs2 = await waitForTypeSafe('gameState', 5000);
  let callsign2: string | null = null;
  if (gs2 && gs2.state?.aircraft?.length > 0) {
    // Find an aircraft that is not being handed off
    for (const ac of gs2.state.aircraft) {
      if (!ac.handingOff && ac.callsign !== callsign) {
        callsign2 = ac.callsign;
        break;
      }
      if (!ac.handingOff) {
        callsign2 = ac.callsign;
      }
    }
    if (!callsign2) {
      // Use original if still active
      callsign2 = gs2.state.aircraft[0].callsign;
    }
    callsign = callsign2;
    log(`Using aircraft ${callsign} for remaining tests`);
  }

  // ─── SECTION 11: Resume own navigation ──────────────────────────────────
  log('\n=== RESUME OWN NAV ===');
  await sendCommand('ResumeNav', `${callsign} resume own navigation`, true);

  // ─── SECTION 12: Shorthand commands ──────────────────────────────────────
  log('\n=== SHORTHAND COMMANDS ===');
  await sendCommand('Shorthand', `${callsign} dm 5000`, true);
  await sendCommand('Shorthand', `${callsign} cm 10000`, true);
  await sendCommand('Shorthand', `${callsign} tlh 270`, true);
  await sendCommand('Shorthand', `${callsign} trh 090`, true);
  await sendCommand('Shorthand', `${callsign} tl 180`, true);
  await sendCommand('Shorthand', `${callsign} tr 045`, true);
  await sendCommand('Shorthand', `${callsign} fh 180`, true);
  await sendCommand('Shorthand', `${callsign} h 270`, true);
  await sendCommand('Shorthand', `${callsign} s 180`, true);
  await sendCommand('Shorthand', `${callsign} ci16`, true);
  await sendCommand('Shorthand', `${callsign} cr16`, true);
  await sendCommand('Shorthand', `${callsign} cv16`, true);
  await sendCommand('Shorthand', `${callsign} pd CAMRN`, true);
  await sendCommand('Shorthand', `${callsign} ct 118.3`, true);

  // Need fresh aircraft again after handoff
  await sleep(2000);
  drainType('gameState');
  const gs3 = await waitForTypeSafe('gameState', 5000);
  if (gs3 && gs3.state?.aircraft?.length > 0) {
    for (const ac of gs3.state.aircraft) {
      if (!ac.handingOff) {
        callsign = ac.callsign;
        break;
      }
    }
    log(`Using aircraft ${callsign} for remaining tests`);
  }

  await sendCommand('Shorthand', `${callsign} ga`, true);

  // ─── SECTION 13: Partial callsign matching ──────────────────────────────
  log('\n=== PARTIAL CALLSIGN MATCHING ===');
  // Get a fresh aircraft callsign
  drainType('gameState');
  const gs4 = await waitForTypeSafe('gameState', 5000);
  if (gs4 && gs4.state?.aircraft?.length > 0) {
    for (const ac of gs4.state.aircraft) {
      if (!ac.handingOff) {
        callsign = ac.callsign;
        break;
      }
    }
  }

  if (callsign && callsign.length >= 4) {
    // Try just the numeric part (last 3-4 chars)
    const numericPart = callsign.replace(/^[A-Z]+/, '');
    if (numericPart.length >= 3) {
      // Partial match by airline prefix + partial number
      const partial = callsign.substring(0, callsign.length - 1);
      drainType('commandResponse');
      ws.send(JSON.stringify({
        type: 'command',
        command: {
          callsign: partial,
          commands: [],
          rawText: `${partial} dm 5000`,
          timestamp: Date.now(),
        },
      }));

      const partialResp = await waitForTypeSafe('commandResponse', 5000);
      if (partialResp) {
        if (partialResp.success) {
          record('Partial Callsign', `${partial} dm 5000 (partial of ${callsign})`, true,
            `Matched to ${partialResp.callsign}`);
        } else {
          record('Partial Callsign', `${partial} dm 5000 (partial of ${callsign})`, false,
            `Error: ${partialResp.error}`);
        }
      } else {
        record('Partial Callsign', `${partial} dm 5000`, false, 'No response');
      }
      await sleep(CMD_DELAY_MS);
    }
  }

  // ─── SECTION 14: Error cases ────────────────────────────────────────────
  log('\n=== ERROR CASES ===');

  // Empty command
  drainType('commandResponse');
  ws.send(JSON.stringify({
    type: 'command',
    command: {
      callsign: '',
      commands: [],
      rawText: '',
      timestamp: Date.now(),
    },
  }));
  const emptyResp = await waitForTypeSafe('commandResponse', 5000);
  if (emptyResp) {
    if (!emptyResp.success) {
      record('Error', '(empty command)', true, `Correctly rejected: ${emptyResp.error}`);
    } else {
      record('Error', '(empty command)', false, 'Should have been rejected');
    }
  } else {
    // May get an 'error' message instead
    const errMsg = drainType('error');
    if (errMsg.length > 0) {
      record('Error', '(empty command)', true, `Got error msg: ${errMsg[0].message}`);
    } else {
      record('Error', '(empty command)', false, 'No response at all');
    }
  }
  await sleep(CMD_DELAY_MS);

  // Invalid callsign
  await sendCommand('Error', `ZZZZZ99 descend and maintain 5000`, false);

  // Callsign only, no command
  drainType('commandResponse');
  ws.send(JSON.stringify({
    type: 'command',
    command: {
      callsign: callsign!,
      commands: [],
      rawText: `${callsign}`,
      timestamp: Date.now(),
    },
  }));
  const csOnlyResp = await waitForTypeSafe('commandResponse', 5000);
  if (csOnlyResp) {
    if (!csOnlyResp.success) {
      record('Error', `${callsign} (callsign only)`, true, `Correctly rejected: ${csOnlyResp.error}`);
    } else {
      record('Error', `${callsign} (callsign only)`, false, 'Should have been rejected');
    }
  } else {
    record('Error', `${callsign} (callsign only)`, false, 'No response');
  }
  await sleep(CMD_DELAY_MS);

  // Gibberish command
  await sendCommand('Error', `${callsign} blorp fizzle quantum`, false);

  // Invalid altitude (negative)
  await sendCommand('Error', `${callsign} descend and maintain -500`, false);

  // Invalid heading (>360)
  await sendCommand('Error', `${callsign} fly heading 999`, false);

  // Invalid heading (0)
  await sendCommand('Error', `${callsign} fly heading 0`, false);

  // ─── SECTION 15: Multi-command (comma separated) ────────────────────────
  log('\n=== MULTI-COMMAND ===');
  await sendCommand('Multi', `${callsign} dm 6000, tlh 270`, true);
  await sendCommand('Multi', `${callsign} cm 8000, s 210`, true);

  // ─── Done ────────────────────────────────────────────────────────────────
  ws.close();
  printSummary();
}

function printSummary(): void {
  console.log('\n' + '='.repeat(80));
  console.log('EXHAUSTIVE COMMAND TEST RESULTS');
  console.log('='.repeat(80));

  // Group by category
  const categories = new Map<string, TestResult[]>();
  for (const r of results) {
    const list = categories.get(r.category) || [];
    list.push(r);
    categories.set(r.category, list);
  }

  let totalPass = 0;
  let totalFail = 0;

  for (const [cat, tests] of categories) {
    const catPass = tests.filter(t => t.pass).length;
    const catFail = tests.filter(t => !t.pass).length;
    totalPass += catPass;
    totalFail += catFail;

    console.log(`\n--- ${cat} (${catPass}/${tests.length} passed) ---`);
    for (const t of tests) {
      const tag = t.pass ? 'PASS' : 'FAIL';
      console.log(`  [${tag}] ${t.command}`);
      if (!t.pass) {
        console.log(`         => ${t.detail}`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`TOTAL: ${totalPass + totalFail} tests | ${totalPass} PASSED | ${totalFail} FAILED`);
  console.log('='.repeat(80));

  if (totalFail > 0) {
    console.log('\nFAILED COMMANDS:');
    for (const r of results) {
      if (!r.pass) {
        console.log(`  [${r.category}] ${r.command} => ${r.detail}`);
      }
    }
    console.log();
  }

  if (totalFail > 0) {
    process.exit(1);
  }
}

runTest().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
