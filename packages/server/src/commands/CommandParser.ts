import type {
  ATCCommand,
  AltitudeCommand,
  HeadingCommand,
  SpeedCommand,
  ApproachCommand,
  DirectCommand,
  HoldCommand,
  HandoffCommand,
  GoAroundCommand,
  DescendViaSTARCommand,
  ClimbViaSIDCommand,
  ResumeOwnNavigationCommand,
  ExpectApproachCommand,
  ExpectRunwayCommand,
  ParseResult,
  ControllerCommand,
} from '@atc-sim/shared';

/**
 * CommandParser: parse free-text ATC commands into structured commands.
 *
 * Supports both natural language and shorthand:
 *   "AAL101 descend and maintain 5000"   or  "AAL101 dm 5000"
 *   "DAL456 turn left heading 270"        or  "DAL456 tlh 270"
 *   "SWA321 cleared ILS runway 16"        or  "SWA321 ci16"
 *   "UAL123 proceed direct CAMRN"         or  "UAL123 pd CAMRN"
 *   "CVS101 contact tower 118.3"          or  "CVS101 ct 118.3"
 *
 * Callsign matching is case-insensitive.
 */
export class CommandParser {
  parse(rawText: string): ParseResult {
    const text = rawText.trim();
    if (!text) {
      return { success: false, error: 'Empty command' };
    }

    // Extract callsign (first token)
    const firstSpace = text.indexOf(' ');
    if (firstSpace === -1) {
      return {
        success: false,
        error: `No command after callsign "${text}". Example: ${text.toUpperCase()} descend and maintain 5000`,
      };
    }

    const callsign = text.substring(0, firstSpace).toUpperCase();
    const remainder = text.substring(firstSpace + 1).trim();

    if (!remainder) {
      return {
        success: false,
        error: `No command after callsign "${callsign}". Example: ${callsign} descend and maintain 5000`,
      };
    }

    // Expand shorthands before parsing
    const expanded = this.expandShorthands(remainder);
    const commands = this.parseCommands(expanded);

    if (commands.length === 0) {
      return {
        success: false,
        error: `Unknown command "${remainder}". Try: dm/cm [altitude], tlh/trh/fh [heading], s [speed], ci/cr/cv[runway], pd [fix], ct [freq]`,
        suggestions: this.getSuggestions(remainder),
      };
    }

    const command: ControllerCommand = {
      callsign,
      commands,
      rawText: text,
      timestamp: Date.now(),
    };

    return { success: true, command };
  }

