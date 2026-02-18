import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AircraftState, ATCCommand, RadioTransmission } from '@atc-sim/shared';
import { formatAltitude, formatHeading } from '@atc-sim/shared';
import { v4 as uuid } from 'uuid';

const APPROACH_FREQUENCY = 125.0;

// ---------------------------------------------------------------------------
// Delay constants (in ticks; simulation runs at 1 Hz so 1 tick ≈ 1 second)
// ---------------------------------------------------------------------------

/** Check-in delay range: 3–6 ticks */
const CHECKIN_DELAY_MIN = 3;
const CHECKIN_DELAY_RANGE = 4; // random adds 0..(RANGE-1) ticks

/** Readback delay range: 2–4 ticks */
const READBACK_DELAY_MIN = 2;
const READBACK_DELAY_RANGE = 3;

/** General radio call delay range: 1–3 ticks */
const GENERAL_DELAY_MIN = 1;
const GENERAL_DELAY_RANGE = 3;

// ---------------------------------------------------------------------------

/** Load airline callsign mappings from data file */
function loadAirlineCallsigns(): Record<string, string> {
  const map: Record<string, string> = {};
  const dataPath = join(process.cwd(), 'data/airlines/airlines.json');
  if (existsSync(dataPath)) {
    try {
      const raw = readFileSync(dataPath, 'utf-8');
      const data = JSON.parse(raw) as { airlines: { icao: string; callsign: string }[] };
      for (const airline of data.airlines) {
        map[airline.icao] = airline.callsign
          .split(' ')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
      }
    } catch {
      // Fall through to defaults
    }
  }
  // Ensure fallback defaults
  if (!map['UAL']) map['UAL'] = 'United';
  if (!map['AAL']) map['AAL'] = 'American';
  if (!map['DAL']) map['DAL'] = 'Delta';
  return map;
}

const AIRLINE_CALLSIGNS = loadAirlineCallsigns();

/** A radio transmission held in the pending queue until its send tick arrives */
interface PendingTransmission {
  transmission: RadioTransmission;
  sendAtTick: number;
}

/**
 * RadioComms generates realistic pilot radio messages.
 *
 * Messages are not emitted immediately — they are placed in a pending queue
 * with a tick-based delay so that radio calls feel naturally spaced:
 *   - Check-in (initial contact): 3–6 tick delay
 *   - Readback (pilot response to ATC clearance): 2–4 tick delay
 *   - General calls (go-around, unable, etc.): 1–3 tick delay
 *
 * Call `drainQueue(currentTick)` each simulation tick to retrieve any
 * transmissions whose send time has arrived.
 */
export class RadioComms {
  private pendingQueue: PendingTransmission[] = [];

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  /**
   * Add a transmission to the pending queue, to be released at `sendAtTick`.
   */
  private enqueue(transmission: RadioTransmission, sendAtTick: number): void {
    this.pendingQueue.push({ transmission, sendAtTick });
  }

  /**
   * Drain all transmissions whose `sendAtTick` is at or before `currentTick`.
   * Returns them in the order they were enqueued (FIFO within the same tick).
   * Call this once per simulation tick from the AI update loop.
   */
  drainQueue(currentTick: number): RadioTransmission[] {
    const ready: RadioTransmission[] = [];
    const remaining: PendingTransmission[] = [];

    for (const pending of this.pendingQueue) {
      if (pending.sendAtTick <= currentTick) {
        ready.push(pending.transmission);
      } else {
        remaining.push(pending);
      }
    }

    this.pendingQueue = remaining;
    return ready;
  }

  /**
   * Clear all pending transmissions (e.g. on session reset).
   */
  clearQueue(): void {
    this.pendingQueue = [];
  }

  // ---------------------------------------------------------------------------
  // Public radio call methods — each enqueues with appropriate delay
  // ---------------------------------------------------------------------------

