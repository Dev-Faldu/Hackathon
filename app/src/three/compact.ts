// Event-day packing: how an FBO really squeezes the ramp on game day. Jets go in tandem columns three or
// four deep, wingtip to wingtip and nose to tail with about 3 m clearance, instead of the 48 marked stands.
// A jet can only be parked deep if nothing is in front of it yet; when a deep jet leaves first, the jets in
// front are towed out, set aside on the taxilane and towed back. Wing walkers walk every one of those moves.
import type { ParkingPlan, SizeClass } from "../lib/types";
import {
  ACCESS_E_X, ACCESS_X, DIMS, type FlightMeta, type FlightPlan3D, flightMetas, HOT_LANE_Z, HOT_Z, PAD, planFor, type Pt,
  ROW_LANE_Z, TOW_ASIDE_MS, TWY,
} from "./layout";

export type Zone = "apron" | "hot" | "temp" | "pad";
export interface Slot {
  id: string; zone: Zone; column: string; depth: number; stand: Pt; lane: Pt; via: Pt[]; rank?: number;
  width: number; length: number; large: boolean; clear: Pt; // direction a towed jet is set aside along the lane
}

export const WINGTIP_CLEARANCE_M = 3;
// Box sizes: the largest jet allowed plus 3 m. Large cabin 30 m span and length; super-mid and smaller 21 m.
const L_PITCH = 33.5, M_PITCH = 24.5, L_DEPTH = 33, M_DEPTH = 24;
// A jet taxiing on the lane sweeps 15 m either side, so the first box starts 18 m off the lane centreline,
// and the deepest nose stays 18 m clear of the next lane. 150 m between lanes leaves 114 m: 3 large or 4 medium.
const LANE_CLEAR = 18, BAND = 150;
const COLUMN_PATTERN = [true, false, true, false, false, true, false]; // true = large-cabin column; the rest of the row is equipment staging
const depthsFor = (box: number) => Math.floor((BAND - 2 * LANE_CLEAR) / box);

