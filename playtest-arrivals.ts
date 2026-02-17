/**
 * Playtest Script: Heavy Arrivals at KRIC
 *
 * Simulates an expert TRACON controller handling heavy arrival traffic.
 * Connects via WebSocket, creates a session, issues ATC commands to
 * vector arrivals to the ILS Runway 16 approach at KRIC.
 */

import WebSocket from 'ws';

// ─── Configuration ───────────────────────────────────────────────────────────
const WS_URL = 'ws://localhost:3001';
const SIM_DURATION_TICKS = 600; // ~10 minutes of sim time
const TIME_SCALE = 4;

// KRIC RWY 16 approach parameters
const RWY_16_COURSE = 161;
const TOWER_FREQ = 118.3;
const AIRPORT_LAT = 37.5052;
const AIRPORT_LON = -77.3197;

// ─── Types (minimal) ─────────────────────────────────────────────────────────
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
  flightPlan: {
    star: string | null;
    runway: string | null;
  };
}

interface GameState {
  sessionId: string;
  aircraft: Aircraft[];
  clock: {
    time: number;
    timeScale: number;
    tickCount: number;
    running: boolean;
  };
  alerts: Array<{ id: string; type: string; severity: string; message: string; aircraftIds: string[] }>;
  score: {
    separationViolations: number;
    conflictAlerts: number;
    aircraftHandled: number;
    commandsIssued: number;
    overallScore: number;
    grade: string;
    averageDelay: number;
  };
}

// ─── Tracking State ──────────────────────────────────────────────────────────
interface AircraftTracking {
  callsign: string;
  category: string;
  firstSeenTick: number;
  lastSeenTick: number;
  commandsIssued: string[];
  commandResults: Array<{ cmd: string; success: boolean; error?: string; tick: number }>;
  phases: string[];
  altitudes: number[];
  positions: Array<{ lat: number; lon: number }>;
  wasOnLocalizer: boolean;
  wasOnGlideslope: boolean;
  wasHandedOff: boolean;
  landed: boolean;
  removed: boolean;
  // Command stages
  descendedTo6000: boolean;
  vectoredBase: boolean;
  clearedApproach: boolean;
  handedOff: boolean;
  descendedTo3000: boolean;
  speedReduced: boolean;
}

const tracking = new Map<string, AircraftTracking>();
const allCommandResponses: Array<{ tick: number; cmd: string; success: boolean; callsign: string; error?: string }> = [];
const radioMessages: Array<{ tick: number; from: string; message: string }> = [];
const alertLog: Array<{ tick: number; type: string; severity: string; message: string }> = [];
const issues: Array<{ severity: string; title: string; description: string; detail: string; file?: string }> = [];

let currentTick = 0;
let latestState: GameState | null = null;
let sessionStarted = false;
let previousCallsigns = new Set<string>();

// ─── WebSocket Connection ────────────────────────────────────────────────────
function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => {
      console.log('[PLAYTEST] Connected to server');
      resolve(ws);
    });
    ws.on('error', (err) => {
      console.error('[PLAYTEST] Connection error:', err.message);
      reject(err);
    });
  });
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

// ─── Command Helpers ─────────────────────────────────────────────────────────
function issueCommand(ws: WebSocket, callsign: string, rawText: string): void {
  send(ws, {
    type: 'command',
    command: {
      callsign,
      commands: [],
      rawText,
      timestamp: Date.now(),
    },
  });

  const t = tracking.get(callsign);
  if (t) {
    t.commandsIssued.push(rawText);
  }
}

// ─── Distance calculation ────────────────────────────────────────────────────
function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065; // nm
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── ATC Logic ───────────────────────────────────────────────────────────────

// RWY 16 geometry: localizer course 157, threshold at 37.516636, -77.323578
// The approach comes from the NORTH (aircraft fly SSE on course 157).
const THRESHOLD_LAT = 37.516636;
const THRESHOLD_LON = -77.323578;
const LOC_COURSE = 157;
const LOC_RECIPROCAL = 337; // approach side bearing
const DEG = Math.PI / 180;

// Minimum ticks between heading commands to the same aircraft
const HEADING_COOLDOWN = 25;
// Minimum ticks between any commands to the same aircraft
const CMD_COOLDOWN = 5;