  /** Enqueue initial contact message for arrivals and departures (3–6 tick delay) */
  initialContact(ac: AircraftState, currentTick: number, atisLetter?: string): void {
    const altStr = formatAltitudeSpoken(ac.altitude);
    const spoken = spokenCallsign(ac.callsign);

    let transmission: RadioTransmission;

    if (ac.category === 'departure') {
      // Departure check-in: "Richmond Approach, DAL202, climbing through 1,200, assigned 10,000."
      // Round current altitude to nearest 100ft as pilots do in practice.
      const roundedAlt = Math.round(ac.altitude / 100) * 100;
      const roundedAltStr = formatAltitudeSpoken(roundedAlt);
      const assignedAlt = ac.clearances.altitude;
      const assignedStr = assignedAlt !== null
        ? ` for ${formatAltitudeSpoken(assignedAlt)}`
        : '';
      transmission = this.createTransmission(
        ac.callsign,
        `Richmond Approach, ${spoken}, climbing through ${roundedAltStr}${assignedStr}.`
      );
    } else {
      // Arrival check-in with STAR (if applicable), altitude, and ATIS
      const PHONETIC: Record<string, string> = {
        A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo',
        F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliet',
        K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar',
        P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango',
        U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee',
        Z: 'Zulu',
      };
      const letter = atisLetter || 'A';
      const spokenAtis = PHONETIC[letter.toUpperCase()] || 'Alpha';

      let checkin: string;
      if (ac.clearances.descendViaSTAR && ac.flightPlan.star) {
        checkin = `${spoken} descending via ${ac.flightPlan.star}, ${altStr}, information ${spokenAtis}`;
      } else {
        const verb = ac.verticalSpeed < -200 ? 'descending through' : 'level';
        checkin = `${spoken} with you ${verb} ${altStr}, information ${spokenAtis}`;
      }

      transmission = this.createTransmission(
        ac.callsign,
        `Richmond Approach, ${checkin}.`
      );
    }

    const delay = CHECKIN_DELAY_MIN + Math.floor(Math.random() * CHECKIN_DELAY_RANGE);
    this.enqueue(transmission, currentTick + delay);
  }

  /** Enqueue readback for commands (2–4 tick delay) */
  readback(ac: AircraftState, commands: ATCCommand[], currentTick: number): void {
    const parts: string[] = [];

    for (const cmd of commands) {
      switch (cmd.type) {
        case 'altitude':
          parts.push(
            `${cmd.direction} and maintain ${formatAltitudeSpoken(cmd.altitude)}`
          );
          break;
        case 'heading':
          parts.push(
            `${cmd.turnDirection ? 'turn ' + cmd.turnDirection + ' ' : ''}heading ${formatHeading(cmd.heading)}`
          );
          break;
        case 'speed':
          if (cmd.speed === null) {
            parts.push('resume normal speed');
          } else {
            parts.push(`speed ${cmd.speed}`);
          }
          break;
        case 'approach': {
          const appName = cmd.approachType === 'VISUAL' ? 'visual' : cmd.approachType;
          const rb: string[] = [];
          if (cmd.maintainUntilEstablished) {
            const estRef = cmd.approachType === 'ILS' ? 'the localizer' : 'the final approach course';
            rb.push(`maintain ${formatAltitudeSpoken(cmd.maintainUntilEstablished)} until established on ${estRef}`);
          }
          if (cmd.crossFix && cmd.crossAltitude) {
            const crossPart = cmd.crossType === 'atOrAbove'
              ? `cross ${cmd.crossFix} at or above ${formatAltitudeSpoken(cmd.crossAltitude)}`
              : `cross ${cmd.crossFix} at ${formatAltitudeSpoken(cmd.crossAltitude)}`;
            rb.push(crossPart);
          }
          rb.push(`cleared ${appName} approach runway ${cmd.runway}`);
          parts.push(rb.join(', '));
        }
          break;
        case 'direct':
          parts.push(`direct ${cmd.fix}`);
          break;
        case 'hold':
          parts.push(`hold at ${cmd.fix}${cmd.asPublished ? ' as published' : ''}`);
          break;
        case 'descendViaSTAR':
          parts.push('descend via the STAR');
          break;
        case 'climbViaSID':
          parts.push('climb via the SID');
          break;
        case 'handoff': {
          // Handoff readback: "over to tower on 121.1, Delta 202, good day"
          const freqStr = cmd.frequency.toFixed(
            cmd.frequency % 1 === 0 ? 1 : String(cmd.frequency).split('.')[1]?.length === 1 ? 1 : 2
          );
          const facilityStr = cmd.facility ?? 'departure';
          const msg = `over to ${facilityStr} on ${freqStr}, ${spokenCallsign(ac.callsign)}, good day`;
          const transmission = this.createTransmission(ac.callsign, msg);
          const delay = READBACK_DELAY_MIN + Math.floor(Math.random() * READBACK_DELAY_RANGE);
          this.enqueue(transmission, currentTick + delay);
          return; // early return — handoff readback is its own message
        }
        case 'radarHandoff':
          // Radar handoff is an ATC-to-ATC data-link operation — no pilot radio readback.
          return;
        case 'goAround':
          parts.push('going around');
          break;
        case 'resumeOwnNavigation':
          parts.push('resume own navigation');
          break;
        case 'expectApproach': {
          const expectName = cmd.approachType === 'VISUAL' ? 'visual' : cmd.approachType;
          parts.push(`expect ${expectName} approach runway ${cmd.runway}`);
          break;
        }
        case 'cancelApproach':
          parts.push('cancel approach clearance');
          break;
        default:
          parts.push('roger');
      }
    }

    const msg = parts.join(', ');
    const transmission = this.createTransmission(
      ac.callsign,
      `${msg}, ${spokenCallsign(ac.callsign)}.`
    );
    const delay = READBACK_DELAY_MIN + Math.floor(Math.random() * READBACK_DELAY_RANGE);
    this.enqueue(transmission, currentTick + delay);
  }

