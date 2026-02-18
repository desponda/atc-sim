# ATC-Sim

A browser-based TRACON ATC simulator modeled on Richmond International Airport (KRIC), built to STARS display fidelity. Handles IFR arrivals and departures, instrument approaches, conflict detection, and ATC scoring.

## Architecture

Pnpm monorepo with three packages:

| Package | Description |
|---|---|
| `@atc-sim/shared` | TypeScript types, geo math utilities (haversine, bearing, cross-track) |
| `@atc-sim/server` | Node.js simulation engine — physics, AI pilots, conflict detection |
| `@atc-sim/client` | React 18 + HTML5 Canvas STARS radar display |

```
atc-sim/
├── data/airports/kric.json     # Airport geometry, SIDs, STARs, approaches, video maps
├── packages/
│   ├── shared/                 # Shared types + geo utilities
│   ├── server/
│   │   ├── src/ai/             # PilotAI, FlightPlanExecutor, RadioComms
│   │   ├── src/commands/       # ATC command parser + executor
│   │   ├── src/engine/         # Physics, conflict detection, simulation loop
│   │   └── src/game/           # Scenario generator, scoring engine
│   └── client/
│       ├── src/radar/          # 4-layer canvas system (Map/Target/Overlay/Interaction)
│       ├── src/ui/             # Status bar, flight strips, comm log, event log
│       ├── src/audio/          # Web Audio API synthesized sound effects
│       └── src/state/          # Zustand game store
├── tools/vice-extract/         # Go utility for extracting Vice video maps
└── playtest-*.ts               # Automated playtest scripts (WebSocket bots)
```

## Quick Start

```bash
pnpm install
pnpm dev
```

- Client: http://localhost:5173
- Server API/WebSocket: http://localhost:3001

## Stack

- **Client**: React 18, TypeScript, Vite, Zustand, HTML5 Canvas
- **Server**: Node.js, Express, `ws` WebSocket, `tsx` watch mode
- **Simulation**: 1 Hz tick loop, tick-based pilot delays, true/magnetic bearing separation

## Radar Display

4-layer canvas composite:

1. **Map** — video maps (from Vice ZDC data), runways, fixes, airspace rings
2. **Target** — primary returns, history trails (5 positions), velocity vectors, data blocks
3. **Overlay** — range/bearing line (RBL), selected-aircraft halo
4. **Interaction** — transparent hit-test surface for mouse events

Colors follow real STARS: white for tracked targets, cyan for selected, green for untracked contacts, blue primary returns. History trails fade through 5 shades of blue.

## ATC Command Syntax

Commands are free-text, parsed with a flexible tokenizer. The callsign prefix is optional when an aircraft is selected on the scope.

| Action | Example commands |
|---|---|
| Altitude | `UAL123 climb 8000` · `descend FL180` · `maintain 4000` |
| Heading | `UAL123 fly heading 270` · `turn left 090` |
| Speed | `UAL123 speed 250` · `reduce 210` |
| ILS approach | `UAL123 cleared ILS 16` · `ci16` · `int 16` |
| RNAV approach | `UAL123 cleared RNAV 16` · `cr16` |
| Visual approach | `UAL123 cleared visual 16` · `cv16` |
| SID/STAR | `UAL123 climb via SID` · `descend via STAR` |
| Direct fix | `UAL123 direct SPIDR` · `proceed direct COLIN` |
| Radar handoff | `UAL123 .ho` (initiate) · Ctrl+click data block |
| Report field | `UAL123 rfs` (report field in sight) |
| Report traffic | `UAL123 rts DAL456` (report traffic in sight) |
| Hold | `UAL123 hold at SPIDR` |
| Speed cancel | `UAL123 cancel speed restrictions` |

## Keyboard / Mouse

| Input | Action |
|---|---|
| `?` | Toggle command reference overlay |
| `Esc` | Clear RBL measurement |
| Double-click scope | Set RBL anchor point |
| Left-click drag | Pan scope |
| Scroll wheel | Zoom in / out |
| Ctrl+click data block | Initiate radar handoff to center |
| Right-click data block | Cycle leader line direction |

## Development

```bash
pnpm build                          # Build all packages (shared → server → client)
pnpm test                           # Run vitest unit tests
pnpm --filter @atc-sim/server dev   # Server only (port 3001)
pnpm --filter @atc-sim/client dev   # Client only (port 5173)
```

### Playtest Scripts

Root-level `playtest-*.ts` scripts connect via WebSocket and drive automated scenarios:

```bash
npx tsx playtest-arrivals.ts     # Heavy arrival flow to RWY 16 ILS
npx tsx playtest-mixed.ts        # Mixed arrivals and departures
npx tsx playtest-agent.ts        # AI controller agent (auto-sequences traffic)
```

### Video Maps

Maps are extracted from the [Vice](https://github.com/mmp/vice) ZDC videomaps file using the Go tool in `tools/vice-extract/`. The extracted data lives in `data/airports/kric.json` (23 maps, ~170k points, clipped to 80 nm radius around KRIC).

## Airport Data: KRIC

Key geometry in `data/airports/kric.json`:

| Item | Details |
|---|---|
| RWY 16 | Hdg 157°, ILS 157°, threshold 37.5166°N / 77.3236°W, elev 167 ft |
| SIDs | COLIN8 (top 5000 ft), KALLI7 (top 5000 ft) |
| STARs | DUCXS5, POWTN5, SPIDR5 |
| Approaches | ILS 16, RNAV 16, RNAV 34 |
| Magnetic variation | −10° (true = magnetic + 10°) |

## Known Design Notes

- All altitudes are ft MSL; ILS/RNAV minimums compared directly against `ac.altitude`
- Geo functions (`destinationPoint`, `crossTrackDistance`) require **true** bearings — use `initialBearing(threshold, end)`, not `runway.ilsCourse` (which is magnetic)
- Pilot AI uses tick-counting for delays, not `setTimeout` (must survive time-scale changes)
- ILS localizer snap is capped at 0.04 nm/tick so intercept is visually smooth
