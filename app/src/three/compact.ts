// Game-day packing, drawn: the tandem slots of the event-day ramp (same ids and pattern as the server's
// "tandem" layout in server/rampcast_server/parking.py, which decides who parks where and which tows happen).
// Boxes are the largest jet allowed plus 3 m; a jet parks deep only if nothing is in front of it yet, and when
// a deep jet leaves first the jets in front are towed out, set aside on the taxilane and put back.
import { ACCESS_E_X, ACCESS_X, type FlightPlan3D, type Geometry, HOT_LANE_Z, HOT_Z, PAD, type Pt, ROW_LANE_Z, TOW_ASIDE_MS, TWY } from "./layout";

export type Zone = "apron" | "hot" | "temp" | "pad";
export interface Slot {
  id: string; zone: Zone; column: string; depth: number; stand: Pt; lane: Pt; via: Pt[]; rank?: number;
  width: number; length: number; large: boolean; clear: Pt; // direction a towed jet is set aside along the lane
}

export const WINGTIP_CLEARANCE_M = 3;
// Box sizes: the largest jet allowed plus 3 m. Large cabin 30 m span and length; super-mid and smaller 21 m.
export const L_PITCH = 33.5, M_PITCH = 24.5, L_DEPTH = 33, M_DEPTH = 24;
// A jet taxiing on the lane sweeps 15 m either side, so the first box starts 18 m off the lane centreline,
// and the deepest nose stays 18 m clear of the next lane. 150 m between lanes leaves 114 m: 3 large or 4 medium.
const LANE_CLEAR = 18, BAND = 150, MIN = 60_000;
export const COLUMN_PATTERN = [true, false, true, false, false, true, false]; // true = large-cabin column; the rest of the row is equipment staging
const depthsFor = (box: number) => Math.floor((BAND - 2 * LANE_CLEAR) / box);

export function buildSlots(temp: boolean): Slot[] {
  const out: Slot[] = [];
  // Main apron: four row bands, each column four deep, off the row taxilane.
  for (let r = 0; r < 4; r++) {
    const laneZ = ROW_LANE_Z(r);
    let x = -152;
    COLUMN_PATTERN.forEach((large, c) => {
      const w = large ? L_PITCH : M_PITCH, len = large ? L_DEPTH : M_DEPTH, cx = x + w / 2;
      x += w;
      for (let d = 1; d <= depthsFor(len); d++) {
        out.push({
          id: `${"ABCD"[r]}${c + 1}-${d}`, zone: "apron", column: `${r}-${c}`, depth: d, large, width: w, length: len,
          stand: { x: cx, z: laneZ + LANE_CLEAR + len / 2 + (d - 1) * len }, lane: { x: cx, z: laneZ },
          via: [{ x: ACCESS_X, z: TWY.z }, { x: ACCESS_X, z: laneZ }], clear: { x: 1, z: 0 },
        });
      }
    });
  }
  // Drop-and-go hot spots by the terminal: one deep, for short turns only.
  for (let i = 0; i < 6; i++) {
    const cx = -125 + i * 38;
    out.push({
      id: `H${i + 1}`, zone: "hot", column: `h-${i}`, depth: 1, large: true, width: 38, length: 34,
      stand: { x: cx, z: HOT_Z }, lane: { x: cx, z: HOT_LANE_Z },
      via: [{ x: ACCESS_X, z: TWY.z }, { x: ACCESS_X, z: HOT_LANE_Z }], clear: { x: 1, z: 0 },
    });
  }
  // Temporary zone on the closed taxiway section east of the apron (only when that strategy is approved).
  if (temp) {
    for (let row = 0; row < 13; row++) {
      const z = -215 + row * L_PITCH;
      for (let d = 1; d <= 3; d++) {
        out.push({
          id: `T${row + 1}-${d}`, zone: "temp", column: `t-${row}`, depth: d, large: true, width: L_PITCH, length: L_DEPTH,
          stand: { x: ACCESS_E_X + LANE_CLEAR + L_DEPTH / 2 + (d - 1) * L_DEPTH, z }, lane: { x: ACCESS_E_X, z },
          via: [{ x: ACCESS_E_X, z: TWY.z }], clear: { x: 0, z: 1 },
        });
      }
    }
  }
  // Overflow pad to the west: last resort before sending a jet to a partner airport.
  for (let c = 0; c < 8; c++) {
    const cx = -660 + c * L_PITCH;
    for (let d = 1; d <= 5; d++) {
      out.push({
        id: `P${c + 1}-${d}`, zone: "pad", column: `p-${c}`, depth: d, large: true, width: L_PITCH, length: L_DEPTH,
        stand: { x: cx, z: PAD.z + LANE_CLEAR + L_DEPTH / 2 + (d - 1) * L_DEPTH }, lane: { x: cx, z: PAD.z },
        via: [{ x: PAD.x - 40, z: TWY.z }, { x: PAD.x - 40, z: PAD.z }], clear: { x: 1, z: 0 },
      });
    }
  }
  // Fill order: supervisors pack from one end so the open ramp stays in one piece.
  const cols = [...new Set(out.filter((s) => s.zone === "apron").map((s) => s.column))];
  out.forEach((s) => { s.rank = s.zone === "apron" ? cols.indexOf(s.column) : 0; });
  return out;
}

/** Where a server position of the game-day layout sits in the world: its slot geometry, keyed by id. */
export function tandemResolver(temp: boolean): (id: string) => Geometry | null {
  const byId = new Map(buildSlots(temp).map((sl) => [sl.id, sl]));
  return (id) => {
    const sl = byId.get(id);
    return sl ? { stand: sl.stand, lane: sl.lane, via: sl.via, clear: sl.clear, width: sl.width } : null;
  };
}

/** The busiest daylight moment in a window: a full ramp with the most jets being moved at once. */
export function busiestMoment(plans: FlightPlan3D[], fromIso: string, toIso: string, hours: readonly [number, number] = [8, 17]): number {
  let best = Date.parse(fromIso), bestScore = -1;
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 15 * MIN) {
    const h = new Date(t).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/Los_Angeles" });
    if (Number(h) % 24 < hours[0] || Number(h) % 24 > hours[1]) continue;
    let score = 0;
    for (const f of plans) {
      if (t >= f.taxiInEnd && t < f.pushStart) score += 1;                                 // on the ramp
      if (f.towMoves?.some((mv) => t >= mv.t && t < mv.t + (mv.dur ?? TOW_ASIDE_MS))) score += 4;      // set aside for a deeper jet
      if ((t >= f.pushStart && t < f.taxiOutStart + 2 * MIN) || (t >= f.L && t < f.taxiInEnd)) score += 3; // moving
      if (f.R && f.R - f.D > MIN && t >= f.taxiOutStart && t < f.R - 75_000) score += 2;    // waiting at the hold
    }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}
