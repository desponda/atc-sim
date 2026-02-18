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
  CancelApproachCommand,
  RadarHandoffCommand,
  RequestFieldSightCommand,
  RequestTrafficSightCommand,
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
        error: `Unknown command "${remainder}". Try: dm/cm [altitude], tlh/trh/fh [heading], s [speed], ci/cr/cv[runway], pd [fix], ct [freq], rfs, rts [callsign]`,
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

    // Split on comma or sentence-ending period (not decimal points like "121.1")
    const segments = t
      .split(/,\s*|\.\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const expandedSegments = segments.map(seg => this.expandSegment(seg));
    return expandedSegments.join(', ');
  }

  private expandSegment(seg: string): string {
    const lower = seg.toLowerCase().trim();
    const tokens = lower.split(/\s+/);
    const first = tokens[0];

    // Multi-shorthand compound: if the first token expands to a single command
    // and there are remaining tokens, expand the rest as one string recursively.
    // This allows "tl160 dm3000 ci16" or "dm3000 pd ITTEM" to expand correctly.
    // We detect this by checking whether expanding just the first token produces
    // something that changed AND there are leftover tokens.
    if (tokens.length > 1) {
      const firstExpanded = this.expandSegment(tokens[0]);
      // If the first token was a recognized shorthand (changed), expand rest too
      if (firstExpanded !== tokens[0]) {
        const restExpanded = this.expandSegment(tokens.slice(1).join(' '));
        return [firstExpanded, restExpanded].join(', ');
      }
    }

    // dm<altitude> or dm <altitude> -> descend and maintain <altitude>
    // e.g. "dm3000" or "dm 3000"
    const dmAttached = first.match(/^dm(\d+)$/);
    if (dmAttached) {
      return `descend and maintain ${dmAttached[1]}`;
    }
    if (first === 'dm' && tokens.length >= 2) {
      const expanded = `descend and maintain ${tokens[1]}`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // cm<altitude> or cm <altitude> -> climb and maintain <altitude>
    // e.g. "cm5000" or "cm 5000"
    const cmAttached = first.match(/^cm(\d+)$/);
    if (cmAttached) {
      return `climb and maintain ${cmAttached[1]}`;
    }
    if (first === 'cm' && tokens.length >= 2) {
      const expanded = `climb and maintain ${tokens[1]}`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // tlh<heading> or tl<heading> or tlh <heading> or tl <heading> -> turn left heading
    // e.g. "tl160", "tlh160", "tl 160", "tlh 160"
    const tlAttached = first.match(/^(?:tlh|tl)(\d{1,3})$/);
    if (tlAttached) {
      return `turn left heading ${tlAttached[1]}`;
    }
    if ((first === 'tlh' || first === 'tl') && tokens.length >= 2) {
      const expanded = `turn left heading ${tokens[1]}`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // trh<heading> or tr<heading> or trh <heading> or tr <heading> -> turn right heading
    // e.g. "tr090", "trh090", "tr 090", "trh 090"
    const trAttached = first.match(/^(?:trh|tr)(\d{1,3})$/);
    if (trAttached) {
      return `turn right heading ${trAttached[1]}`;
    }
    if ((first === 'trh' || first === 'tr') && tokens.length >= 2) {
      const expanded = `turn right heading ${tokens[1]}`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // fh <heading> -> fly heading <heading>
    if (first === 'fh' && tokens.length >= 2) {
      const expanded = `fly heading ${tokens[1]}`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // h/hdg <heading> -> heading <heading>
    if ((first === 'h' || first === 'hdg') && tokens.length >= 2) {
      const expanded = `heading ${tokens[1]}`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // s/spd <speed> -> speed <speed>
    if ((first === 's' || first === 'spd') && tokens.length >= 2) {
      const expanded = `speed ${tokens[1]}`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // pd <fix> -> proceed direct <fix>  (only consumes one token; remainder becomes new commands)
    if (first === 'pd' && tokens.length >= 2) {
      const expanded = `proceed direct ${tokens[1].toUpperCase()}`;
      if (tokens.length > 2) {
        const restExpanded = this.expandSegment(tokens.slice(2).join(' '));
        return [expanded, restExpanded].join(', ');
      }
      return expanded;
    }

    // ct <freq> -> contact tower <freq>
    if (first === 'ct' && tokens.length >= 2) {
      const expanded = `contact tower ${tokens[1]}`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // ho <freq> -> contact <freq>  (parseHandoff handles default facility)
    // ho <facility> <freq> -> contact <facility> <freq>
    if (first === 'ho' && tokens.length >= 2) {
      if (tokens.length >= 3) {
        return `contact ${tokens[1]} ${tokens.slice(2).join(' ')}`;
      }
      return `contact ${tokens[1]}`;
    }

    // Cleared approach shorthands: ci16, cr16, cv16
    // Also accept space-separated runway: "ci 16", "ci r16", "cr 34", "cv r16"
    // Extended compound form — all in one token cluster:
    //   ci16 m3000 r080  → turn right heading 080, maintain 3000 until established, cleared ILS runway 16
    //   ci16 m3000 l260  → turn left heading 260, maintain 3000 until established, cleared ILS runway 16
    //   ci16 m3000 h080  → fly heading 080, maintain 3000 until established, cleared ILS runway 16
    //   ci16 x TONCE 3000  → cross TONCE at 3000, cleared ILS runway 16
    //   ci16 xa TONCE 3000 → cross TONCE at or above 3000, cleared ILS runway 16

    // Handle space-separated runway: "ci 16", "ci r16", "cr 34", "cv r16"
    // (no compound modifiers for the space-separated form — just basic clearance)
    if ((first === 'ci' || first === 'cr' || first === 'cv') && tokens.length >= 2) {
      const typeMap2: Record<string, string> = { ci: 'ILS', cr: 'RNAV', cv: 'visual' };
      const appType2 = typeMap2[first];
      // Second token may be plain number "16" or prefixed with "r": "r16"
      const rwyRaw = tokens[1].replace(/^r/i, '');
      const rwyMatch = rwyRaw.match(/^(\d{1,2}[lrcLRC]?)$/);
      if (rwyMatch) {
        const runway2 = rwyRaw.toUpperCase();
        if (appType2 === 'visual') {
          return `cleared visual approach runway ${runway2}`;
        }
        return `cleared ${appType2} runway ${runway2} approach`;
      }
    }

    const clearedMatch = first.match(/^(ci|cr|cv)(\d{1,2}[lrc]?)$/);
    if (clearedMatch) {
      const typeMap: Record<string, string> = { ci: 'ILS', cr: 'RNAV', cv: 'visual' };
      const appType = typeMap[clearedMatch[1]];
      const runway = clearedMatch[2].toUpperCase();

      // Basic form — no extra tokens
      if (tokens.length === 1) {
        if (appType === 'visual') return `cleared visual approach runway ${runway}`;
        return `cleared ${appType} runway ${runway} approach`;
      }

      // Parse modifiers from remaining tokens
      let maintainAlt: number | null = null;
      let headingPart: string | null = null;
      let crossFix: string | null = null;
      let crossAlt: number | null = null;
      let crossAtOrAbove = false;

      const rest = tokens.slice(1);
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i];
        const mMatch = tok.match(/^m(\d+)$/);
        if (mMatch) { maintainAlt = parseInt(mMatch[1]); continue; }
        const rMatch = tok.match(/^r(\d{1,3})$/);
        if (rMatch) { headingPart = `turn right heading ${rMatch[1]}`; continue; }
        const lMatch = tok.match(/^l(\d{1,3})$/);
        if (lMatch) { headingPart = `turn left heading ${lMatch[1]}`; continue; }
        const hMatch = tok.match(/^(?:fh|h)(\d{1,3})$/);
        if (hMatch) { headingPart = `fly heading ${hMatch[1]}`; continue; }
        // x <fix> <alt> or xa <fix> <alt>
        if ((tok === 'x' || tok === 'xa') && i + 2 < rest.length) {
          crossAtOrAbove = tok === 'xa';
          crossFix = rest[i + 1].toUpperCase();
          crossAlt = parseInt(rest[i + 2]);
          i += 2;
          continue;
        }
      }

      const parts: string[] = [];
      if (headingPart) parts.push(headingPart);

      if (crossFix !== null && crossAlt !== null) {
        const atStr = crossAtOrAbove ? 'at or above' : 'at';
        if (appType === 'visual') {
          parts.push(`cross ${crossFix} ${atStr} ${crossAlt}, cleared visual approach runway ${runway}`);
        } else {
          parts.push(`cross ${crossFix} ${atStr} ${crossAlt}, cleared ${appType} runway ${runway}`);
        }
      } else if (maintainAlt !== null && appType !== 'visual') {
        parts.push(`maintain ${maintainAlt} until established, cleared ${appType} runway ${runway}`);
      } else {
        if (appType === 'visual') {
          parts.push(`cleared visual approach runway ${runway}`);
        } else {
          parts.push(`cleared ${appType} runway ${runway} approach`);
        }
      }

      return parts.join(', ');
    }

    // .ho ctr -> radar handoff (dot-prefix distinguishes from radio handoff)
    // Support both ".ho ctr" and ".ho center"
    if (first === '.ho' && tokens.length >= 2) {
      const target = tokens[1].toLowerCase();
      if (target === 'ctr' || target === 'center') {
        return 'radar handoff';
      }
    }

    // "rho" -> "radar handoff" (backward-compatible alias)
    if (first === 'rho') {
      return 'radar handoff';
    }

    // int<rwy> or int <rwy> -> cleared ILS runway <rwy>
    // "intercept runway 16 localizer" = cleared for the ILS; DA auto-go-around applies
    const intAttached = first.match(/^int(\d{1,2}[lrc]?)$/);
    if (intAttached) {
      return `cleared ILS runway ${intAttached[1].toUpperCase()} approach`;
    }
    if (first === 'int' && tokens.length >= 2) {
      const rwy = tokens[1].replace(/^r/i, '').toUpperCase();
      const expanded = `cleared ILS runway ${rwy} approach`;
      if (tokens.length > 2) return [expanded, this.expandSegment(tokens.slice(2).join(' '))].join(', ');
      return expanded;
    }

    // rfs -> report field in sight
    if (first === 'rfs') {
      return 'report field in sight';
    }

    // rts <callsign> -> report traffic in sight <callsign>
    if (first === 'rts' && tokens.length >= 2) {
      return `report traffic in sight ${tokens[1].toUpperCase()}`;
    }

    // "ga" -> "go around"
    if (first === 'ga') {
      return 'go around';
    }

    // dvs -> descend via the star
    if (first === 'dvs') {
      return 'descend via the star';
    }

    // cvs -> climb via the sid
    if (first === 'cvs') {
      return 'climb via the sid';
    }

    // ron -> resume own navigation
    if (first === 'ron') {
      return 'resume own navigation';
    }

    // ca -> cancel approach clearance
    if (first === 'ca') {
      return 'cancel approach clearance';
    }

    // m<alt> or m <alt> -> maintain <alt>  (standalone maintain altitude)
    // e.g. "m3000" or "m 3000"
    const mAttached = first.match(/^m(\d+)$/);
    if (mAttached) {
      return `maintain ${mAttached[1]}`;
    }
    if (first === 'm' && tokens.length >= 2) {
      return `maintain ${tokens.slice(1).join(' ')}`;
    }

    // evi <rwy> -> expect vectors ILS runway <rwy>
    if (first === 'evi' && tokens.length >= 2) {
      return `expect vectors ILS runway ${tokens[1].toUpperCase()}`;
    }

    // evr <rwy> -> expect vectors RNAV runway <rwy>
    if (first === 'evr' && tokens.length >= 2) {
      return `expect vectors RNAV runway ${tokens[1].toUpperCase()}`;
    }

    // evv <rwy> -> expect visual approach runway <rwy>
    if (first === 'evv' && tokens.length >= 2) {
      return `expect visual approach runway ${tokens[1].toUpperCase()}`;
    }

    // Return original if no shorthand matched
    return seg;
  }

  private parseCommands(text: string): ATCCommand[] {
    const commands: ATCCommand[] = [];

    // Compound approach clearances span internal commas, so extract them from the
    // full text BEFORE splitting. e.g.:
    //   "turn right 080, maintain 3000 until established, cleared ILS runway 16"
    //   "cross TONCE at or above 3000, cleared ILS runway 16"
    const lower = text.toLowerCase();
    const extracted = this.tryExtractCompoundApproach(lower);
    const parseText = extracted ? extracted.remainder : lower;

    // Split remainder on comma or sentence-ending period
    const segments = parseText
      .split(/,\s*|\.\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const segment of segments) {
      const cmd = this.parseSegment(segment);
      if (cmd) commands.push(cmd);
    }

    if (extracted) {
      commands.push(extracted.approach);
    }

    // If nothing parsed, try the whole original text
    if (commands.length === 0) {
      const cmd = this.parseSegment(lower.trim());
      if (cmd) commands.push(cmd);
    }

    return commands;
  }

  /**
   * Try to extract a compound approach clearance from the full text before splitting.
   * Handles "maintain X until established, cleared ILS/RNAV runway Y" and
   * "cross FIX at [or above] X, cleared ILS/RNAV/visual runway Y".
   * Returns the parsed approach and the remaining text with the approach portion removed.
   */
  private tryExtractCompoundApproach(
    text: string
  ): { approach: ApproachCommand; remainder: string } | null {
    // "maintain X until established [on the localizer/final approach course], cleared ILS/RNAV runway Y"
    const maintainPat =
      /maintain\s+(?:flight\s+level\s*|fl\s*)?(\d+)\s+until\s+established(?:\s+on\s+the\s+(?:localizer|final\s+approach\s+course))?\s*,?\s*cleared\s+(ils|rnav)\s+(?:runway\s+)?(\w+)(?:\s+approach)?/;
    const mMatch = text.match(maintainPat);
    if (mMatch) {
      let alt = parseInt(mMatch[1]);
      if (alt < 1000) alt *= 100;
      const approach: ApproachCommand = {
        type: 'approach',
        approachType: mMatch[2].toUpperCase() as 'ILS' | 'RNAV',
        runway: mMatch[3].toUpperCase(),
        maintainUntilEstablished: alt,
      };
      const remainder = text.replace(maintainPat, '').replace(/,\s*$/, '').replace(/^\s*,\s*/, '').trim();
      return { approach, remainder };
    }

    // "cross FIX at [or above] X, cleared ILS/RNAV/visual runway Y"
    const crossPat =
      /cross\s+(\w+)\s+at\s+(?:(or\s+above)\s+)?(?:fl\s*)?(\d+)\s*,?\s*cleared\s+(ils|rnav|visual)\s+(?:approach\s+)?(?:runway\s+)?(\w+)(?:\s+approach)?/;
    const cMatch = text.match(crossPat);
    if (cMatch) {
      let crossAlt = parseInt(cMatch[3]);
      if (crossAlt < 1000) crossAlt *= 100;
      const appType = cMatch[4] === 'visual' ? 'VISUAL' : cMatch[4].toUpperCase() as 'ILS' | 'RNAV';
      const approach: ApproachCommand = {
        type: 'approach',
        approachType: appType,
        runway: cMatch[5].toUpperCase(),
        crossFix: cMatch[1].toUpperCase(),
        crossAltitude: crossAlt,
        crossType: cMatch[2] ? 'atOrAbove' : 'at',
      };
      const remainder = text.replace(crossPat, '').replace(/,\s*$/, '').replace(/^\s*,\s*/, '').trim();
      return { approach, remainder };
    }

    return null;
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
      this.parseCancelApproach(text) ??
      this.parseRadarHandoff(text) ??
      this.parseRequestFieldSight(text) ??
      this.parseRequestTrafficSight(text) ??
      null
    );
  }

  private parseAltitude(text: string): AltitudeCommand | null {
    // "maintain 3000 until established" — must be checked before generic "maintain 3000"
    const untilMatch = text.match(
      /maintain\s+(?:flight\s+level\s*|fl\s*)?(\d+)\s+until\s+established/
    );
    if (untilMatch) {
      let altitude = parseInt(untilMatch[1]);
      if (altitude < 1000) altitude *= 100;
      return { type: 'altitude', altitude, direction: 'climb', untilEstablished: true };
    }

    // "climb and maintain 5000", "descend maintain FL350", "maintain 3000"
    // "descend to 5000", "climb 10000"
    const patterns = [
      /(?:climb\s+(?:and\s+)?maintain|climb\s+to)\s+(?:flight\s+level\s*|fl\s*)?(\d+)/,
      /(?:descend\s+(?:and\s+)?maintain|descend\s+to)\s+(?:flight\s+level\s*|fl\s*)?(\d+)/,
      /maintain\s+(?:flight\s+level\s*|fl\s*)?(\d+)/,
      /(?:climb|descend)\s+(?:flight\s+level\s*|fl\s*)?(\d+)/,
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

    // Frequency-only: facility is null — CommandExecutor resolves it from airport data
    const freqOnly = text.match(/contact\s+(\d{2,3}\.\d{1,3})/);
    if (freqOnly) {
      return {
        type: 'handoff',
        facility: null,
        frequency: parseFloat(freqOnly[1]),
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

    // "expect vectors visual approach runway 16"
    const vectorsVisualMatch = text.match(/expect\s+vectors?\s+visual\s+(?:approach\s+)?(?:runway\s+)?(\w+)/);
    if (vectorsVisualMatch) {
      return {
        type: 'expectApproach',
        approachType: 'VISUAL',
        runway: vectorsVisualMatch[1].toUpperCase(),
      };
    }

    // "expect vectors ILS runway 16", "expect vectors RNAV runway 34"
    const vectorsMatch = text.match(/expect\s+vectors?\s+(ils|rnav)\s+(?:runway\s+)?(\w+)/);
    if (vectorsMatch) {
      return {
        type: 'expectApproach',
        approachType: vectorsMatch[1].toUpperCase() as 'ILS' | 'RNAV',
        runway: vectorsMatch[2].toUpperCase(),
      };
    }

    // "expect vectors runway 16 ILS", "expect vectors runway 34 RNAV"
    const vectorsRwyFirstMatch = text.match(/expect\s+vectors?\s+(?:runway\s+)?(\w+)\s+(ils|rnav|visual)/);
    if (vectorsRwyFirstMatch) {
      const appType = vectorsRwyFirstMatch[2].toUpperCase();
      return {
        type: 'expectApproach',
        approachType: appType as 'ILS' | 'RNAV' | 'VISUAL',
        runway: vectorsRwyFirstMatch[1].toUpperCase(),
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

  private parseCancelApproach(text: string): CancelApproachCommand | null {
    if (/cancel\s+approach/.test(text)) {
      return { type: 'cancelApproach' };
    }
    return null;
  }

  private parseRadarHandoff(text: string): RadarHandoffCommand | null {
    if (/^radar\s+hand\s*off/.test(text)) {
      return { type: 'radarHandoff' };
    }
    return null;
  }

  private parseRequestFieldSight(text: string): RequestFieldSightCommand | null {
    if (/report\s+field\s+in\s+sight/.test(text)) {
      return { type: 'requestFieldSight' };
    }
    return null;
  }

  private parseRequestTrafficSight(text: string): RequestTrafficSightCommand | null {
    const match = text.match(/report\s+traffic\s+in\s+sight\s+(\w+)/);
    if (match) {
      return { type: 'requestTrafficSight', trafficCallsign: match[1].toUpperCase() };
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
    if (lower.includes('contact') || lower.includes('tower') || lower.includes('handoff') || lower.includes('ho')) {
      suggestions.push('ct [freq] (contact tower)');
      suggestions.push('ho [freq] (handoff)');
    }

    if (suggestions.length === 0) {
      suggestions.push(
        'dm/cm [altitude]',
        'tlh/trh/fh [heading]',
        's [speed]',
        'ci/cr/cv[runway]',
        'pd [fix]',
        'ct [freq]',
        'ho [freq]',
        'go around',
      );
    }

    return suggestions;
  }
}
