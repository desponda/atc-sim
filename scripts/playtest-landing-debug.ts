/**
 * Focused Landing Debug Playtest
 *
 * Spawns a single aircraft already established on the ILS RWY 16 glideslope
 * at ~8nm from the threshold, then logs every tick with detailed approach
 * data so we can trace exactly what happens through landing.
 *
 * No ATC commands needed — the aircraft should fly the ILS to touchdown.
 */

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3001';

interface Aircraft {
  id: string;
  callsign: string;
  typeDesignator: string;
  altitude: number;
  heading: number;
  speed: number;
  groundspeed: number;
  verticalSpeed: number;
  flightPhase: string;
  category: string;
  position: { lat: number; lon: number };
  clearances: {
    altitude: number | null;
    heading: number | null;
    approach: { type: string; runway: string } | null;
    handoffFrequency: number | null;
  };
  onLocalizer: boolean;
  onGlideslope: boolean;
  handingOff: boolean;
  targetAltitude: number;
  targetHeading: number;
  targetSpeed: number;
  onGround: boolean;
}

interface GameState {
  sessionId: string;
  aircraft: Aircraft[];
  clock: { tickCount: number };
}

// KRIC RWY 16 geometry
const THRESHOLD_LAT = 37.516636;
const THRESHOLD_LON = -77.323578;
const RUNWAY_ELEV = 167;

