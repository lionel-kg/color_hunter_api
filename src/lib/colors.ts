// Palette officielle Color Hunt — couleurs tirées au lancement d'une partie

export type ColorEntry = { hex: string; name: string };

export const HUNT_PALETTE: ColorEntry[] = [
  { hex: "#FF0000", name: "Rouge" },
  { hex: "#FF6600", name: "Orange" },
  { hex: "#FFE000", name: "Jaune" },
  { hex: "#00BB00", name: "Vert" },
  { hex: "#00BBAA", name: "Turquoise" },
  { hex: "#0088FF", name: "Bleu" },
  { hex: "#000000", name: "Noir" },
  { hex: "#8800CC", name: "Violet" },
  { hex: "#FF0055", name: "Rose vif" },
];

export function pickRandomColor(): ColorEntry {
  return HUNT_PALETTE[Math.floor(Math.random() * HUNT_PALETTE.length)];
}

export function pickDistinctColors(count: number): ColorEntry[] {
  const pool = [...HUNT_PALETTE].sort(() => Math.random() - 0.5);
  return pool.slice(0, Math.min(count, pool.length));
}

export function generateInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 5 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");
}