  /**
   * Enqueue the pilot's response to a field/traffic in sight query (1–3 tick delay).
   * result:
   *   'field'      — "field in sight" (positive response to rfs)
   *   'traffic'    — "traffic in sight" (positive response to rts)
   *   'negative'   — "negative field/traffic in sight" (weather prevents visual, no auto-report)
   *   'willReport' — "negative field in sight, will advise" (not yet in range, will report when close)
   *   'runway'     — "runway in sight" (auto-acquired at DA during ILS/RNAV approach)
   */
  sightResponse(
    ac: AircraftState,
    result: 'field' | 'traffic' | 'negative' | 'willReport' | 'runway',
    currentTick: number,
    trafficCallsign?: string
  ): void {
    const spoken = spokenCallsign(ac.callsign);
    let msg: string;
    if (result === 'field') {
      msg = `${spoken}, field in sight.`;
    } else if (result === 'traffic') {
      msg = `${spoken}, traffic in sight.`;
    } else if (result === 'runway') {
      msg = `${spoken}, runway in sight.`;
    } else if (result === 'willReport') {
      msg = trafficCallsign
        ? `${spoken}, negative traffic in sight, will advise.`
        : `${spoken}, negative field in sight, will advise.`;
    } else {
      msg = trafficCallsign
        ? `${spoken}, negative traffic in sight.`
        : `${spoken}, negative field in sight.`;
    }
    const transmission = this.createTransmission(ac.callsign, msg);
    const delay = GENERAL_DELAY_MIN + Math.floor(Math.random() * GENERAL_DELAY_RANGE);
    this.enqueue(transmission, currentTick + delay);
  }

  /**
   * Enqueue a system (ATC-to-ATC) event for display in the comm log.
   * These are data-link events (radar handoffs, etc.) that do NOT go on the radio.
   * Delivered immediately (no delay).
   */
  systemEvent(message: string, currentTick: number): void {
    const transmission: RadioTransmission = {
      id: uuid(),
      from: 'system',
      message,
      timestamp: Date.now(),
      frequency: 0,
    };
    this.enqueue(transmission, currentTick);
  }

  /** Enqueue go-around radio call (1–3 tick delay) */
  goAround(ac: AircraftState, reason: string, currentTick: number): void {
    const spoken = spokenCallsign(ac.callsign);
    const msg = reason
      ? `${spoken} is going around, ${reason}.`
      : `${spoken} is going around.`;
    const transmission = this.createTransmission(ac.callsign, msg);
    const delay = GENERAL_DELAY_MIN + Math.floor(Math.random() * GENERAL_DELAY_RANGE);
    this.enqueue(transmission, currentTick + delay);
  }

  /** Enqueue "unable" response (1–3 tick delay) */
  unable(ac: AircraftState, reason: string, currentTick: number): void {
    const transmission = this.createTransmission(
      ac.callsign,
      `Unable, ${reason}, ${spokenCallsign(ac.callsign)}.`
    );
    const delay = GENERAL_DELAY_MIN + Math.floor(Math.random() * GENERAL_DELAY_RANGE);
    this.enqueue(transmission, currentTick + delay);
  }

