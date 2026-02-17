import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { AircraftPerformance } from '@atc-sim/shared';

function findDataDir(): string {
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

/** In-memory aircraft performance database */
class PerformanceDB {
  private db = new Map<string, AircraftPerformance>();

  constructor() {
    this.load();
  }

  private load(): void {
    const aircraftDir = join(DATA_DIR, 'aircraft');
    if (!existsSync(aircraftDir)) {
      console.warn('[PerformanceDB] No aircraft data directory found, using defaults');
      this.loadDefaults();
      return;
    }

    const files = readdirSync(aircraftDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = readFileSync(join(aircraftDir, file), 'utf-8');
        const perf = JSON.parse(raw) as AircraftPerformance;
        this.db.set(perf.typeDesignator, perf);
      } catch (e) {
        console.warn(`[PerformanceDB] Failed to load ${file}:`, e);
      }
    }

    if (this.db.size === 0) {
      this.loadDefaults();
    }

    console.log(`[PerformanceDB] Loaded ${this.db.size} aircraft types`);
  }

  private loadDefaults(): void {
    const defaultPerf: AircraftPerformance = {
      typeDesignator: 'B738',
      name: 'Boeing 737-800',
      wakeCategory: 'LARGE',
      speed: {
        vminClean: 215,
        vminFlaps: 138,
        vapp: 145,
        vref: 137,
        vmaxBelow10k: 250,
        vmo: 340,
        mmo: 0.82,
        typicalCruiseIAS: 280,
        typicalCruiseMach: 0.79,
      },
      climb: {
        initialRate: 2800,
        rateAt10k: 2400,
        rateAt24k: 1700,
        rateAt35k: 750,
        accelAltitude: 1000,
      },
      descent: {
        standardRate: 1800,
        maxRate: 3500,
        idleGradient: 3.0,
      },
      turn: {
        standardRate: 3.0,
        maxBank: 30,
      },
      ceiling: 41000,
      capability: { rnav: true, rnavGps: true, ils: true, vor: true, dme: true },
    };
    this.db.set(defaultPerf.typeDesignator, defaultPerf);
  }

  get(typeDesignator: string): AircraftPerformance | undefined {
    return this.db.get(typeDesignator);
  }

  getOrDefault(typeDesignator: string): AircraftPerformance {
    return this.db.get(typeDesignator) ?? this.db.get('B738')!;
  }

  allTypes(): string[] {
    return Array.from(this.db.keys());
  }

  randomType(): string {
    const types = this.allTypes();
    return types[Math.floor(Math.random() * types.length)];
  }
}

export const performanceDB = new PerformanceDB();