function bearingTo(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const dLon = (toLon - fromLon) * DEG;
  const lat1 = fromLat * DEG;
  const lat2 = toLat * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  let brng = Math.atan2(y, x) * 180 / Math.PI;
  return ((brng % 360) + 360) % 360;
}

function normalizeHdg(h: number): number {
  return ((h % 360) + 360) % 360 || 360;
}

function headingDiff(a: number, b: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Compute aircraft position relative to the RWY 16 localizer centerline.
 * Returns:
 *   alongTrack: nm in front of threshold (positive = approach side)
 *   crossTrack: nm from centerline (positive = right/east, negative = left/west)
 */
function localizerGeometry(lat: number, lon: number) {
  const distToTh = distNm(lat, lon, THRESHOLD_LAT, THRESHOLD_LON);
  const brgFromTh = bearingTo(THRESHOLD_LAT, THRESHOLD_LON, lat, lon);
  // Angle between the reciprocal course (337°) and bearing from threshold to aircraft
  let angleDiff = headingDiff(LOC_RECIPROCAL, brgFromTh);
  // alongTrack: projection along the centerline (positive = approach side)
  const alongTrack = distToTh * Math.cos(angleDiff * DEG);
  // crossTrack: perpendicular offset (positive = right/east of course 157)
  const crossTrack = distToTh * Math.sin(angleDiff * DEG);
  return { alongTrack, crossTrack, distToTh };
}

/**
 * Calculate a point on the extended centerline at a given distance from threshold.
 * dist > 0 means on the approach side (north for RWY 16).
 */
function pointOnCenterline(distFromThreshold: number): { lat: number; lon: number } {
  const lat = THRESHOLD_LAT + (distFromThreshold / 60) * Math.cos(LOC_RECIPROCAL * DEG);
  const lon = THRESHOLD_LON + (distFromThreshold / 60) * Math.sin(LOC_RECIPROCAL * DEG) / Math.cos(THRESHOLD_LAT * DEG);
  return { lat, lon };
}

function controlAircraft(ws: WebSocket, ac: Aircraft): void {
  if (ac.category !== 'arrival') return;
  if (ac.handingOff) return;
  if (ac.flightPhase === 'landed') return;

  const t = getOrCreateTracking(ac) as AircraftTracking & {
    interceptHeadingGiven?: boolean;
    interceptHeadingTick?: number;
    lastCmdTick?: number;
    lastHdgTick?: number;
    lastHdgIssued?: number;
  };

  // Command cooldown: don't spam commands
  if (t.lastCmdTick && currentTick - t.lastCmdTick < CMD_COOLDOWN) return;

  const { alongTrack, crossTrack, distToTh } = localizerGeometry(ac.position.lat, ac.position.lon);
  const absXtk = Math.abs(crossTrack);
  const onApproachSide = alongTrack > 1; // must be at least 1nm in front

  function cmd(text: string): void {
    issueCommand(ws, ac.callsign, `${ac.callsign} ${text}`);
    t.lastCmdTick = currentTick;
  }

  /** Issue a heading command with longer cooldown, skip if heading unchanged */
  function hdgCmd(hdg: number): boolean {
    if (t.lastHdgTick && currentTick - t.lastHdgTick < HEADING_COOLDOWN) return false;
    const rounded = Math.round(hdg);
    if (t.lastHdgIssued && Math.abs(rounded - t.lastHdgIssued) < 5) return false;
    cmd(`fly heading ${rounded}`);
    t.lastHdgTick = currentTick;
    t.lastHdgIssued = rounded;
    return true;
  }

  // ── Stage 1: Altitude management ──────────────────────────────────────────
  if (ac.altitude > 7000 && !t.descendedTo6000) {
    cmd('descend and maintain 6000');
    t.descendedTo6000 = true;
    return;
  }
  if (!t.descendedTo6000 && ac.altitude <= 7000) {
    t.descendedTo6000 = true;
  }

  // ── Stage 2: Position toward approach side ────────────────────────────────
  // If not on the approach side, or too far from the centerline, vector toward
  // a point ~14nm from threshold on the extended centerline.
  // Uses hdgCmd with longer cooldown to avoid spamming.
  if (t.descendedTo6000 && !t.vectoredBase) {
    if (!onApproachSide || absXtk > 8 || alongTrack < 8) {
      const target = pointOnCenterline(14);
      const brg = bearingTo(ac.position.lat, ac.position.lon, target.lat, target.lon);
      hdgCmd(normalizeHdg(brg));
      return;
    }
    // Aircraft is now on approach side, within 8nm of centerline, 8+ nm out
    t.vectoredBase = true;
  }

  // ── Stage 3: Descend to approach altitude ─────────────────────────────────
  if (t.vectoredBase && !t.descendedTo3000 && ac.altitude > 3500) {
    cmd('descend and maintain 3000');
    t.descendedTo3000 = true;
    return;
  }
  if (!t.descendedTo3000 && ac.altitude <= 3500) {
    t.descendedTo3000 = true;
  }

  // ── Stage 3b: Speed reduction ─────────────────────────────────────────────
  if (t.descendedTo3000 && !t.speedReduced && ac.altitude <= 5500) {
    cmd('reduce speed to 180');
    t.speedReduced = true;
    return;
  }

  // ── Stage 4: Continue vectoring toward centerline if still far ────────────
  // If xtk > 5nm, keep steering toward the centerline before giving intercept.
  if (t.descendedTo3000 && !t.interceptHeadingGiven && absXtk > 5 && onApproachSide) {
    const targetAlongTrack = Math.max(12, alongTrack);
    const target = pointOnCenterline(targetAlongTrack);
    const brg = bearingTo(ac.position.lat, ac.position.lon, target.lat, target.lon);
    hdgCmd(normalizeHdg(brg));
    return;
  }

  // ── Stage 5: Intercept heading ────────────────────────────────────────────
  // Aircraft must be: on approach side, within 5nm of centerline, 8-20nm out,
  // below 5000ft. Give a 20-30° intercept heading based on which side.
  if (t.descendedTo3000 && !t.interceptHeadingGiven
      && ac.altitude <= 5000 && onApproachSide
      && alongTrack > 8 && alongTrack < 20 && absXtk < 5 && absXtk > 0.5) {
    // Intercept angle: 25° for > 3nm offset, 20° for closer
    const interceptAngle = absXtk > 3 ? 25 : 20;
    let interceptHdg: number;
    if (crossTrack < 0) {
      // Aircraft is LEFT (west) of centerline → turn RIGHT onto localizer
      interceptHdg = LOC_COURSE - interceptAngle; // e.g. 157-25 = 132
    } else {
      // Aircraft is RIGHT (east) of centerline → turn LEFT onto localizer
      interceptHdg = LOC_COURSE + interceptAngle; // e.g. 157+25 = 182
    }
    cmd(`fly heading ${Math.round(normalizeHdg(interceptHdg))}`);
    t.interceptHeadingGiven = true;
    t.interceptHeadingTick = currentTick;
    return;
  }

  // ── Stage 5b: If on approach side but too close to centerline, just clear ─
  // Aircraft right on the centerline (< 0.5nm) — skip intercept heading, just clear
  if (t.descendedTo3000 && !t.interceptHeadingGiven && !t.clearedApproach
      && ac.altitude <= 5000 && onApproachSide
      && alongTrack > 8 && absXtk <= 0.5) {
    // Already on the centerline — give localizer course heading and clear
    cmd(`fly heading ${LOC_COURSE}`);
    t.interceptHeadingGiven = true;
    t.interceptHeadingTick = currentTick;
    return;
  }

  // ── Stage 6: Clear ILS approach ───────────────────────────────────────────
  // Wait at least 3 ticks after intercept heading for the aircraft to start turning
  if (t.interceptHeadingGiven && !t.clearedApproach
      && currentTick >= (t.interceptHeadingTick || 0) + 3) {
    cmd('cleared ILS runway 16 approach');
    t.clearedApproach = true;
    return;
  }

  // ── Stage 7: Handoff to tower ─────────────────────────────────────────────
  // Hand off when established and close enough to land soon
  if (t.clearedApproach && !t.handedOff) {
    if ((ac.onLocalizer || ac.flightPhase === 'final') && distToTh < 5 && ac.altitude < 2500) {
      cmd(`contact tower ${TOWER_FREQ}`);
      t.handedOff = true;
      return;
    }
  }
}

function getOrCreateTracking(ac: Aircraft): AircraftTracking {
  let t = tracking.get(ac.callsign);
  if (!t) {
    t = {
      callsign: ac.callsign,
      category: ac.category,
      firstSeenTick: currentTick,
      lastSeenTick: currentTick,
      commandsIssued: [],
      commandResults: [],
      phases: [],
      altitudes: [],
      positions: [],
      wasOnLocalizer: false,
      wasOnGlideslope: false,
      wasHandedOff: false,
      landed: false,
      removed: false,
      descendedTo6000: false,
      vectoredBase: false,
      clearedApproach: false,
      handedOff: false,
      descendedTo3000: false,
      speedReduced: false,
    };
    tracking.set(ac.callsign, t);
  }
  return t;
}

// ─── Issue Analysis ──────────────────────────────────────────────────────────
function analyzeResults(): void {
  console.log('\n' + '='.repeat(80));
  console.log('PLAYTEST RESULTS: Heavy Arrivals at KRIC');
  console.log('='.repeat(80));

  // Command results
  const totalCmds = allCommandResponses.length;
  const successCmds = allCommandResponses.filter(c => c.success).length;
  const failedCmds = allCommandResponses.filter(c => !c.success);

  console.log(`\n--- COMMAND SUMMARY ---`);
  console.log(`Total commands: ${totalCmds}`);
  console.log(`Successful: ${successCmds}`);
  console.log(`Failed: ${failedCmds.length}`);

  if (failedCmds.length > 0) {
    console.log(`\nFailed commands:`);
    for (const cmd of failedCmds) {
      console.log(`  [Tick ${cmd.tick}] "${cmd.cmd}" -> ${cmd.error}`);
    }
  }

  // Aircraft summary
  console.log(`\n--- AIRCRAFT SUMMARY ---`);
  const arrivals = Array.from(tracking.values()).filter(t => t.category === 'arrival');
  const vfr = Array.from(tracking.values()).filter(t => t.category === 'vfr');
  const deps = Array.from(tracking.values()).filter(t => t.category === 'departure');

  console.log(`Total tracked: ${tracking.size}`);
  console.log(`Arrivals: ${arrivals.length}, Departures: ${deps.length}, VFR: ${vfr.length}`);

  // Detailed arrival analysis
  console.log(`\n--- ARRIVAL DETAILS ---`);
  const landed = arrivals.filter(t => t.landed);
  const localizer = arrivals.filter(t => t.wasOnLocalizer);
  const glideslope = arrivals.filter(t => t.wasOnGlideslope);
  const handedOff = arrivals.filter(t => t.wasHandedOff);

  console.log(`  Landed: ${landed.length}/${arrivals.length}`);
  console.log(`  On localizer: ${localizer.length}/${arrivals.length}`);
  console.log(`  On glideslope: ${glideslope.length}/${arrivals.length}`);
  console.log(`  Handed off: ${handedOff.length}/${arrivals.length}`);

  for (const t of arrivals) {
    const phases = [...new Set(t.phases)];
    const cmds = t.commandsIssued.map(c => c.replace(t.callsign + ' ', '')).join(' | ');
    const minAlt = t.altitudes.length > 0 ? Math.min(...t.altitudes) : -1;
    const maxAlt = t.altitudes.length > 0 ? Math.max(...t.altitudes) : -1;
    console.log(`\n  ${t.callsign} (${t.category}):`);
    console.log(`    Ticks seen: ${t.firstSeenTick}-${t.lastSeenTick} (${t.lastSeenTick - t.firstSeenTick + 1} ticks)`);
    console.log(`    Alt: ${minAlt}-${maxAlt}, Phases: ${phases.join(' -> ')}`);
    console.log(`    Loc: ${t.wasOnLocalizer}, GS: ${t.wasOnGlideslope}, HO: ${t.wasHandedOff}, Landed: ${t.landed}`);
    console.log(`    Cmds (${t.commandsIssued.length}): ${cmds || '(none)'}`);

    // Check for issues specific to each aircraft
    const failedResults = t.commandResults.filter(r => !r.success);
    if (failedResults.length > 0) {
      for (const f of failedResults) {
        console.log(`    *** FAILED: "${f.cmd}" -> ${f.error}`);
      }
    }
  }

  // ─── Identify Issues ──────────────────────────────────────────────────────

  // Issue: Conflicts at spawn - aircraft spawned too close together
  const conflictPairs = new Map<string, { count: number; firstTick: number; distance: string }>();
  for (const a of alertLog) {
    const key = a.message;
    const existing = conflictPairs.get(key);
    if (existing) {
      existing.count++;
    } else {
      conflictPairs.set(key, { count: 1, firstTick: a.tick, distance: key });
    }
  }

  for (const [msg, info] of conflictPairs) {
    if (info.firstTick <= 2) {
      issues.push({
        severity: 'critical',
        title: 'Aircraft spawned in conflict',
        description: `Conflict detected from tick ${info.firstTick}: ${msg}`,
        detail: `This conflict persisted for ${info.count} ticks. Aircraft were spawned too close together or at the same altitude. The scenario generator needs to ensure minimum separation (3nm lateral or 1000ft vertical) between pre-spawned aircraft.`,
        file: 'packages/server/src/game/ScenarioGenerator.ts',
      });
    }
  }

  // Issue: No traffic spawning after initial batch
  const maxSpawnTick = Math.max(...Array.from(tracking.values()).map(t => t.firstSeenTick));
  if (maxSpawnTick <= 5 && currentTick > 60) {
    issues.push({
      severity: 'critical',
      title: 'No new traffic spawned after initial batch',
      description: `All ${tracking.size} aircraft appeared by tick ${maxSpawnTick}, but simulation ran for ${currentTick} ticks.`,
      detail: `At "heavy" density with 28 ops/hour and 4x time scale, we should see new aircraft spawning every ~32 ticks (128s / 4x). The scenario generator update() should be spawning new arrivals but isn't. Likely the spawn interval calculation in ScenarioGenerator doesn't account for timeScale or the interval is too long.`,
      file: 'packages/server/src/game/ScenarioGenerator.ts',
    });
  }

  // Issue: No aircraft intercepted localizer
  if (localizer.length === 0 && arrivals.filter(t => t.clearedApproach).length > 0) {
    issues.push({
      severity: 'major',
      title: 'No aircraft intercepted localizer after approach clearance',
      description: `${arrivals.filter(t => t.clearedApproach).length} aircraft were cleared for ILS 16 approach but none intercepted the localizer.`,
      detail: `The ILS intercept logic in FlightPlanExecutor.executeILS() requires: (1) bearing to threshold within 5 deg of loc course, (2) heading within 30 deg of loc course, (3) within 25nm. Aircraft may not be positioned correctly for intercept, or the heading/position criteria are too tight for the vectoring angles used.`,
      file: 'packages/server/src/ai/FlightPlanExecutor.ts',
    });
  }

  // Issue: No aircraft landed
  if (landed.length === 0 && currentTick > 120) {
    issues.push({
      severity: 'major',
      title: 'No aircraft landed after 120+ ticks',
      description: `With ${arrivals.length} arrivals and 180 ticks of simulation, zero aircraft completed approach and landed.`,
      detail: `This suggests either the approach clearance + vectoring pipeline is broken, or descent rates are too slow for aircraft to reach the runway. Aircraft that were cleared for approach need to intercept the localizer, capture the glideslope, and descend to landing.`,
      file: 'packages/server/src/ai/FlightPlanExecutor.ts',
    });
  }

  // Issue: Score degrades with time even without controller errors
  if (latestState && latestState.score.overallScore < 70 && latestState.score.separationViolations <= 2) {
    issues.push({
      severity: 'major',
      title: 'Score degrades too quickly over time',
      description: `Score dropped to ${latestState.score.overallScore} (grade ${latestState.score.grade}) despite only ${latestState.score.separationViolations} separation violations.`,
      detail: `The scoring engine appears to penalize the controller continuously even when no errors occur. With only 2 violations in 180 ticks, the score should not drop below 70. The ScoringEngine may be over-penalizing idle time or "average delay" unfairly.`,
      file: 'packages/server/src/game/ScoringEngine.ts',
    });
  }

  // Issue: Aircraft altitude not changing (stuck)
  for (const t of arrivals) {
    if (t.descendedTo6000 && t.altitudes.length > 20) {
      const start = t.altitudes.slice(0, 5);
      const end = t.altitudes.slice(-5);
      const avgStart = start.reduce((a, b) => a + b, 0) / start.length;
      const avgEnd = end.reduce((a, b) => a + b, 0) / end.length;
      const diff = avgStart - avgEnd;

      // In 180 ticks at ~1800 fpm descent, we'd expect ~5400ft descent
      if (t.altitudes.length > 60 && diff < 1000 && avgEnd > 4000) {
        issues.push({
          severity: 'major',
          title: `${t.callsign} barely descended despite descent clearance`,
          description: `${t.callsign} only descended ${diff.toFixed(0)}ft over ${t.altitudes.length} ticks (avg start: ${avgStart.toFixed(0)}, avg end: ${avgEnd.toFixed(0)}).`,
          detail: `Aircraft should descend at ~1800 fpm standard rate. Over ${t.altitudes.length} seconds that's ~${(t.altitudes.length * 1800 / 60).toFixed(0)}ft expected. This suggests the targetAltitude is not being set correctly, or the physics engine descent rate is wrong.`,
          file: 'packages/server/src/engine/PhysicsEngine.ts',
        });
      }
    }
  }

  // Issue: Conflict alerts showing frozen/stale distances
  for (const [msg, info] of conflictPairs) {
    if (info.count > 30) {
      issues.push({
        severity: 'major',
        title: 'Conflict alert shows frozen/unchanging distance for many ticks',
        description: `Alert "${msg}" repeated ${info.count} times from tick ${info.firstTick}.`,
        detail: `The conflict distance in the alert text never changes, suggesting either: (1) the conflict detector isn't recalculating distances each tick, (2) the aircraft truly aren't moving relative to each other, or (3) the alert formatting rounds too aggressively. Expected: distance should change as aircraft move.`,
        file: 'packages/server/src/engine/ConflictDetector.ts',
      });
    }
  }

  // Issue: Failed commands analysis
  const failedByType = new Map<string, number>();
  for (const cmd of failedCmds) {
    const errKey = cmd.error || 'unknown';
    failedByType.set(errKey, (failedByType.get(errKey) || 0) + 1);
  }
  for (const [err, count] of failedByType) {
    issues.push({
      severity: count > 3 ? 'major' : 'minor',
      title: `Command failures: ${err}`,
      description: `${count} commands failed with error: "${err}"`,
      detail: `Commands that failed: ${failedCmds.filter(c => c.error === err).map(c => c.cmd).join(', ')}`,
      file: 'packages/server/src/commands/CommandExecutor.ts',
    });
  }

  // Issue: departures in arrivals-only scenario
  if (deps.length > 0) {
    issues.push({
      severity: 'minor',
      title: 'Departures spawned in arrivals-only scenario',
      description: `${deps.length} departure aircraft appeared in arrivals-only session: ${deps.map(d => d.callsign).join(', ')}`,
      detail: `scenarioType was "arrivals" but departures appeared. The ScenarioGenerator should not spawn departures when scenarioType is "arrivals".`,
      file: 'packages/server/src/game/ScenarioGenerator.ts',
    });
  }

  // Alert summary
  console.log(`\n--- ALERT SUMMARY ---`);
  console.log(`Total alerts: ${alertLog.length}`);
  console.log(`Unique conflicts: ${conflictPairs.size}`);
  for (const [msg, info] of conflictPairs) {
    console.log(`  "${msg}" - ${info.count} ticks (from tick ${info.firstTick})`);
  }

  // Score
  if (latestState) {
    console.log(`\n--- SCORE ---`);
    console.log(`  Overall: ${latestState.score.overallScore}, Grade: ${latestState.score.grade}`);
    console.log(`  Sep violations: ${latestState.score.separationViolations}`);
    console.log(`  Conflict alerts: ${latestState.score.conflictAlerts}`);
    console.log(`  Aircraft handled: ${latestState.score.aircraftHandled}`);
    console.log(`  Commands: ${latestState.score.commandsIssued}`);
    console.log(`  Avg delay: ${latestState.score.averageDelay}`);
  }

  // Radio log sample
  console.log(`\n--- RADIO LOG (first 20) ---`);
  for (const msg of radioMessages.slice(0, 20)) {
    console.log(`  [Tick ${msg.tick}] ${msg.from}: ${msg.message}`);
  }
  if (radioMessages.length > 20) {
    console.log(`  ... and ${radioMessages.length - 20} more`);
  }

  // Print all issues
  console.log(`\n${'='.repeat(80)}`);
  console.log(`ISSUES FOUND: ${issues.length}`);
  console.log('='.repeat(80));

  const critical = issues.filter(i => i.severity === 'critical');
  const major = issues.filter(i => i.severity === 'major');
  const minor = issues.filter(i => i.severity === 'minor');

  console.log(`  Critical: ${critical.length}, Major: ${major.length}, Minor: ${minor.length}`);

  for (const issue of issues) {
    console.log(`\n  [${issue.severity.toUpperCase()}] ${issue.title}`);
    console.log(`    ${issue.description}`);
    console.log(`    Detail: ${issue.detail}`);
    if (issue.file) console.log(`    File: ${issue.file}`);
  }

  console.log('\n' + '='.repeat(80));
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('[PLAYTEST] Starting heavy arrivals playtest at KRIC...');
  console.log(`[PLAYTEST] Sim duration: ${SIM_DURATION_TICKS} ticks at ${TIME_SCALE}x`);

  let ws: WebSocket;
  try {
    ws = await connect();
  } catch {
    console.error('[PLAYTEST] Failed to connect. Is server running on port 3001?');
    process.exit(1);
  }

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());

    switch (msg.type) {
      case 'sessionInfo':
        console.log(`[PLAYTEST] Session: ${msg.session.id}, status: ${msg.session.status}`);
        break;

      case 'airportData':
        console.log(`[PLAYTEST] Airport: ${msg.data.icao} - ${msg.data.name}`);
        console.log(`[PLAYTEST]   Runways: ${msg.data.runways.map((r: any) => r.id).join(', ')}`);
        console.log(`[PLAYTEST]   STARs: ${msg.data.stars.map((s: any) => s.name).join(', ')}`);
        console.log(`[PLAYTEST]   ILS 16 available: ${msg.data.runways.find((r: any) => r.id === '16')?.ilsAvailable}`);
        break;

      case 'gameState':
        latestState = msg.state;
        currentTick = msg.state.clock.tickCount;

        const currentCallsigns = new Set<string>();

        for (const ac of msg.state.aircraft as Aircraft[]) {
          currentCallsigns.add(ac.callsign);
          const t = getOrCreateTracking(ac);
          t.lastSeenTick = currentTick;
          t.phases.push(ac.flightPhase);
          t.altitudes.push(Math.round(ac.altitude));
          t.positions.push({ lat: ac.position.lat, lon: ac.position.lon });
          if (ac.onLocalizer) t.wasOnLocalizer = true;
          if (ac.onGlideslope) t.wasOnGlideslope = true;
          if (ac.handingOff) t.wasHandedOff = true;
          if (ac.flightPhase === 'landed') t.landed = true;
        }

        // Track aircraft that disappeared
        for (const cs of previousCallsigns) {
          if (!currentCallsigns.has(cs)) {
            const t = tracking.get(cs);
            if (t) t.removed = true;
          }
        }
        previousCallsigns = currentCallsigns;

        // Alerts
        if (msg.state.alerts) {
          for (const alert of msg.state.alerts) {
            alertLog.push({
              tick: currentTick,
              type: alert.type,
              severity: alert.severity,
              message: alert.message,
            });
          }
        }

        // Issue ATC commands
        if (sessionStarted) {
          for (const ac of msg.state.aircraft as Aircraft[]) {
            controlAircraft(ws, ac);
          }
        }

        // Progress log
        if (currentTick % 10 === 0 && currentTick > 0) {
          const acCount = msg.state.aircraft.length;
          const arrCount = (msg.state.aircraft as Aircraft[]).filter(a => a.category === 'arrival').length;
          const onLoc = (msg.state.aircraft as Aircraft[]).filter(a => a.onLocalizer).length;
          const onGS = (msg.state.aircraft as Aircraft[]).filter(a => a.onGlideslope).length;
          const onApp = (msg.state.aircraft as Aircraft[]).filter(a => a.flightPhase === 'approach' || a.flightPhase === 'final').length;
          const landed = (msg.state.aircraft as Aircraft[]).filter(a => a.flightPhase === 'landed').length;
          console.log(`[PLAYTEST] Tick ${currentTick}: ${acCount} ac (${arrCount} arr), app/fin: ${onApp}, loc: ${onLoc}, GS: ${onGS}, landed: ${landed}, score: ${msg.state.score.overallScore}`);

          // Detailed log for aircraft on approach
          for (const a of msg.state.aircraft as Aircraft[]) {
            if (a.clearances.approach && a.category === 'arrival') {
              const dist = distNm(a.position.lat, a.position.lon, AIRPORT_LAT, AIRPORT_LON);
              // Approximate cross-track from localizer (RWY 16 loc course 157, threshold 37.516636, -77.323578)
              const thLat = 37.516636, thLon = -77.323578;
              const distToTh = distNm(a.position.lat, a.position.lon, thLat, thLon);
              console.log(`  [${a.callsign}] alt=${Math.round(a.altitude)} hdg=${Math.round(a.heading)} tgtHdg=${Math.round(a.targetHeading)} distAP=${dist.toFixed(1)} distTH=${distToTh.toFixed(1)} loc=${a.onLocalizer} phase=${a.flightPhase} clr.hdg=${a.clearances.heading} pos=${a.position.lat.toFixed(3)},${a.position.lon.toFixed(3)}`);
            }
          }
        }
        break;

      case 'commandResponse':
        allCommandResponses.push({
          tick: currentTick,
          cmd: msg.rawText,
          success: msg.success,
          callsign: msg.callsign,
          error: msg.error,
        });

        const tr = tracking.get(msg.callsign);
        if (tr) {
          tr.commandResults.push({
            cmd: msg.rawText,
            success: msg.success,
            error: msg.error,
            tick: currentTick,
          });
        }

        if (!msg.success) {
          console.log(`[PLAYTEST] CMD FAIL [Tick ${currentTick}]: "${msg.rawText}" -> ${msg.error}`);
        }
        break;

      case 'radioMessage':
        radioMessages.push({
          tick: currentTick,
          from: msg.transmission.from,
          message: msg.transmission.message,
        });
        break;

      case 'alert':
        alertLog.push({
          tick: currentTick,
          type: msg.alert.type,
          severity: msg.alert.severity,
          message: msg.alert.message,
        });
        break;

      case 'error':
        console.error(`[PLAYTEST] SERVER ERROR: ${msg.message}`);
        issues.push({
          severity: 'critical',
          title: `Server error: ${msg.message}`,
          description: `Server sent error at tick ${currentTick}`,
          detail: msg.message,
        });
        break;
    }
  });

  // Create session
  console.log('[PLAYTEST] Creating session...');
  send(ws, {
    type: 'createSession',
    config: {
      airport: 'KRIC',
      density: 'heavy',
      scenarioType: 'arrivals',
      runwayConfig: { arrivalRunways: ['16'], departureRunways: ['16'] },
      weather: {
        winds: [{ altitude: 0, direction: 200, speed: 8, gusts: null }],
        altimeter: 29.92,
        temperature: 15,
        visibility: 10,
        ceiling: null,
        atisLetter: 'A',
      },
    },
  });

  await delay(500);

  // Start session
  console.log('[PLAYTEST] Starting session...');
  send(ws, { type: 'sessionControl', action: 'start' });
  sessionStarted = true;
  await delay(500);

  // Set time scale
  console.log(`[PLAYTEST] Setting ${TIME_SCALE}x time scale...`);
  send(ws, { type: 'sessionControl', action: 'setTimeScale', timeScale: TIME_SCALE });

  // Wait for sim to run
  const waitTime = (SIM_DURATION_TICKS / TIME_SCALE) * 1000 + 5000;
  console.log(`[PLAYTEST] Running for ${SIM_DURATION_TICKS} ticks (~${Math.round(waitTime/1000)}s real)...`);
  await delay(waitTime);

  // Report
  analyzeResults();

  ws.close();
  console.log('\n[PLAYTEST] Complete.');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('[PLAYTEST] Fatal:', err);
  process.exit(1);
});