  /**
   * Generate the controller's instruction text from parsed commands (no delay — controller speaks immediately).
   * Returns null for data-link-only operations (radarHandoff) that don't go on the radio.
   */
  controllerInstruction(callsign: string, commands: ATCCommand[]): RadioTransmission | null {
    // Radar handoff is ATC-to-ATC data link — no radio call generated.
    if (commands.every(c => c.type === 'radarHandoff')) return null;
    const spoken = spokenCallsign(callsign);
    const parts: string[] = [];

    for (const cmd of commands) {
      switch (cmd.type) {
        case 'altitude':
          parts.push(
            `${cmd.direction} and maintain ${formatAltitudeSpoken(cmd.altitude)}`
          );
          break;
        case 'heading':
          if (cmd.turnDirection) {
            parts.push(`turn ${cmd.turnDirection} heading ${formatHeading(cmd.heading)}`);
          } else {
            parts.push(`fly heading ${formatHeading(cmd.heading)}`);
          }
          break;
        case 'speed':
          if (cmd.speed === null) {
            parts.push('resume normal speed');
          } else {
            parts.push(`reduce speed to ${cmd.speed}`);
          }
          break;
        case 'approach': {
          const appName = cmd.approachType === 'VISUAL' ? 'visual' : cmd.approachType;
          const instrParts: string[] = [];
          if (cmd.maintainUntilEstablished) {
            const estRef = cmd.approachType === 'ILS' ? 'the localizer' : 'the final approach course';
            instrParts.push(`maintain ${formatAltitudeSpoken(cmd.maintainUntilEstablished)} until established on ${estRef}`);
          }
          instrParts.push(`cleared ${appName} approach runway ${cmd.runway}`);
          parts.push(instrParts.join(', '));
          break;
        }
        case 'direct':
          parts.push(`proceed direct ${cmd.fix}`);
          break;
        case 'hold':
          parts.push(`hold at ${cmd.fix}${cmd.asPublished ? ' as published' : ''}`);
          break;
        case 'descendViaSTAR':
          parts.push('descend via the STAR');
          break;
        case 'climbViaSID':
          parts.push('climb via the SID');
          break;
        case 'handoff': {
          const freqStr = cmd.frequency.toFixed(
            cmd.frequency % 1 === 0 ? 1 : String(cmd.frequency).split('.')[1]?.length === 1 ? 1 : 2
          );
          // facility may still be null here (controller instruction emitted before resolution)
          const facilityStr = cmd.facility ?? freqStr;
          parts.push(`contact ${facilityStr} ${freqStr}`);
          break;
        }
        case 'goAround':
          parts.push('go around');
          break;
        case 'expectApproach': {
          const expectName = cmd.approachType === 'VISUAL' ? 'visual' : cmd.approachType;
          parts.push(`expect ${expectName} approach runway ${cmd.runway}`);
          break;
        }
        case 'resumeOwnNavigation':
          parts.push('resume own navigation');
          break;
        case 'requestFieldSight':
          parts.push('report field in sight');
          break;
        case 'requestTrafficSight':
          parts.push(`traffic, ${spokenCallsign(cmd.trafficCallsign)}, report traffic in sight`);
          break;
        default:
          break;
      }
    }

    const msg = `${spoken}, ${parts.join(', ')}.`;
    return {
      id: uuid(),
      from: 'controller',
      message: msg,
      timestamp: Date.now(),
      frequency: APPROACH_FREQUENCY,
    };
  }

  /** Create a radio transmission */
  private createTransmission(
    from: string,
    message: string
  ): RadioTransmission {
    return {
      id: uuid(),
      from,
      message,
      timestamp: Date.now(),
      frequency: APPROACH_FREQUENCY,
    };
  }
}

/** Convert callsign to spoken form */
function spokenCallsign(callsign: string): string {
  // Try to match airline prefix (3-letter ICAO code)
  const match = callsign.match(/^([A-Z]{3})(\d+)$/);
  if (match) {
    const [, prefix, number] = match;
    const name = AIRLINE_CALLSIGNS[prefix] || prefix;
    return `${name} ${number}`;
  }

  // General aviation (N-number)
  if (callsign.startsWith('N')) {
    return `November ${callsign.slice(1)}`;
  }

  return callsign;
}

function formatAltitudeSpoken(feet: number): string {
  if (feet >= 18000) {
    return `flight level ${Math.round(feet / 100)}`;
  }
  if (feet >= 10000) {
    const thousands = Math.floor(feet / 1000);
    const hundreds = Math.round((feet % 1000) / 100);
    if (hundreds === 0) return `${thousands} thousand`;
    return `${thousands} thousand ${hundreds} hundred`;
  }
  const thousands = Math.floor(feet / 1000);
  const hundreds = Math.round((feet % 1000) / 100);
  if (hundreds === 0) return `${thousands} thousand`;
  return `${thousands} thousand ${hundreds} hundred`;
}