function buildSlots(temp: boolean): Slot[] {
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

const fits = (s: Slot, size: SizeClass) => s.large || (size !== "large" && DIMS[size].span <= M_PITCH - WINGTIP_CLEARANCE_M);
const ZONE_COST: Record<Zone, number> = { apron: 0, hot: 0, temp: 2, pad: 10 };
const MIN = 60_000;

interface Placed { m: FlightMeta; slot: Slot; L: number; D: number; told: number }

/** Departure time the owner gave the FBO when booking. Long stays drift most: owners leave when the party ends. */
function toldDeparture(id: string, L: number, D: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const u1 = ((h >>> 0) % 10007) / 10007 + 1e-6, u2 = ((h >>> 11) % 9973) / 9973;
  const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const stayH = (D - L) / 3_600_000, sigmaH = stayH > 20 ? 3 : stayH > 3 ? 1 : 0;
  return Math.max(L + 30 * MIN, D + gauss * sigmaH * 3_600_000);
}

export interface CompactResult {
  plans: FlightPlan3D[]; slots: Slot[]; tows: number; partner: number; peak: number; capacity: number; changedPlans: number;
}

/** Packs every visit of the week into tandem slots and works out the tows that packing costs. */
export function buildCompactPlans(plan: ParkingPlan, temp: boolean): CompactResult {
  const slots = buildSlots(temp);
  const metas = flightMetas(plan).sort((a, b) => Date.parse(a.arriveIso) - Date.parse(b.arriveIso));
  const bySlot = new Map<string, Placed[]>(), byColumn = new Map<string, Placed[]>();
  const placed: Placed[] = [];
  let partner = 0;
  for (const m of metas) {
    const L = Date.parse(m.arriveIso), D = Date.parse(m.departIso), short = D - L <= 3 * 3_600_000;
    const told = toldDeparture(m.id, L, D); // packing order uses what the owner said, not what will happen
    let best: Slot | null = null, bestCost = Infinity;
    for (const s of slots) {
      if (!fits(s, m.size) || (s.zone === "hot" && !short)) continue;
      if ((bySlot.get(s.id) ?? []).some((o) => o.L < D + 5 * MIN && L < o.D + 5 * MIN)) continue;
      const col = byColumn.get(s.column) ?? [];
      // Hard rule: you cannot taxi into a deep slot past a jet already parked in front of it.
      if (col.some((o) => o.slot.depth < s.depth && o.L <= L && L < o.D)) continue;
      let blocks = 0;
      for (const o of col) {
        if (!(o.L < told && L < o.told)) continue;
        if (o.slot.depth > s.depth && o.told > L && o.told < told) blocks++;   // we would sit in front of a jet leaving earlier
        if (o.slot.depth < s.depth && told > o.L && told < o.told) blocks++;   // a jet in front of us is still there when we leave
      }
      const depthPref = short ? s.depth * 0.6 : -s.depth * 0.4;
      const cost = blocks * 3 + ZONE_COST[s.zone] + depthPref + (s.zone === "hot" ? -3 : 0) + (s.large && m.size !== "large" ? 0.8 : 0)
        + 0.12 * (s.rank ?? 0);
      if (cost < bestCost) { bestCost = cost; best = s; }
    }
    if (!best) { partner++; continue; }
    const p: Placed = { m, slot: best, L, D, told };
    placed.push(p);
    bySlot.set(best.id, [...(bySlot.get(best.id) ?? []), p]);
    byColumn.set(best.column, [...(byColumn.get(best.column) ?? []), p]);
  }

  // Plans first (pushback times depend on the taxi route), then the tows each departure forces.
  const plans = new Map<string, FlightPlan3D>();
  for (const p of placed) {
    const fp = planFor({ ...p.m, position: p.slot.id, kind: p.slot.zone }, { stand: p.slot.stand, lane: p.slot.lane, via: p.slot.via });
    fp.towMoves = [];
    plans.set(p.m.id, fp);
  }
  let tows = 0;
  for (const p of placed) {
    const leaving = plans.get(p.m.id)!;
    const blockers = (byColumn.get(p.slot.column) ?? [])
      .filter((o) => o.slot.depth < p.slot.depth && o.L < leaving.pushStart && leaving.pushStart < plans.get(o.m.id)!.pushStart)
      .sort((a, b) => a.slot.depth - b.slot.depth);
    blockers.forEach((o, i) => {
      const step = (i + 1) * (o.slot.width + 6);
      plans.get(o.m.id)!.towMoves!.push({ t: leaving.pushStart - 0.35 * TOW_ASIDE_MS, dx: o.slot.clear.x * step, dz: o.slot.clear.z * step });
      tows += 2; // out and back in
    });
  }

  // Peak jets on the ramp at once, sampled every 15 minutes.
  let peak = 0;
  if (placed.length) {
    const t0 = Math.min(...placed.map((p) => p.L)), t1 = Math.max(...placed.map((p) => p.D));
    for (let t = t0; t <= t1; t += 15 * MIN) peak = Math.max(peak, placed.filter((p) => p.L <= t && t < p.D).length);
  }
  const changedPlans = placed.filter((p) => Math.abs(p.told - p.D) > 30 * MIN).length;
  return { plans: [...plans.values()], slots, tows, partner, peak, capacity: slots.filter((s) => s.zone !== "hot").length, changedPlans };
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
      if (f.towMoves?.some((mv) => t >= mv.t && t < mv.t + TOW_ASIDE_MS)) score += 4;      // set aside for a deeper jet
      if ((t >= f.pushStart && t < f.taxiOutStart + 2 * MIN) || (t >= f.L && t < f.taxiInEnd)) score += 3; // moving
      if (f.R && f.R - f.D > MIN && t >= f.taxiOutStart && t < f.R - 75_000) score += 2;    // waiting at the hold
    }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}
