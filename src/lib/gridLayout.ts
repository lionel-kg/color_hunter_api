// Layout d'une grille en fonction du mode de partie.
// Le canvas visuel reste toujours 3×3 (9 positions), mais en duo (teamSize=2)
// la case centrale (index 4) est laissée vide → 8 photos au lieu de 9.

export const GRID_COLS = 3;
export const GRID_ROWS = 3;
export const GRID_CENTER_INDEX = 4; // 0-indexed

export function isDuoTeam(mode: string, teamSize: number): boolean {
  return mode === 'TEAM' && teamSize === 2;
}

export function slotCount(mode: string, teamSize: number): number {
  return isDuoTeam(mode, teamSize) ? 8 : 9;
}

// Positions valides dans le canvas 3×3 pour le mode donné (centre exclu en duo)
export function validGridPositions(mode: string, teamSize: number): number[] {
  if (isDuoTeam(mode, teamSize)) {
    return [0, 1, 2, 3, 5, 6, 7, 8];
  }
  return [0, 1, 2, 3, 4, 5, 6, 7, 8];
}
