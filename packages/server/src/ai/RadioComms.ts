import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AircraftState, ATCCommand, RadioTransmission } from '@atc-sim/shared';
import { formatAltitude, formatHeading } from '@atc-sim/shared';
import { v4 as uuid } from 'uuid';

const APPROACH_FREQUENCY = 125.0;

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

/**
 * RadioComms generates realistic pilot radio messages.
 */
export class RadioComms {
  /** Generate initial contact message for arrivals and departures */
  initialContact(ac: AircraftState, atisLetter?: string): RadioTransmission {
    const altStr = formatAltitudeSpoken(ac.altitude);
    const spoken = spokenCallsign(ac.callsign);

    if (ac.category === 'departure') {
      // Departure check-in: "Richmond Approach, DAL202 with you climbing through 2,500"
      return this.createTransmission(
        ac.callsign,
        `Richmond Approach, ${spoken} with you climbing through ${altStr}.`
      );
    }

    // Arrival check-in with ATIS and altitude
    // "Richmond Approach, AAL101 with you at 10,000, information Alpha"
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
    const verb = ac.verticalSpeed < -200 ? 'descending through' : 'level';
    return this.createTransmission(
      ac.callsign,
      `Richmond Approach, ${spoken} with you ${verb} ${altStr}, information ${spokenAtis}.`
    );
  }

  /** Generate readback for commands */
  readback(ac: AircraftState, commands: ATCCommand[]): RadioTransmission {
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
          // Handoff readback: "switching to tower, AAL101, good day"
          const freqStr = cmd.frequency.toFixed(
            cmd.frequency % 1 === 0 ? 1 : String(cmd.frequency).split('.')[1]?.length === 1 ? 1 : 2
          );
          const msg = `over to ${cmd.facility} on ${freqStr}, ${spokenCallsign(ac.callsign)}, good day`;
          return this.createTransmission(ac.callsign, msg);
        }
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
    return this.createTransmission(
      ac.callsign,
      `${msg}, ${spokenCallsign(ac.callsign)}.`
    );
  }

  /** Generate go-around radio call */
  goAround(ac: AircraftState, reason: string): RadioTransmission {
    const spoken = spokenCallsign(ac.callsign);
    const msg = reason
      ? `${spoken} is going around, ${reason}.`
      : `${spoken} is going around.`;
    return this.createTransmission(ac.callsign, msg);
  }

  /** Generate "unable" response */
  unable(ac: AircraftState, reason: string): RadioTransmission {
    return this.createTransmission(
      ac.callsign,
      `Unable, ${reason}, ${spokenCallsign(ac.callsign)}.`
    );
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