  /**
   * Expand shorthand commands into their full forms so the
   * natural-language parsers can handle them.
   */
  private expandShorthands(text: string): string {
    let t = text.trim();

    // Split on comma/period for multi-command, expand each segment
    const segments = t
      .split(/[,.]/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const expandedSegments = segments.map(seg => this.expandSegment(seg));
    return expandedSegments.join(', ');
  }

  private expandSegment(seg: string): string {
    const lower = seg.toLowerCase().trim();
    const tokens = lower.split(/\s+/);
    const first = tokens[0];

    // dm <altitude> -> descend and maintain <altitude>
    if (first === 'dm' && tokens.length >= 2) {
      return `descend and maintain ${tokens.slice(1).join(' ')}`;
    }

    // cm <altitude> -> climb and maintain <altitude>
    if (first === 'cm' && tokens.length >= 2) {
      return `climb and maintain ${tokens.slice(1).join(' ')}`;
    }

    // tlh <heading> -> turn left heading <heading>
    if ((first === 'tlh' || first === 'tl') && tokens.length >= 2) {
      return `turn left heading ${tokens.slice(1).join(' ')}`;
    }

    // trh <heading> -> turn right heading <heading>
    if ((first === 'trh' || first === 'tr') && tokens.length >= 2) {
      return `turn right heading ${tokens.slice(1).join(' ')}`;
    }

    // fh <heading> -> fly heading <heading>
    if (first === 'fh' && tokens.length >= 2) {
      return `fly heading ${tokens.slice(1).join(' ')}`;
    }

    // h <heading> -> heading <heading> (single letter shorthand)
    if (first === 'h' && tokens.length >= 2) {
      return `heading ${tokens.slice(1).join(' ')}`;
    }

    // s <speed> -> speed <speed>
    if (first === 's' && tokens.length >= 2) {
      return `speed ${tokens.slice(1).join(' ')}`;
    }

    // pd <fix> -> proceed direct <fix>
    if (first === 'pd' && tokens.length >= 2) {
      return `proceed direct ${tokens.slice(1).join(' ')}`;
    }

    // ct <freq> -> contact tower <freq>
    if (first === 'ct' && tokens.length >= 2) {
      return `contact tower ${tokens.slice(1).join(' ')}`;
    }

    // Cleared approach shorthands: ci16, cr16, cv16
    // Pattern: ci<runway>, cr<runway>, cv<runway>
    const clearedMatch = first.match(/^(ci|cr|cv)(\d{1,2}[lrc]?)$/);
    if (clearedMatch) {
      const typeMap: Record<string, string> = {
        ci: 'ILS',
        cr: 'RNAV',
        cv: 'visual',
      };
      const appType = typeMap[clearedMatch[1]];
      const runway = clearedMatch[2].toUpperCase();
      if (appType === 'visual') {
        return `cleared visual approach runway ${runway}`;
      }
      return `cleared ${appType} runway ${runway} approach`;
    }

    // "ga" -> "go around"
    if (first === 'ga') {
      return 'go around';
    }

    // Return original if no shorthand matched
    return seg;
  }

  private parseCommands(text: string): ATCCommand[] {
    const commands: ATCCommand[] = [];

    // Split on comma/period for multi-command
    const segments = text
      .split(/[,.]/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const segment of segments) {
      const cmd = this.parseSegment(segment.toLowerCase());
      if (cmd) {
        commands.push(cmd);
      }
    }

    // If splitting produced nothing, try the whole thing
    if (commands.length === 0) {
      const cmd = this.parseSegment(text.toLowerCase().trim());
      if (cmd) commands.push(cmd);
    }

    return commands;
  }

  private parseSegment(text: string): ATCCommand | null {
    return (
      this.parseAltitude(text) ??
      this.parseHeading(text) ??
      this.parseSpeed(text) ??
      this.parseApproach(text) ??
      this.parseDirect(text) ??
      this.parseHold(text) ??
      this.parseDescendViaStar(text) ??
      this.parseClimbViaSid(text) ??
      this.parseHandoff(text) ??
      this.parseGoAround(text) ??
      this.parseExpectApproach(text) ??
      this.parseExpectRunway(text) ??
      this.parseResumeNav(text) ??
      null
    );
  }

  private parseAltitude(text: string): AltitudeCommand | null {
    // "climb and maintain 5000", "descend maintain FL350", "maintain 3000"
    // "descend to 5000", "climb 10000"
    const patterns = [
      /(?:climb\s+(?:and\s+)?maintain|climb\s+to)\s+(?:fl\s*)?(\d+)/,
      /(?:descend\s+(?:and\s+)?maintain|descend\s+to)\s+(?:fl\s*)?(\d+)/,
      /maintain\s+(?:fl\s*)?(\d+)/,
      /(?:climb|descend)\s+(?:fl\s*)?(\d+)/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        let altitude = parseInt(match[1]);
        // If FL notation or small number, convert
        if (altitude < 1000) altitude *= 100;

        const direction: 'climb' | 'descend' = text.includes('descend')
          ? 'descend'
          : text.includes('climb')
            ? 'climb'
            : 'climb'; // default, executor will adjust based on current altitude

        return { type: 'altitude', altitude, direction };
      }
    }
    return null;
  }

