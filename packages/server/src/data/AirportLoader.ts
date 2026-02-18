import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { AirportData, Position, VideoMap } from '@atc-sim/shared';

// Resolve data directory relative to project root (works with tsx and compiled)
function findDataDir(): string {
  // Try common locations
  const candidates = [
    join(process.cwd(), 'data'),
    resolve('data'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return join(process.cwd(), 'data');
}

const DATA_DIR = findDataDir();

/**
 * Load airport data from JSON files in the data directory.
 * Falls back to minimal inline KRIC data if files are not found.
 */
export function loadAirportData(icao: string): AirportData {
  // Try both exact case and lowercase (data files use lowercase)
  const filePath = join(DATA_DIR, 'airports', `${icao.toLowerCase()}.json`);
  const filePathUpper = join(DATA_DIR, 'airports', `${icao}.json`);
  if (existsSync(filePath) || existsSync(filePathUpper)) {
    const actualPath = existsSync(filePath) ? filePath : filePathUpper;
    try {
      const raw = readFileSync(actualPath, 'utf-8');
      const data = JSON.parse(raw) as AirportData;
      loadVideoMaps(data, icao);
      console.log(`[AirportLoader] Loaded ${icao} from ${actualPath}`);
      return data;
    } catch (e) {
      console.warn(`[AirportLoader] Failed to parse ${actualPath}:`, e);
    }
  }

  // Also try navdata directory
  const navdataPath = join(DATA_DIR, 'navdata', `${icao.toLowerCase()}.json`);
  if (existsSync(navdataPath)) {
    try {
      const raw = readFileSync(navdataPath, 'utf-8');
      const data = JSON.parse(raw) as AirportData;
      console.log(`[AirportLoader] Loaded ${icao} from navdata`);
      return data;
    } catch (e) {
      console.warn(`[AirportLoader] Failed to parse ${navdataPath}:`, e);
    }
  }

  console.warn(`[AirportLoader] No data for ${icao}, using fallback KRIC data`);
  const fallback = getFallbackKRIC();
  loadVideoMaps(fallback, icao);
  return fallback;
}

/** Load video maps from navdata/icao/videomaps.json and merge into AirportData */
function loadVideoMaps(data: AirportData, icao: string): void {
  const vmPath = join(DATA_DIR, 'navdata', icao.toLowerCase(), 'videomaps.json');
  if (existsSync(vmPath)) {
    try {
      const raw = readFileSync(vmPath, 'utf-8');
      const maps = JSON.parse(raw) as VideoMap[];
      data.videoMaps = maps;
      console.log(`[AirportLoader] Loaded ${maps.length} video maps for ${icao}`);
    } catch (e) {
      console.warn(`[AirportLoader] Failed to parse video maps at ${vmPath}:`, e);
    }
  }
}

function getFallbackKRIC(): AirportData {
  const kricPos: Position = { lat: 37.505181, lon: -77.319739 };

  return {
    icao: 'KRIC',
    name: 'Richmond International Airport',
    position: kricPos,
    elevation: 167,
    magneticVariation: -10.0,

    runways: [
      {
        id: '16',
        heading: 157,
        threshold: { lat: 37.516636, lon: -77.323578 },
        end: { lat: 37.495792, lon: -77.306883 },
        length: 9003,
        width: 150,
        elevation: 167,
        ilsAvailable: true,
        ilsFrequency: 109.5,
        ilsCourse: 157,
        glideslopeAngle: 3.0,
      },
      {
        id: '34',
        heading: 337,
        threshold: { lat: 37.495792, lon: -77.306883 },
        end: { lat: 37.516636, lon: -77.323578 },
        length: 9003,
        width: 150,
        elevation: 161,
        ilsAvailable: true,
        ilsFrequency: 111.5,
        ilsCourse: 337,
        glideslopeAngle: 3.0,
      },
      {
        id: '02',
        heading: 23,
        threshold: { lat: 37.498872, lon: -77.329658 },
        end: { lat: 37.516519, lon: -77.324356 },
        length: 6607,
        width: 150,
        elevation: 159,
        ilsAvailable: true,
        ilsFrequency: 110.9,
        ilsCourse: 23,
        glideslopeAngle: 3.0,
      },
      {
        id: '20',
        heading: 203,
        threshold: { lat: 37.516519, lon: -77.324356 },
        end: { lat: 37.498872, lon: -77.329658 },
        length: 6607,
        width: 150,
        elevation: 165,
        ilsAvailable: false,
      },
    ],

    frequencies: {
      atis: 119.15,
      approach: [126.4, 126.75],
      tower: [121.1],
      ground: [121.9],
      departure: [126.4, 126.75],
      center: [128.55, 133.65],
    },

    fixes: [
      { id: 'DUCXS', type: 'waypoint', position: { lat: 37.463111, lon: -77.654444 } },
      { id: 'POWTN', type: 'waypoint', position: { lat: 37.508292, lon: -77.9491 } },
      { id: 'SPIDR', type: 'waypoint', position: { lat: 37.645478, lon: -77.852833 } },
      { id: 'KALLI', type: 'waypoint', position: { lat: 37.465139, lon: -77.647458 } },
      { id: 'LUCYL', type: 'waypoint', position: { lat: 38.089972, lon: -76.677522 } },
      { id: 'COLIN', type: 'waypoint', position: { lat: 38.099786, lon: -76.664125 } },
      { id: 'READE', type: 'waypoint', position: { lat: 37.282092, lon: -78.328844 } },
      { id: 'SOOBY', type: 'waypoint', position: { lat: 37.625461, lon: -77.530794 } },
      { id: 'WAKAL', type: 'waypoint', position: { lat: 37.683517, lon: -77.574786 } },
      { id: 'TRUIT', type: 'waypoint', position: { lat: 37.723083, lon: -77.456447 } },
      { id: 'HIBOM', type: 'waypoint', position: { lat: 37.7813, lon: -77.395717 } },
      { id: 'SUGGR', type: 'waypoint', position: { lat: 37.487483, lon: -77.558081 } },
      { id: 'ITTEM', type: 'waypoint', position: { lat: 37.471939, lon: -77.554572 } },
      { id: 'GORDD', type: 'waypoint', position: { lat: 37.547581, lon: -77.348378 } },
      { id: 'MUGAW', type: 'waypoint', position: { lat: 37.57185, lon: -77.307706 } },
      { id: 'OPUKE', type: 'waypoint', position: { lat: 37.564275, lon: -77.361767 } },
      { id: 'FISSR', type: 'waypoint', position: { lat: 37.443239, lon: -77.346358 } },
      { id: 'RUTLD', type: 'waypoint', position: { lat: 37.385625, lon: -77.328314 } },
      { id: 'BAIRR', type: 'waypoint', position: { lat: 37.348128, lon: -77.317119 } },
    ],

    navaids: [
      {
        id: 'RIC',
        type: 'navaid',
        navaidType: 'VORDME',
        position: { lat: 37.502347, lon: -77.320275 },
        frequency: 114.1,
        morseId: '.-. .. -.-.',
        magneticVariation: -10.0,
      },
    ],

    sids: [
      {
        name: 'KALLI7',
        runways: ['02', '16', '20', '34'],
        commonLegs: [],
        runwayTransitions: [
          {
            name: 'RW16',
            legs: [
              { legType: 'VA', course: 157, altitudeConstraint: { type: 'atOrAbove', altitude: 687 } },
              { legType: 'DF', fix: { id: 'ITTEM', type: 'waypoint', position: { lat: 37.471939, lon: -77.554572 } }, turnDirection: 'right', altitudeConstraint: { type: 'atOrAbove', altitude: 5000 } },
              { legType: 'TF', fix: { id: 'KALLI', type: 'waypoint', position: { lat: 37.465139, lon: -77.647458 } } },
            ],
          },
          {
            name: 'RW34',
            legs: [
              { legType: 'VA', course: 337, altitudeConstraint: { type: 'atOrAbove', altitude: 687 } },
              { legType: 'DF', fix: { id: 'SUGGR', type: 'waypoint', position: { lat: 37.487483, lon: -77.558081 } }, altitudeConstraint: { type: 'atOrAbove', altitude: 5000 } },
              { legType: 'TF', fix: { id: 'KALLI', type: 'waypoint', position: { lat: 37.465139, lon: -77.647458 } } },
            ],
          },
        ],
        enrouteTransitions: [],
      },
      {
        name: 'COLIN8',
        runways: ['02', '16', '20', '34'],
        commonLegs: [],
        runwayTransitions: [
          {
            name: 'RW16',
            legs: [
              { legType: 'VA', course: 157, altitudeConstraint: { type: 'atOrAbove', altitude: 687 } },
              { legType: 'VD', course: 121, altitudeConstraint: { type: 'atOrAbove', altitude: 4000 } },
              { legType: 'VI', course: 41 },
              { legType: 'CF', fix: { id: 'COLIN', type: 'waypoint', position: { lat: 38.099786, lon: -76.664125 } }, course: 49 },
            ],
          },
          {
            name: 'RW34',
            legs: [
              { legType: 'VA', course: 337, altitudeConstraint: { type: 'atOrAbove', altitude: 687 } },
              { legType: 'VI', course: 61, turnDirection: 'right' },
              { legType: 'CF', fix: { id: 'COLIN', type: 'waypoint', position: { lat: 38.099786, lon: -76.664125 } }, course: 49 },
            ],
          },
        ],
        enrouteTransitions: [],
      },
    ],

    stars: [
      {
        name: 'DUCXS5',
        runways: ['02', '16', '20', '34'],
        commonLegs: [
          { legType: 'IF', fix: { id: 'DUCXS', type: 'waypoint', position: { lat: 37.463111, lon: -77.654444 } } },
          { legType: 'TF', fix: { id: 'SOOBY', type: 'waypoint', position: { lat: 37.625461, lon: -77.530794 } } },
          { legType: 'TF', fix: { id: 'WAKAL', type: 'waypoint', position: { lat: 37.683517, lon: -77.574786 } } },
          { legType: 'TF', fix: { id: 'TRUIT', type: 'waypoint', position: { lat: 37.723083, lon: -77.456447 } } },
          { legType: 'TF', fix: { id: 'HIBOM', type: 'waypoint', position: { lat: 37.7813, lon: -77.395717 } } },
        ],
        enrouteTransitions: [],
        runwayTransitions: [],
      },
      {
        name: 'POWTN5',
        runways: ['02', '16', '20', '34'],
        commonLegs: [
          { legType: 'IF', fix: { id: 'POWTN', type: 'waypoint', position: { lat: 37.508292, lon: -77.9491 } } },
          { legType: 'TF', fix: { id: 'SOOBY', type: 'waypoint', position: { lat: 37.625461, lon: -77.530794 } } },
          { legType: 'TF', fix: { id: 'WAKAL', type: 'waypoint', position: { lat: 37.683517, lon: -77.574786 } } },
          { legType: 'TF', fix: { id: 'TRUIT', type: 'waypoint', position: { lat: 37.723083, lon: -77.456447 } } },
          { legType: 'TF', fix: { id: 'HIBOM', type: 'waypoint', position: { lat: 37.7813, lon: -77.395717 } } },
        ],
        enrouteTransitions: [],
        runwayTransitions: [],
      },
      {
        name: 'SPIDR5',
        runways: ['02', '16', '20', '34'],
        commonLegs: [
          { legType: 'IF', fix: { id: 'SPIDR', type: 'waypoint', position: { lat: 37.645478, lon: -77.852833 } } },
          { legType: 'TF', fix: { id: 'SOOBY', type: 'waypoint', position: { lat: 37.625461, lon: -77.530794 } } },
          { legType: 'TF', fix: { id: 'WAKAL', type: 'waypoint', position: { lat: 37.683517, lon: -77.574786 } } },
          { legType: 'TF', fix: { id: 'TRUIT', type: 'waypoint', position: { lat: 37.723083, lon: -77.456447 } } },
          { legType: 'TF', fix: { id: 'HIBOM', type: 'waypoint', position: { lat: 37.7813, lon: -77.395717 } } },
        ],
        enrouteTransitions: [],
        runwayTransitions: [],
      },
    ],

    approaches: [
      {
        name: 'ILS RWY 16',
        approachType: 'ILS',
        runway: '16',
        legs: [
          { legType: 'IF', fix: { id: 'GORDD', type: 'waypoint', position: { lat: 37.547581, lon: -77.348378 } } },
          { legType: 'CF', course: 157, fix: { id: 'MUGAW', type: 'waypoint', position: { lat: 37.57185, lon: -77.307706 } }, altitudeConstraint: { type: 'at', altitude: 2500 } },
        ],
        transitions: [],
        missedApproachLegs: [
          { legType: 'CA', course: 157, altitudeConstraint: { type: 'at', altitude: 2000 } },
        ],
        minimums: 460,
      },
      {
        name: 'ILS RWY 34',
        approachType: 'ILS',
        runway: '34',
        legs: [
          { legType: 'IF', fix: { id: 'FISSR', type: 'waypoint', position: { lat: 37.443239, lon: -77.346358 } } },
          { legType: 'CF', course: 337, fix: { id: 'RUTLD', type: 'waypoint', position: { lat: 37.385625, lon: -77.328314 } }, altitudeConstraint: { type: 'at', altitude: 2500 } },
        ],
        transitions: [],
        missedApproachLegs: [
          { legType: 'CA', course: 337, altitudeConstraint: { type: 'at', altitude: 2000 } },
        ],
        minimums: 460,
      },
      {
        name: 'ILS RWY 02',
        approachType: 'ILS',
        runway: '02',
        legs: [
          { legType: 'IF', fix: { id: 'BAIRR', type: 'waypoint', position: { lat: 37.348128, lon: -77.317119 } } },
          { legType: 'CF', course: 23, fix: { id: 'FISSR', type: 'waypoint', position: { lat: 37.443239, lon: -77.346358 } }, altitudeConstraint: { type: 'at', altitude: 2500 } },
        ],
        transitions: [],
        missedApproachLegs: [
          { legType: 'CA', course: 23, altitudeConstraint: { type: 'at', altitude: 2000 } },
        ],
        minimums: 520,
      },
    ],

    airspace: [
      {
        name: 'KRIC Class C Inner',
        class: 'C',
        floor: 0,
        ceiling: 4100,
        boundary: [
          { lat: 37.58, lon: -77.42 },
          { lat: 37.58, lon: -77.22 },
          { lat: 37.43, lon: -77.22 },
          { lat: 37.43, lon: -77.42 },
        ],
      },
      {
        name: 'KRIC Class C Outer',
        class: 'C',
        floor: 1300,
        ceiling: 4100,
        boundary: [
          { lat: 37.65, lon: -77.52 },
          { lat: 37.65, lon: -77.12 },
          { lat: 37.36, lon: -77.12 },
          { lat: 37.36, lon: -77.52 },
        ],
      },
      {
        name: 'RIC TRACON',
        class: 'E',
        floor: 0,
        ceiling: 17000,
        boundary: [
          { lat: 38.15, lon: -77.95 },
          { lat: 38.15, lon: -76.65 },
          { lat: 36.85, lon: -76.65 },
          { lat: 36.85, lon: -77.95 },
        ],
      },
    ],
  };
}