function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function gsAltAt(distNmVal: number): number {
  return RUNWAY_ELEV + Math.tan(3.0 * Math.PI / 180) * distNmVal * 6076.12;
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

async function main(): Promise<void> {
  console.log('=== LANDING DEBUG PLAYTEST ===');
  console.log('Spawning single aircraft on ILS RWY 16 final at ~8nm\n');

  const ws = await connect();
  let currentTick = 0;
  let sessionStarted = false;
  let commandIssued = false;
  let landed = false;
  let missedApproach = false;
  let ticksOnApproach = 0;
  let lastPhase = '';
  const cmdState = new Map<string, { stage: number; lastCmdTick: number }>();

  function issueCmd(ws2: WebSocket, callsign: string, rawText: string): void {
    send(ws2, {
      type: 'command',
      command: { callsign, commands: [], rawText, timestamp: Date.now() },
    });
  }

  function bearingTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const la1 = lat1 * Math.PI / 180, la2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360;
  }

  function headingDiff2(a: number, b: number): number {
    let d = b - a;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  const tickLog: string[] = [];

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === 'gameState') {
      currentTick = msg.state.clock.tickCount;
      const aircraft = msg.state.aircraft as Aircraft[];

      // Find our test aircraft
      const testAc = aircraft.find(a => a.category === 'arrival');
      if (!testAc) {
        if (currentTick > 5 && currentTick % 10 === 0) {
          console.log(`[Tick ${currentTick}] No arrival aircraft found (${aircraft.length} total)`);
        }
        return;
      }

      // Sequenced command pipeline:
      // 1. Descend to 3000
      // 2. Wait until below 5000 and within 20nm, then give intercept heading
      // 3. After heading, clear approach
      // 4. After established, hand off to tower
      if (!commandIssued) {
        const info = cmdState.get(testAc.callsign) || { stage: 0, lastCmdTick: 0 };
        cmdState.set(testAc.callsign, info);
        
        if (currentTick - info.lastCmdTick < 3) return; // cooldown

        if (info.stage === 0) {
          console.log(`[Tick ${currentTick}] Stage 0: Descend to 3000`);
          issueCmd(ws, testAc.callsign, `${testAc.callsign} descend and maintain 3000`);
          info.stage = 1;
          info.lastCmdTick = currentTick;
          return;
        }
        if (info.stage === 1 && testAc.altitude < 6000 && distToTh < 20) {
          // Give intercept heading based on position relative to localizer
          const brgToTh = bearingTo(testAc.position.lat, testAc.position.lon, THRESHOLD_LAT, THRESHOLD_LON);
          // Figure out which side of the localizer we're on
          const locCourse = 157;
          const brgDiff = headingDiff2(locCourse, brgToTh);
          // If right of localizer, give heading left of loc; if left, right
          const interceptHdg = brgDiff > 0 ? locCourse + 20 : locCourse - 20;
          const rounded = Math.round(((interceptHdg % 360) + 360) % 360);
          console.log(`[Tick ${currentTick}] Stage 1: Intercept heading ${rounded} (brgToTh=${brgToTh.toFixed(0)}, brgDiff=${brgDiff.toFixed(0)})`);
          issueCmd(ws, testAc.callsign, `${testAc.callsign} fly heading ${rounded}`);
          info.stage = 2;
          info.lastCmdTick = currentTick;
          return;
        }
        if (info.stage === 2) {
          console.log(`[Tick ${currentTick}] Stage 2: Clear ILS approach`);
          issueCmd(ws, testAc.callsign, `${testAc.callsign} cleared ILS runway 16 approach`);
          info.stage = 3;
          info.lastCmdTick = currentTick;
          commandIssued = true;
          return;
        }
      }

      const distToTh = distNm(testAc.position.lat, testAc.position.lon, THRESHOLD_LAT, THRESHOLD_LON);
      const gsAlt = gsAltAt(distToTh);
      const agl = testAc.altitude - RUNWAY_ELEV;
      const gsDeviation = testAc.altitude - gsAlt;

      // Phase change detection
      if (testAc.flightPhase !== lastPhase) {
        console.log(`\n>>> PHASE CHANGE: ${lastPhase || 'none'} -> ${testAc.flightPhase} at tick ${currentTick} <<<\n`);
        lastPhase = testAc.flightPhase;
        if (testAc.flightPhase === 'landed') landed = true;
        if (testAc.flightPhase === 'missed') missedApproach = true;
      }

      if (testAc.clearances.approach || testAc.onLocalizer || testAc.flightPhase === 'final') {
        ticksOnApproach++;
      }

      // Log EVERY tick once on approach or close
      if (commandIssued && (distToTh < 15 || testAc.clearances.approach)) {
        const line = [
          `T${String(currentTick).padStart(4, '0')}`,
          `${testAc.callsign}`,
          `alt=${Math.round(testAc.altitude)}`,
          `agl=${Math.round(agl)}`,
          `tgtAlt=${Math.round(testAc.targetAltitude)}`,
          `GS=${gsAlt.toFixed(0)}`,
          `gsDev=${gsDeviation > 0 ? '+' : ''}${gsDeviation.toFixed(0)}`,
          `VS=${Math.round(testAc.verticalSpeed)}`,
          `dist=${distToTh.toFixed(2)}nm`,
          `hdg=${Math.round(testAc.heading)}`,
          `spd=${Math.round(testAc.speed)}`,
          `gs=${Math.round(testAc.groundspeed || 0)}`,
          `loc=${testAc.onLocalizer}`,
          `onGS=${testAc.onGlideslope}`,
          `phase=${testAc.flightPhase}`,
          testAc.onGround ? 'ON_GROUND' : '',
        ].filter(Boolean).join(' | ');

        console.log(line);
        tickLog.push(line);
      }

      // End conditions
      if (landed) {
        console.log('\n=== SUCCESS: AIRCRAFT LANDED ===');
        console.log(`Landed at tick ${currentTick}, after ${ticksOnApproach} ticks on approach`);
        setTimeout(() => {
          ws.close();
          process.exit(0);
        }, 500);
      }
      if (missedApproach) {
        console.log('\n=== FAILURE: MISSED APPROACH ===');
        console.log(`Went missed at tick ${currentTick}`);
        console.log('Last 10 ticks before missed:');
        for (const line of tickLog.slice(-10)) {
          console.log(`  ${line}`);
        }
        setTimeout(() => {
          ws.close();
          process.exit(1);
        }, 500);
      }
    }

    if (msg.type === 'commandResponse') {
      const status = msg.success ? 'OK' : `FAIL: ${msg.error}`;
      console.log(`[CMD] "${msg.rawText}" -> ${status}`);
    }
  });

  // Create session
  send(ws, {
    type: 'createSession',
    config: {
      airport: 'KRIC',
      density: 'light',
      scenarioType: 'arrivals',
      runwayConfig: { arrivalRunways: ['16'], departureRunways: ['16'] },
      weather: {
        winds: [{ altitude: 0, direction: 160, speed: 5, gusts: null }],
        altimeter: 29.92,
        temperature: 15,
        visibility: 10,
        ceiling: null,
        atisLetter: 'A',
      },
    },
  });

  await delay(300);
  send(ws, { type: 'sessionControl', action: 'start' });
  sessionStarted = true;
  await delay(300);
  // Use 2x speed for reasonable pace
  send(ws, { type: 'sessionControl', action: 'setTimeScale', timeScale: 2 });

  // Wait up to 5 minutes real time (600 ticks at 2x)
  await delay(300_000);

  if (!landed && !missedApproach) {
    console.log('\n=== TIMEOUT: No landing or missed approach after 5 min ===');
    console.log(`Last tick: ${currentTick}, ticks on approach: ${ticksOnApproach}`);
  }

  ws.close();
  process.exit(landed ? 0 : 1);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