  private parseHeading(text: string): HeadingCommand | null {
    // "turn left heading 270", "fly heading 090", "heading 180"
    const patterns = [
      /turn\s+(left|right)\s+(?:heading\s+)?(\d{1,3})/,
      /fly\s+heading\s+(\d{1,3})/,
      /heading\s+(\d{1,3})/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        if (match.length === 3) {
          // Has turn direction
          return {
            type: 'heading',
            heading: parseInt(match[2]),
            turnDirection: match[1] as 'left' | 'right',
          };
        } else {
          return {
            type: 'heading',
            heading: parseInt(match[1]),
            turnDirection: null,
          };
        }
      }
    }
    return null;
  }

  private parseSpeed(text: string): SpeedCommand | null {
    // "reduce speed 180", "increase speed 250", "maintain speed 210",
    // "speed 180", "resume normal speed"
    if (/resume\s+(?:normal\s+)?speed/.test(text)) {
      return { type: 'speed', speed: null };
    }

    const patterns = [
      /(?:reduce|increase|maintain)?\s*speed\s+(?:to\s+)?(\d{2,3})/,
      /(?:reduce|slow)\s+(?:to\s+)?(\d{2,3})/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return { type: 'speed', speed: parseInt(match[1]) };
      }
    }
    return null;
  }

  private parseApproach(text: string): ApproachCommand | null {
    // Compound phraseology: "maintain 3000 until established, cleared ILS runway 16 approach"
    // Or: "maintain 3000 until established on the localizer, cleared ILS runway 16 approach"
    // Or: "maintain 3000 until established on the final approach course, cleared RNAV runway 16 approach"
    const maintainMatch = text.match(
      /maintain\s+(?:fl\s*)?(\d+)\s+until\s+established(?:\s+on\s+the\s+(?:localizer|final\s+approach\s+course))?\s*,?\s*cleared\s+(ils|rnav)\s+(?:runway\s+)?(\w+)(?:\s+approach)?/
    );
    if (maintainMatch) {
      let altitude = parseInt(maintainMatch[1]);
      if (altitude < 1000) altitude *= 100;
      return {
        type: 'approach',
        approachType: maintainMatch[2].toUpperCase() as 'ILS' | 'RNAV',
        runway: maintainMatch[3].toUpperCase(),
        maintainUntilEstablished: altitude,
      };
    }

    // Cross-fix phraseology: "cross JETSA at 3000, cleared ILS runway 16 approach"
    // Or: "cross JETSA at or above 3000, cleared ILS runway 16 approach"
    const crossMatch = text.match(
      /cross\s+(\w+)\s+at\s+(?:(or\s+above)\s+)?(?:fl\s*)?(\d+)\s*,?\s*cleared\s+(ils|rnav|visual)\s+(?:approach\s+)?(?:runway\s+)?(\w+)(?:\s+approach)?/
    );
    if (crossMatch) {
      let crossAlt = parseInt(crossMatch[3]);
      if (crossAlt < 1000) crossAlt *= 100;
      const isVisual = crossMatch[4].toLowerCase() === 'visual';
      return {
        type: 'approach',
        approachType: isVisual ? 'VISUAL' : crossMatch[4].toUpperCase() as 'ILS' | 'RNAV',
        runway: crossMatch[5].toUpperCase(),
        crossFix: crossMatch[1].toUpperCase(),
        crossAltitude: crossAlt,
        crossType: crossMatch[2] ? 'atOrAbove' : 'at',
      };
    }

    // Standard approach clearances
    // "cleared ILS runway 16", "cleared RNAV 34", "cleared visual approach runway 16"
    const patterns = [
      /cleared\s+visual\s+(?:approach\s+)?(?:runway\s+)?(\w+)/,
      /cleared\s+(ils|rnav)\s+(?:runway\s+)?(\w+)(?:\s+approach)?/,
      /(?:ils|rnav)\s+(?:approach\s+)?(?:runway\s+)?(\w+)\s+cleared/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        // Visual approach
        if (text.includes('visual')) {
          return {
            type: 'approach',
            approachType: 'VISUAL',
            runway: (match[1] || match[2]).toUpperCase(),
          };
        }
        if (match.length === 3) {
          return {
            type: 'approach',
            approachType: match[1].toUpperCase() as 'ILS' | 'RNAV',
            runway: match[2].toUpperCase(),
          };
        } else {
          const appType = text.includes('rnav') ? 'RNAV' : 'ILS';
          return {
            type: 'approach',
            approachType: appType,
            runway: match[1].toUpperCase(),
          };
        }
      }
    }
    return null;
  }

  private parseDirect(text: string): DirectCommand | null {
    // "direct CAMRN", "proceed direct COLIN", "direct to TAVNY"
    const match = text.match(/(?:proceed\s+)?direct\s+(?:to\s+)?(\w+)/);
    if (match) {
      return { type: 'direct', fix: match[1].toUpperCase() };
    }
    return null;
  }

  private parseHold(text: string): HoldCommand | null {
    // "hold at CAMRN as published", "hold at TAVNY"
    const match = text.match(/hold\s+(?:at\s+)?(\w+)/);
    if (match) {
      return {
        type: 'hold',
        fix: match[1].toUpperCase(),
        asPublished: text.includes('as published'),
      };
    }
    return null;
  }

  private parseDescendViaStar(text: string): DescendViaSTARCommand | null {
    if (/descend\s+via\s+(?:the\s+)?star/.test(text) ||
        /descend\s+via/.test(text)) {
      return { type: 'descendViaSTAR' };
    }
    return null;
  }

  private parseClimbViaSid(text: string): ClimbViaSIDCommand | null {
    if (/climb\s+via\s+(?:the\s+)?sid/.test(text) ||
        /climb\s+via/.test(text)) {
      return { type: 'climbViaSID' };
    }
    return null;
  }

  private parseHandoff(text: string): HandoffCommand | null {
    // "contact tower 118.3", "contact center 128.55"
    const match = text.match(
      /contact\s+(tower|center|approach|departure|ground)\s+(\d{2,3}\.?\d{0,3})/
    );
    if (match) {
      return {
        type: 'handoff',
        facility: match[1] as HandoffCommand['facility'],
        frequency: parseFloat(match[2]),
      };
    }
    return null;
  }

  private parseGoAround(text: string): GoAroundCommand | null {
    if (/go\s*around/.test(text) || /missed\s+approach/.test(text)) {
      return { type: 'goAround' };
    }
    return null;
  }

  private parseExpectApproach(text: string): ExpectApproachCommand | null {
    // "expect visual approach runway 16"
    const visualMatch = text.match(/expect\s+visual\s+(?:approach\s+)?(?:runway\s+)?(\w+)/);
    if (visualMatch) {
      return {
        type: 'expectApproach',
        approachType: 'VISUAL',
        runway: visualMatch[1].toUpperCase(),
      };
    }

    // "expect ILS runway 16 approach", "expect RNAV runway 34"
    const match = text.match(/expect\s+(ils|rnav)\s+(?:runway\s+)?(\w+)/);
    if (match) {
      return {
        type: 'expectApproach',
        approachType: match[1].toUpperCase() as 'ILS' | 'RNAV',
        runway: match[2].toUpperCase(),
      };
    }
    return null;
  }

  private parseExpectRunway(text: string): ExpectRunwayCommand | null {
    // "expect runway 16"
    const match = text.match(/expect\s+runway\s+(\w+)/);
    if (match) {
      return {
        type: 'expectRunway',
        runway: match[1].toUpperCase(),
      };
    }
    return null;
  }

  private parseResumeNav(text: string): ResumeOwnNavigationCommand | null {
    if (/resume\s+own\s+nav/.test(text)) {
      return { type: 'resumeOwnNavigation' };
    }
    return null;
  }

  private getSuggestions(text: string): string[] {
    const suggestions: string[] = [];
    const lower = text.toLowerCase();

    if (lower.includes('climb') || lower.includes('descend') || lower.includes('altitude')) {
      suggestions.push('dm [altitude] (descend and maintain)');
      suggestions.push('cm [altitude] (climb and maintain)');
    }
    if (lower.includes('head') || lower.includes('turn')) {
      suggestions.push('tlh [heading] (turn left heading)');
      suggestions.push('trh [heading] (turn right heading)');
      suggestions.push('fh [heading] (fly heading)');
    }
    if (lower.includes('speed') || lower.includes('slow') || lower.includes('fast')) {
      suggestions.push('s [knots] (speed)');
      suggestions.push('resume normal speed');
    }
    if (lower.includes('ils') || lower.includes('rnav') || lower.includes('approach') || lower.includes('clear') || lower.includes('visual')) {
      suggestions.push('ci16 (cleared ILS runway 16)');
      suggestions.push('cr16 (cleared RNAV runway 16)');
      suggestions.push('cv16 (cleared visual runway 16)');
    }
    if (lower.includes('direct')) {
      suggestions.push('pd [fix] (proceed direct)');
    }
    if (lower.includes('contact') || lower.includes('tower')) {
      suggestions.push('ct [freq] (contact tower)');
    }

    if (suggestions.length === 0) {
      suggestions.push(
        'dm/cm [altitude]',
        'tlh/trh/fh [heading]',
        's [speed]',
        'ci/cr/cv[runway]',
        'pd [fix]',
        'ct [freq]',
        'go around',
      );
    }

    return suggestions;
  }
}
