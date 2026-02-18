import { STARSSizes } from '../rendering/STARSTheme';

/** Leader line direction (8 cardinal/ordinal directions) */
export type LeaderDirection = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

// Direction offsets: 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW
const DIRECTION_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 },  // 0: N (up)
  { dx: 1, dy: -1 },  // 1: NE
  { dx: 1, dy: 0 },   // 2: E (right)
  { dx: 1, dy: 1 },   // 3: SE
  { dx: 0, dy: 1 },   // 4: S (down)
  { dx: -1, dy: 1 },  // 5: SW
  { dx: -1, dy: 0 },  // 6: W (left)
  { dx: -1, dy: -1 }, // 7: NW
];

export interface DataBlockPosition {
  /** Aircraft ID */
  aircraftId: string;
  /** Leader line direction */
  direction: LeaderDirection;
  /** Data block upper-left corner in screen px (computed from target + direction) */
  x: number;
  y: number;
  /** Block width in pixels */
  width: number;
  /** Block height in pixels */
  height: number;
  /** Whether block has been manually repositioned */
  manuallyPositioned: boolean;
}

/**
 * Tracks data block positions per aircraft and handles auto-deconfliction.
 */
export class DataBlockManager {
  private blocks = new Map<string, DataBlockPosition>();

  /** Get or create a data block position for an aircraft */
  getBlock(aircraftId: string): DataBlockPosition | undefined {
    return this.blocks.get(aircraftId);
  }

  /** Calculate data block position from target screen position and direction */
  computeBlockPosition(
    targetX: number,
    targetY: number,
    direction: LeaderDirection,
    blockWidth: number,
    blockHeight: number
  ): { x: number; y: number; leaderEndX: number; leaderEndY: number } {
    const offset = DIRECTION_OFFSETS[direction];
    const len = STARSSizes.leaderLineLength;

    const leaderEndX = targetX + offset.dx * len;
    const leaderEndY = targetY + offset.dy * len;

    // Position data block so leader line connects to appropriate edge
    let blockX = leaderEndX;
    let blockY = leaderEndY;

    if (offset.dx < 0) blockX = leaderEndX - blockWidth;
    else if (offset.dx === 0) blockX = leaderEndX - blockWidth / 2;

    if (offset.dy < 0) blockY = leaderEndY - blockHeight;
    else if (offset.dy === 0) blockY = leaderEndY - blockHeight / 2;

    return { x: blockX, y: blockY, leaderEndX, leaderEndY };
  }

  /** Update block for an aircraft */
  updateBlock(
    aircraftId: string,
    targetX: number,
    targetY: number,
    blockWidth: number,
    blockHeight: number
  ): DataBlockPosition {
    let block = this.blocks.get(aircraftId);
    if (!block) {
      block = {
        aircraftId,
        direction: 1 as LeaderDirection, // Default NE
        x: 0,
        y: 0,
        width: blockWidth,
        height: blockHeight,
        manuallyPositioned: false,
      };
      this.blocks.set(aircraftId, block);
    }

    const pos = this.computeBlockPosition(
      targetX,
      targetY,
      block.direction,
      blockWidth,
      blockHeight
    );
    block.x = pos.x;
    block.y = pos.y;
    block.width = blockWidth;
    block.height = blockHeight;

    return block;
  }

  /** Cycle leader line direction for an aircraft */
  cycleDirection(aircraftId: string): void {
    const block = this.blocks.get(aircraftId);
    if (block) {
      block.direction = ((block.direction + 1) % 8) as LeaderDirection;
    }
  }

  /** Remove block for an aircraft that left scope */
  removeBlock(aircraftId: string): void {
    this.blocks.delete(aircraftId);
  }

  /** Clean up blocks for aircraft no longer present */
  cleanup(activeIds: Set<string>): void {
    for (const id of this.blocks.keys()) {
      if (!activeIds.has(id)) {
        this.blocks.delete(id);
      }
    }
  }

  /** Check if a screen point is inside any data block, return aircraft ID */
  hitTest(screenX: number, screenY: number): string | null {
    for (const block of this.blocks.values()) {
      if (
        screenX >= block.x &&
        screenX <= block.x + block.width &&
        screenY >= block.y &&
        screenY <= block.y + block.height
      ) {
        return block.aircraftId;
      }
    }
    return null;
  }
}
