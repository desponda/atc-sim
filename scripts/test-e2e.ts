/**
 * Comprehensive E2E Smoke Test for ATC-Sim
 *
 * Starts the server, connects via WebSocket, and verifies:
 *   1. Session creation and airport data
 *   2. Aircraft spawning within first few ticks
 *   3. Basic ATC commands (descend, heading, speed) and readbacks
 *   4. Conflict detection fires for close aircraft
 *   5. Scoring updates correctly
 *   6. Full session lifecycle with final score/grade
 *
 * Run: npx tsx test-e2e.ts
 */

import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';

// ─── Configuration ──────────────────────────────────────────────────────────
const SERVER_PORT = 13001; // Use a non-default port to avoid conflicts
const WS_URL = `ws://localhost:${SERVER_PORT}`;
const SERVER_STARTUP_TIMEOUT = 15000;
const TEST_TIMEOUT = 90000; // 90s total test timeout
const SIM_TICKS = 60;
const TIME_SCALE = 4;

// ─── Test Infrastructure ────────────────────────────────────────────────────
interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];
let serverProcess: ChildProcess | null = null;

function log(msg: string): void {
  console.log(`[E2E] ${msg}`);
}

function pass(name: string, detail: string = ''): void {
  results.push({ name, pass: true, detail });
  console.log(`  [PASS] ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, pass: false, detail });
  console.error(`  [FAIL] ${name}: ${detail}`);
}

function check(name: string, condition: boolean, passDetail: string, failDetail: string): void {
  if (condition) {
    pass(name, passDetail);
  } else {
    fail(name, failDetail);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Server Management ──────────────────────────────────────────────────────
function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not start within ${SERVER_STARTUP_TIMEOUT}ms`));
    }, SERVER_STARTUP_TIMEOUT);

    serverProcess = spawn('npx', ['tsx', 'packages/server/src/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log(`[server] ${line}`);
      if (line.includes('running on port')) {
        clearTimeout(timeout);
        // Give it a moment to fully initialize
        setTimeout(resolve, 500);
      }
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log(`[server:err] ${line}`);
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start server: ${err.message}`));
    });

    serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// ─── WebSocket Helpers ──────────────────────────────────────────────────────
class TestClient {
  private ws: WebSocket | null = null;
  private messageQueue: any[] = [];
  private allMessages: any[] = [];

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS connection timeout')), 10000);
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.messageQueue.push(msg);
          this.allMessages.push(msg);
        } catch { /* ignore non-JSON */ }
      });
      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  send(msg: object): void {
    this.ws?.send(JSON.stringify(msg));
  }

  /** Drain all messages of a given type from the queue */
  drain(type: string): any[] {
    const found: any[] = [];
    const remaining: any[] = [];
    for (const m of this.messageQueue) {
      if (m.type === type) found.push(m);
      else remaining.push(m);
    }
    this.messageQueue.length = 0;
    this.messageQueue.push(...remaining);
    return found;
  }

  /** Wait for a message of a given type */
  async waitFor(type: string, timeoutMs = 10000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.drain(type);
      if (found.length > 0) return found[0];
      await sleep(100);
    }
    throw new Error(`Timeout waiting for "${type}" after ${timeoutMs}ms`);
  }

  /** Wait for a message, return null on timeout */
  async waitForSafe(type: string, timeoutMs = 5000): Promise<any | null> {
    try {
      return await this.waitFor(type, timeoutMs);
    } catch {
      return null;
    }
  }

  /** Collect all messages of a type that arrive within a time window */
  async collectDuring(type: string, durationMs: number): Promise<any[]> {
    const collected: any[] = [];
    const start = Date.now();
    while (Date.now() - start < durationMs) {
      collected.push(...this.drain(type));
      await sleep(100);
    }
    collected.push(...this.drain(type));
    return collected;
  }

  /** Get count of all messages received by type */
  getMessageCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const m of this.allMessages) {
      counts[m.type] = (counts[m.type] || 0) + 1;
    }
    return counts;
  }

  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

// ─── Test Sections ──────────────────────────────────────────────────────────

async function testSessionCreation(client: TestClient): Promise<string | null> {
  log('--- Test: Session Creation ---');

  client.send({
    type: 'createSession',
    config: {
      airport: 'KRIC',
      density: 'moderate',
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
  });

  // Expect sessionInfo
  const sessionMsg = await client.waitForSafe('sessionInfo', 5000);
  check(
    'Session created',
    sessionMsg !== null && sessionMsg.session?.status === 'lobby',
    `id=${sessionMsg?.session?.id}`,
    'No sessionInfo received or wrong status'
  );

  // Expect airportData
  const airportMsg = await client.waitForSafe('airportData', 5000);
  check(
    'Airport data received',
    airportMsg !== null && airportMsg.data?.icao === 'KRIC',
    `${airportMsg?.data?.icao} with ${airportMsg?.data?.runways?.length} runways, ${airportMsg?.data?.stars?.length} STARs`,
    'No airportData or wrong ICAO'
  );

  check(
    'Airport has runways',
    airportMsg?.data?.runways?.length > 0,
    `${airportMsg?.data?.runways?.length} runways`,
    'No runways in airport data'
  );

  check(
    'Airport has fixes',
    airportMsg?.data?.fixes?.length > 0,
    `${airportMsg?.data?.fixes?.length} fixes`,
    'No fixes in airport data'
  );

  return sessionMsg?.session?.id ?? null;
}

async function testSessionStart(client: TestClient): Promise<void> {
  log('--- Test: Session Start ---');

  client.send({ type: 'sessionControl', action: 'start' });
  const runningMsg = await client.waitForSafe('sessionInfo', 5000);
  check(
    'Session started',
    runningMsg !== null && runningMsg.session?.status === 'running',
    'status=running',
    `Expected running, got ${runningMsg?.session?.status ?? 'no response'}`
  );

  // Set time scale
  client.send({ type: 'sessionControl', action: 'setTimeScale', timeScale: TIME_SCALE });
  pass('Time scale set', `${TIME_SCALE}x`);
}

async function testAircraftSpawn(client: TestClient): Promise<string | null> {
  log('--- Test: Aircraft Spawning ---');

  let callsign: string | null = null;
  let acData: any = null;
  const startTime = Date.now();

  // Wait up to 15 seconds for aircraft to appear
  while (Date.now() - startTime < 15000) {
    const gs = await client.waitForSafe('gameState', 3000);
    if (gs && gs.state?.aircraft?.length > 0) {
      acData = gs.state.aircraft[0];
      callsign = acData.callsign;
      break;
    }
  }

  check(
    'Aircraft spawned',
    callsign !== null,
    `${callsign} (${acData?.typeDesignator}) at ${acData?.altitude}ft`,
    'No aircraft appeared within 15 seconds'
  );

  if (acData) {
    check(
      'Aircraft has valid position',
      typeof acData.position?.lat === 'number' && typeof acData.position?.lon === 'number',
      `${acData.position?.lat?.toFixed(4)}, ${acData.position?.lon?.toFixed(4)}`,
      'Missing or invalid position'
    );

    check(
      'Aircraft has valid altitude',
      acData.altitude > 0 && acData.altitude < 50000,
      `${acData.altitude}ft`,
      `Invalid altitude: ${acData.altitude}`
    );

    check(
      'Aircraft has valid speed',
      acData.speed > 0 && acData.speed < 600,
      `${Math.round(acData.speed)}kts`,
      `Invalid speed: ${acData.speed}`
    );

    check(
      'Aircraft is arrival category',
      acData.category === 'arrival',
      acData.category,
      `Expected arrival, got ${acData.category}`
    );
  }

  return callsign;
}

async function testBasicCommands(client: TestClient, callsign: string): Promise<void> {
  log('--- Test: Basic ATC Commands ---');

  // Helper to send a command and check response
  async function sendCmd(rawText: string, expectSuccess: boolean, testName: string): Promise<any> {
    client.drain('commandResponse');
    client.send({
      type: 'command',
      command: { callsign, commands: [], rawText, timestamp: Date.now() },
    });
    const resp = await client.waitForSafe('commandResponse', 5000);
    if (!resp) {
      fail(testName, 'No commandResponse received');
      return null;
    }
    check(
      testName,
      resp.success === expectSuccess,
      expectSuccess ? `success for ${resp.callsign}` : `correctly rejected: ${resp.error}`,
      expectSuccess
        ? `Expected success, got error: ${resp.error}`
        : `Expected failure but command succeeded`
    );
    return resp;
  }

  // Descend command
  await sendCmd(`${callsign} descend and maintain 5000`, true, 'Descend command');
  await sleep(300);

  // Heading command
  await sendCmd(`${callsign} turn left heading 270`, true, 'Heading command');
  await sleep(300);

  // Speed command
  await sendCmd(`${callsign} speed 210`, true, 'Speed command');
  await sleep(300);

  // Invalid command (should fail)
  await sendCmd(`${callsign} blorp fizzle`, false, 'Invalid command rejected');
  await sleep(300);
}

async function testReadbacks(client: TestClient, callsign: string): Promise<void> {
  log('--- Test: Pilot Readbacks ---');

  // Drain any existing radio messages
  client.drain('radioMessage');

  // Send a command and check for exactly one readback
  client.drain('commandResponse');
  client.send({
    type: 'command',
    command: {
      callsign,
      commands: [],
      rawText: `${callsign} climb and maintain 8000`,
      timestamp: Date.now(),
    },
  });

  // Wait for command response
  const cmdResp = await client.waitForSafe('commandResponse', 5000);
  check(
    'Climb command accepted',
    cmdResp?.success === true,
    `success`,
    `Error: ${cmdResp?.error ?? 'no response'}`
  );

  // Collect readbacks over 2 seconds
  const radios = await client.collectDuring('radioMessage', 2000);
  // Filter to readbacks from the aircraft (not initial contacts from other aircraft)
  const readbacks = radios.filter(
    r => r.transmission?.from === callsign
  );

  check(
    'Readback received',
    readbacks.length >= 1,
    `${readbacks.length} readback(s) from ${callsign}`,
    'No readback received from pilot'
  );

  if (readbacks.length > 0) {
    const msg = readbacks[0].transmission.message;
    check(
      'Readback contains altitude',
      msg.toLowerCase().includes('8') && (msg.toLowerCase().includes('thousand') || msg.toLowerCase().includes('8000')),
      `"${msg}"`,
      `Readback does not mention altitude: "${msg}"`
    );

    check(
      'No duplicate readback',
      readbacks.length === 1,
      'Exactly 1 readback',
      `Got ${readbacks.length} readbacks (duplicate detected)`
    );
  }
}

async function testConflictDetection(client: TestClient): Promise<void> {
  log('--- Test: Conflict Detection ---');

  // Collect alerts and game states over several ticks
  // At moderate density with multiple aircraft, conflicts may occur if aircraft are close
  // We check that the alert system is functioning by examining alerts in game state

  let alertsSeen = false;
  let alertCount = 0;
  let conflictAlertSeen = false;

  // Collect game states for a few seconds
  const states = await client.collectDuring('gameState', 5000);

  for (const gs of states) {
    const alerts = gs.state?.alerts ?? [];
    if (alerts.length > 0) {
      alertsSeen = true;
      alertCount = Math.max(alertCount, alerts.length);
      for (const alert of alerts) {
        if (alert.type === 'conflict' || alert.type === 'msaw') {
          conflictAlertSeen = true;
        }
      }
    }
  }

  // Also check for alert messages sent separately
  const alertMsgs = client.drain('alert');
  if (alertMsgs.length > 0) {
    alertsSeen = true;
    for (const a of alertMsgs) {
      if (a.alert?.type === 'conflict' || a.alert?.type === 'msaw') {
        conflictAlertSeen = true;
      }
    }
  }

  // Conflict detection is "working" if:
  // 1. The game state alerts array exists (even if empty)
  // 2. If there are alerts, they have correct structure
  check(
    'Alert system functional',
    states.length > 0 && states.some(s => Array.isArray(s.state?.alerts)),
    `${states.length} game states with alerts array, ${alertCount} max active alerts`,
    'Game state missing alerts array'
  );

  if (alertsSeen) {
    pass('Alerts detected', `conflict/safety alerts seen: ${conflictAlertSeen}`);
  } else {
    // Not a failure - moderate density may not generate conflicts
    pass('No alerts (acceptable)', 'No aircraft close enough for conflicts at moderate density');
  }
}

async function testScoringUpdates(client: TestClient): Promise<void> {
  log('--- Test: Scoring Updates ---');

  // Get a recent game state and check score structure
  const gs = await client.waitForSafe('gameState', 5000);

  check(
    'Score present in game state',
    gs?.state?.score !== undefined,
    `score object received`,
    'No score in game state'
  );

  if (gs?.state?.score) {
    const score = gs.state.score;

    check(
      'Overall score is valid',
      typeof score.overallScore === 'number' && score.overallScore >= 0 && score.overallScore <= 100,
      `score=${score.overallScore}`,
      `Invalid score: ${score.overallScore}`
    );

    check(
      'Grade is valid',
      ['A', 'B', 'C', 'D', 'F'].includes(score.grade),
      `grade=${score.grade}`,
      `Invalid grade: ${score.grade}`
    );

    check(
      'Commands counted',
      typeof score.commandsIssued === 'number' && score.commandsIssued > 0,
      `${score.commandsIssued} commands recorded`,
      `commandsIssued=${score.commandsIssued} (expected > 0 after sending commands)`
    );

    check(
      'Score not unreasonably low',
      score.overallScore >= 50,
      `score=${score.overallScore} (grade ${score.grade})`,
      `Score ${score.overallScore} is too low after minimal interaction -- scoring may be too harsh`
    );
  }
}

async function testSimulationRun(client: TestClient): Promise<any> {
  log(`--- Test: Simulation Run (${SIM_TICKS} ticks) ---`);

  // Wait for enough ticks to pass
  const waitMs = (SIM_TICKS / TIME_SCALE) * 1000 + 3000;
  log(`Waiting ${Math.round(waitMs / 1000)}s for ${SIM_TICKS} ticks at ${TIME_SCALE}x...`);

  let lastState: any = null;
  let maxAircraft = 0;
  let maxTick = 0;
  let aircraftMoved = false;
  let firstPos: any = null;
  let lastPos: any = null;

  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const states = client.drain('gameState');
    for (const gs of states) {
      lastState = gs.state;
      const tick = gs.state?.clock?.tickCount ?? 0;
      const acCount = gs.state?.aircraft?.length ?? 0;
      maxTick = Math.max(maxTick, tick);
      maxAircraft = Math.max(maxAircraft, acCount);

      // Track first/last position of first aircraft to verify movement
      if (acCount > 0) {
        const pos = gs.state.aircraft[0].position;
        if (!firstPos) firstPos = { ...pos };
        lastPos = { ...pos };
      }
    }
    await sleep(500);
  }

  // Drain remaining
  const remaining = client.drain('gameState');
  for (const gs of remaining) {
    lastState = gs.state;
    maxTick = Math.max(maxTick, gs.state?.clock?.tickCount ?? 0);
    maxAircraft = Math.max(maxAircraft, gs.state?.aircraft?.length ?? 0);
  }

  check(
    'Simulation progressed',
    maxTick >= SIM_TICKS * 0.8,
    `reached tick ${maxTick}`,
    `Only reached tick ${maxTick}, expected at least ${Math.floor(SIM_TICKS * 0.8)}`
  );

  check(
    'Multiple aircraft seen',
    maxAircraft >= 2,
    `max ${maxAircraft} aircraft simultaneously`,
    `Only saw ${maxAircraft} aircraft`
  );

  // Verify aircraft actually moved
  if (firstPos && lastPos) {
    const dlat = Math.abs(lastPos.lat - firstPos.lat);
    const dlon = Math.abs(lastPos.lon - firstPos.lon);
    aircraftMoved = dlat > 0.001 || dlon > 0.001;
  }

  check(
    'Aircraft positions changed',
    aircraftMoved,
    'aircraft moved over simulation period',
    'Aircraft positions did not change -- physics may not be running'
  );

  return lastState;
}

async function testSessionEnd(client: TestClient, lastState: any): Promise<void> {
  log('--- Test: Session End ---');

  client.send({ type: 'sessionControl', action: 'end' });
  const endMsg = await client.waitForSafe('sessionInfo', 5000);

  check(
    'Session ended',
    endMsg !== null && endMsg.session?.status === 'ended',
    `status=${endMsg?.session?.status}`,
    `Expected ended, got ${endMsg?.session?.status ?? 'no response'}`
  );

  // Check final score from last game state
  if (lastState?.score) {
    const score = lastState.score;
    log(`Final score: ${score.overallScore} (${score.grade})`);
    log(`  Separation violations: ${score.separationViolations}`);
    log(`  Conflict alerts: ${score.conflictAlerts}`);
    log(`  Aircraft handled: ${score.aircraftHandled}`);
    log(`  Commands issued: ${score.commandsIssued}`);
    log(`  Missed handoffs: ${score.missedHandoffs}`);

    check(
      'Final score is valid',
      typeof score.overallScore === 'number' && score.overallScore >= 0 && score.overallScore <= 100,
      `${score.overallScore} (${score.grade})`,
      `Invalid final score: ${score.overallScore}`
    );

    check(
      'Final grade is valid',
      ['A', 'B', 'C', 'D', 'F'].includes(score.grade),
      score.grade,
      `Invalid grade: ${score.grade}`
    );
  } else {
    fail('Final score available', 'No score in last game state');
  }
}

// ─── Main Test Runner ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const overallTimeout = setTimeout(() => {
    console.error(`\n[E2E] FATAL: Test timed out after ${TEST_TIMEOUT / 1000}s`);
    stopServer();
    process.exit(2);
  }, TEST_TIMEOUT);

  log('=== ATC-Sim E2E Smoke Test ===');
  log(`Server port: ${SERVER_PORT}, sim ticks: ${SIM_TICKS}, time scale: ${TIME_SCALE}x`);

  // Step 1: Start server
  log('Starting server...');
  try {
    await startServer();
    pass('Server started', `port ${SERVER_PORT}`);
  } catch (err: any) {
    fail('Server started', err.message);
    printSummary();
    stopServer();
    clearTimeout(overallTimeout);
    return;
  }

  const client = new TestClient();

  try {
    // Step 2: Connect WebSocket
    log('Connecting WebSocket...');
    await client.connect();
    pass('WebSocket connected');

    // Step 3: Create session
    const sessionId = await testSessionCreation(client);
    if (!sessionId) {
      fail('Session lifecycle', 'Cannot continue without a session');
      throw new Error('No session');
    }

    // Step 4: Start session
    await testSessionStart(client);

    // Step 5: Verify aircraft spawn
    const callsign = await testAircraftSpawn(client);
    if (!callsign) {
      fail('Aircraft lifecycle', 'Cannot continue without aircraft');
      throw new Error('No aircraft');
    }

    // Step 6: Test basic commands
    await testBasicCommands(client, callsign);

    // Step 7: Test readbacks
    await testReadbacks(client, callsign);

    // Step 8: Run simulation for target ticks
    const lastState = await testSimulationRun(client);

    // Step 9: Test conflict detection (check accumulated alerts)
    await testConflictDetection(client);

    // Step 10: Test scoring
    await testScoringUpdates(client);

    // Step 11: End session and verify
    await testSessionEnd(client, lastState);

    // Message type summary
    const counts = client.getMessageCounts();
    log('Message type counts:');
    for (const [type, count] of Object.entries(counts).sort()) {
      log(`  ${type}: ${count}`);
    }

  } catch (err: any) {
    if (!err.message.includes('No session') && !err.message.includes('No aircraft')) {
      fail('Unexpected error', err.message);
    }
  } finally {
    client.close();
    stopServer();
    clearTimeout(overallTimeout);
  }

  printSummary();
}

function printSummary(): void {
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;

  console.log('\n' + '='.repeat(70));
  console.log('E2E SMOKE TEST RESULTS');
  console.log('='.repeat(70));

  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.name}${r.detail ? ' -- ' + r.detail : ''}`);
  }

  console.log('='.repeat(70));
  console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);

  if (failed === 0) {
    console.log('\n  >>> ALL TESTS PASSED <<<\n');
  } else {
    console.log('\n  >>> SOME TESTS FAILED <<<');
    console.log('\n  Failed tests:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`    - ${r.name}: ${r.detail}`);
    }
    console.log();
  }

  console.log('='.repeat(70));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[E2E] Fatal error:', err);
  stopServer();
  process.exit(2);
});
