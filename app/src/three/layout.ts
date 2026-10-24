// World layout (metres, Y up) and the motion of every flight through approach, landing, taxi, parking,
// pushback, taxi-out and take-off. Schematic: the geometry is plausible, not a survey of KVNY.
// Orientation: +X runs along runway 16R's heading (160 deg magnetic), so a compass bearing b points at world
// angle b - 70 deg measured from +Z toward +X. Traffic lands and departs 16R (south flow, VNY's usual).
import type { ParkingPlan, ParkingPosition, SizeClass } from "../lib/types";

export const RWY = { z: -330, x0: -1220, x1: 1220, width: 46 };   // 16R/34L: 8,001 ft x 150 ft
export const RWY_L = { z: -543, x0: -760, x1: 462, width: 23 };   // 16L/34R: 4,011 ft x 75 ft, 700 ft east of 16R
export const TWY = { z: -255, x0: -1200, x1: 900, width: 23 };     // parallel taxiway A
export const COMPASS_OFFSET_DEG = 70;
export const EXIT_X = 420;          // high-speed exit after landing roll
export const HOLD_X = -1160;        // departure holding point, taxiway A1 at the 16R end
export const ACCESS_X = -175;       // main apron access lane (west)
export const ACCESS_E_X = 112;      // east access lane, serves the temporary zone
export const ROW_LANE_Z = (r: number) => -205 + r * 150;
export const COL_X = (c: number) => -110 + (c - 1) * 56;
export const STAND_Z = (r: number, d: number) => ROW_LANE_Z(r) + 34 + (d - 1) * 40;
export const STAND_SIZE = { w: 50, d: 38 };
export const HOT_LANE_Z = 440;
export const HOT_X = (i: number) => -120 + (i - 1) * 62;
export const HOT_Z = 474;
export const TEMP_X = (i: number) => 160 + ((i - 1) % 2) * 62;
export const TEMP_Z = (i: number) => -170 + Math.floor((i - 1) / 2) * 62;
export const PAD = { x: -600, z: -170, cols: 4, cell: 52 };
export const TERMINAL = { x: -30, z: 540, w: 210, d: 34, h: 16 };

export const DIMS: Record<SizeClass, { span: number; length: number; r: number; color: string }> = {
  light: { span: 15.5, length: 14.5, r: 0.85, color: "#0EA5E9" },
  mid: { span: 17.5, length: 16.5, r: 1.0, color: "#3B82F6" },
  super_mid: { span: 21, length: 20.8, r: 1.15, color: "#6366F1" },
  large: { span: 30, length: 30, r: 1.45, color: "#1D4ED8" },
  other: { span: 18, length: 17, r: 1.0, color: "#64748B" },
};

const ROWS = "ABCD";

export interface Pt { x: number; z: number }
/** A parking position in the world: the stand, the lane point that serves it, the route in, which way a towed
 *  jet is set aside along the lane, and how wide the box is. */
export interface Geometry { stand: Pt; lane: Pt; via: Pt[]; clear: Pt; width: number }

/** Where a marked stand sits, and the lane point an aircraft uses to reach it. */
export function positionGeometry(p: ParkingPosition): Geometry {
  if (p.kind === "stand") {
    const r = ROWS.indexOf(p.row), x = COL_X(p.column);
    return { stand: { x, z: STAND_Z(r, p.depth) }, lane: { x, z: ROW_LANE_Z(r) }, via: [{ x: ACCESS_X, z: TWY.z }, { x: ACCESS_X, z: ROW_LANE_Z(r) }],
      clear: { x: 1, z: 0 }, width: STAND_SIZE.w };
  }
  if (p.kind === "hot") {
    const x = HOT_X(p.column);
    return { stand: { x, z: HOT_Z }, lane: { x, z: HOT_LANE_Z }, via: [{ x: ACCESS_X, z: TWY.z }, { x: ACCESS_X, z: HOT_LANE_Z }], clear: { x: 1, z: 0 }, width: 60 };
  }
  const x = TEMP_X(p.column), z = TEMP_Z(p.column);
  return { stand: { x, z }, lane: { x: ACCESS_E_X, z }, via: [{ x: ACCESS_E_X, z: TWY.z }], clear: { x: 0, z: 1 }, width: 56 };
}

/** Overflow pad cells (8 columns, 5 deep, the same boxes as the game-day pad) for jets with no position. */
function padCell(i: number): Geometry {
  const c = i % 8, d = Math.floor(i / 8) % 5, x = -660 + c * 33.5;
  return { stand: { x, z: PAD.z + 34.5 + d * 33 }, lane: { x, z: PAD.z }, via: [{ x: PAD.x - 40, z: TWY.z }, { x: PAD.x - 40, z: PAD.z }], clear: { x: 1, z: 0 }, width: 33.5 };
}

// ---------- polylines ----------
interface Path { pts: Pt[]; cum: number[]; len: number }
function path(pts: Pt[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] };
}
function at(p: Path, s: number): Pt {
  const d = Math.max(0, Math.min(p.len, s));
  let i = 1;
  while (i < p.cum.length - 1 && p.cum[i] < d) i++;
  const seg = p.cum[i] - p.cum[i - 1] || 1, f = (d - p.cum[i - 1]) / seg;
  return { x: p.pts[i - 1].x + (p.pts[i].x - p.pts[i - 1].x) * f, z: p.pts[i - 1].z + (p.pts[i].z - p.pts[i - 1].z) * f };
}
/** Heading from a short look-ahead, so turns at corners come out smooth. */
function headingAt(p: Path, s: number): number {
  const a = at(p, s - 6), b = at(p, s + 14);
  return Math.atan2(b.x - a.x, b.z - a.z);
}

// ---------- flight plans ----------
const MIN = 60_000;
const TAXI_MS_PER_M = 1000 / 8.5;      // ~16 kt taxi speed
export type Phase = "approach" | "rollout" | "taxi_in" | "parked" | "tow" | "pushback" | "taxi_out" | "queue" | "lineup" | "takeoff" | "climb";

/** A tow that pulls a jet out of a tandem slot, parks it aside on the taxilane, then puts it back. */
export interface TowMove { t: number; dx: number; dz: number; dur?: number }
export const TOW_ASIDE_MS = 10 * MIN;

export interface FlightPlan3D {
  id: string; size: SizeClass; position: string; kind: string; stayType: string; origin: string; booking: string | null;
  L: number; D: number; stand: Pt; lane: Pt; inPath: Path; outPath: Path; taxiInEnd: number; pushStart: number; taxiOutStart: number;
  tows: number[]; towMoves?: TowMove[]; arriveIso: string; departIso: string;
  other?: boolean;   // another FBO's flight: shares the runway and taxiway, parks on their ramp
  ghost?: boolean;   // parked out of view, on a ramp beyond the east end of the taxiway
  R?: number;        // wheels-up time the runway actually gave it (>= D when there is a queue)
  ahead?: number[];  // when each jet ahead of it in the departure queue starts lining up
  sched?: { L: number; taxiInEnd: number }; // landing time before arrival spacing
}

export interface FlightMeta {
  id: string; size: SizeClass; position: string; kind: string; stayType: string; origin: string; booking: string | null;
  arriveIso: string; departIso: string;
}

/** Paths and timings for one visit: land, exit, taxi to the slot, park, push back, taxi to the hold, depart. */
export function planFor(m: FlightMeta, g: { stand: Pt; lane: Pt; via: Pt[] }, tows: number[] = []): FlightPlan3D {
  const L = Date.parse(m.arriveIso), D = Date.parse(m.departIso);
  const exit: Pt[] = [{ x: EXIT_X - 40, z: RWY.z }, { x: EXIT_X, z: RWY.z + 30 }, { x: EXIT_X - 20, z: TWY.z }];
  const inPath = path([...exit, ...g.via, g.lane, g.stand]);
  const outPath = path([g.lane, ...[...g.via].reverse(), { x: HOLD_X + 60, z: TWY.z }, { x: HOLD_X, z: TWY.z }]);
  const taxiInEnd = L + 1.2 * MIN + inPath.len * TAXI_MS_PER_M;
  const taxiOutStart = D - 75_000 - outPath.len * TAXI_MS_PER_M;
  return { ...m, L, D, stand: g.stand, lane: g.lane, inPath, outPath, taxiInEnd, pushStart: taxiOutStart - 100_000, taxiOutStart, tows };
}

/** Every visit in the parking plan, as drawn and animated in the 3D world. */
export function flightMetas(plan: ParkingPlan): FlightMeta[] {
  const posById = new Map(plan.positions.map((p) => [p.id, p]));
  return plan.gantt.flatMap((row) => row.bars.map((b) => ({
    id: b.flight_id, size: b.size_class, position: row.position, kind: posById.get(row.position)?.kind ?? "overflow",
    stayType: b.stay_type, origin: b.origin, booking: b.booking_code, arriveIso: b.start, departIso: b.end,
  })));
}

/** Every visit in the server's parking plan, in the world. `resolve` places game-day tandem slots by id.
 *  Each tow in the plan becomes a set-aside: the jet in front is pulled out onto the lane while the deeper jet
 *  gets in or out, then pushed back into its slot. */
export function buildPlans(plan: ParkingPlan, resolve?: (id: string) => Geometry | null): FlightPlan3D[] {
  const posById = new Map(plan.positions.map((p) => [p.id, p]));
  const geomOf = new Map<string, Geometry>();
  // Jets with no position wait on the overflow pad, in a cell that is free for their whole stay.
  const padBusy: [number, number][][] = Array.from({ length: 40 }, () => []);
  const padFor = (m: FlightMeta) => {
    const L = Date.parse(m.arriveIso), D = Date.parse(m.departIso);
    const i = Math.max(0, padBusy.findIndex((b) => !b.some(([a, z]) => a < D + 10 * MIN && L < z + 10 * MIN)));
    padBusy[i].push([L, D]);
    return padCell(i);
  };
  const plans = flightMetas(plan).sort((a, b) => Date.parse(a.arriveIso) - Date.parse(b.arriveIso)).map((m) => {
    const pos = posById.get(m.position);
    const g = (resolve && pos ? resolve(pos.id) : null) ?? (pos && pos.kind !== "pad" ? positionGeometry(pos) : padFor(m));
    geomOf.set(m.id, g);
    const f = planFor(m, g);
    f.towMoves = [];
    return f;
  });
  const byId = new Map(plans.map((f) => [f.id, f]));
  const groups = new Map<string, typeof plan.tows>();
  plan.tows.forEach((t) => { const k = `${t.for_flight}|${t.kind}`; groups.set(k, [...(groups.get(k) ?? []), t]); });
  groups.forEach((tows) => {
    // Several jets in front: the front one comes out first and goes furthest, the next follows 90 s later,
    // and they go back in reverse order, so the column empties and refills like a real tow crew does it.
    tows.sort((a, b) => (posById.get(a.from)?.depth ?? 0) - (posById.get(b.from)?.depth ?? 0));
    const n = tows.length, stagger = 90_000, total = TOW_ASIDE_MS + (n - 1) * 2 * MIN;
    const innerDur = total - 2 * stagger * (n - 1), innerHold = stagger * (n - 1) + 0.35 * innerDur;
    const deep = byId.get(tows[0].for_flight);
    if (!deep) return;
    // The innermost jet's hold covers the deep jet's last minute of taxi-in, or its whole pushback.
    const t0 = tows[0].kind === "arrival" ? deep.taxiInEnd - MIN - innerHold : deep.pushStart - 12_000 - innerHold;
    tows.forEach((t, i) => {
      const front = byId.get(t.flight_id), g = geomOf.get(t.flight_id);
      if (!front || !g) return;
      const step = (n - i) * (g.width + 6);
      front.towMoves!.push({ t: t0 + i * stagger, dur: total - 2 * stagger * i, dx: g.clear.x * step, dz: g.clear.z * step });
    });
  });
  return plans;
}

export interface Pose { visible: boolean; x: number; y: number; z: number; heading: number; pitch: number; phase: Phase; tug: boolean }
const HIDDEN: Pose = { visible: false, x: 0, y: 0, z: 0, heading: 0, pitch: 0, phase: "parked", tug: false };
const ease = (f: number) => 1 - (1 - f) * (1 - f);

/** Where a flight is, and what it is doing, at simulated time t (ms). */
export function poseAt(f: FlightPlan3D, t: number): Pose {
  const app0 = f.L - 3 * MIN, roll1 = f.L + 1.2 * MIN, R = f.R ?? f.D;
  if (t < app0 || t > R + 1.6 * MIN) return HIDDEN;
  if (t < f.L) {
    const k = (t - app0) / (3 * MIN);
    // 3-degree glide slope from ~8 km out; touchdown 250 m past the threshold.
    return { visible: true, x: -9000 + (RWY.x0 + 250 + 9000) * k, y: 425 * (1 - k), z: RWY.z, heading: Math.PI / 2, pitch: 0.06, phase: "approach", tug: false };
  }
  if (t < roll1) {
    const k = ease((t - f.L) / (1.2 * MIN));
    return { visible: true, x: RWY.x0 + 250 + (EXIT_X - 40 - RWY.x0 - 250) * k, y: 0, z: RWY.z, heading: Math.PI / 2, pitch: 0, phase: "rollout", tug: false };
  }
  if (t < f.taxiInEnd && t < f.pushStart) {
    const s = (t - roll1) / TAXI_MS_PER_M;
    const p = at(f.inPath, s);
    return { visible: true, x: p.x, y: 0, z: p.z, heading: headingAt(f.inPath, s), pitch: 0, phase: "taxi_in", tug: false };
  }
  const parkedHeading = Math.atan2(f.stand.x - f.lane.x, f.stand.z - f.lane.z);
  if (t < f.pushStart && f.ghost) return HIDDEN;
  if (t < f.pushStart) {
    for (const mv of f.towMoves ?? []) {
      const dur = mv.dur ?? TOW_ASIDE_MS;
      if (t >= mv.t && t < mv.t + dur) {
        // Out of the slot (25%), aside along the taxilane (10%), hold while the deep jet passes (35%), back (10%), in (20%).
        const k = (t - mv.t) / dur, ox = f.lane.x - f.stand.x, oz = f.lane.z - f.stand.z;
        let x: number, z: number;
        if (k < 0.25) { const e = ease(k / 0.25); x = f.stand.x + ox * e; z = f.stand.z + oz * e; }
        else if (k < 0.35) { const e = ease((k - 0.25) / 0.1); x = f.lane.x + mv.dx * e; z = f.lane.z + mv.dz * e; }
        else if (k < 0.7) { x = f.lane.x + mv.dx; z = f.lane.z + mv.dz; }
        else if (k < 0.8) { const e = ease((k - 0.7) / 0.1); x = f.lane.x + mv.dx * (1 - e); z = f.lane.z + mv.dz * (1 - e); }
        else { const e = ease((k - 0.8) / 0.2); x = f.lane.x - ox * e; z = f.lane.z - oz * e; }
        return { visible: true, x, y: 0, z, heading: parkedHeading, pitch: 0, phase: "tow", tug: true };
      }
    }
    for (const tw of f.tows) {
      if (t >= tw && t < tw + 6 * MIN) {
        const k = (t - tw) / (6 * MIN), out = k < 0.5 ? ease(k * 2) : ease((1 - k) * 2);
        return { visible: true, x: f.stand.x + (f.lane.x - f.stand.x) * out * 0.9, y: 0, z: f.stand.z + (f.lane.z - f.stand.z) * out * 0.9,
          heading: parkedHeading, pitch: 0, phase: "tow", tug: true };
      }
    }
    return { visible: true, x: f.stand.x, y: 0, z: f.stand.z, heading: parkedHeading, pitch: 0, phase: "parked", tug: false };
  }
  if (t < f.taxiOutStart) {
    const k = ease((t - f.pushStart) / (f.taxiOutStart - f.pushStart));
    return { visible: true, x: f.stand.x + (f.lane.x - f.stand.x) * k, y: 0, z: f.stand.z + (f.lane.z - f.stand.z) * k,
      heading: parkedHeading, pitch: 0, phase: "pushback", tug: true };
  }
  const lineup0 = R - 75_000, roll0 = R - 45_000;
  if (t < lineup0) {
    // Taxi until the tail of the departure queue, then creep up one place each time a jet ahead lines up.
    let k = 0;
    for (const lv of f.ahead ?? []) k += Math.min(1, Math.max(0, (lv + QUEUE_CREEP_MS - t) / QUEUE_CREEP_MS));
    const free = (t - f.taxiOutStart) / TAXI_MS_PER_M, stop = f.outPath.len - k * QUEUE_GAP_M, s = Math.min(free, stop);
    const p = at(f.outPath, s);
    return { visible: true, x: p.x, y: 0, z: p.z, heading: headingAt(f.outPath, s), pitch: 0, phase: free > stop + 2 ? "queue" : "taxi_out", tug: false };
  }
  if (t < roll0) {
    const k = (t - lineup0) / 30_000;
    return { visible: true, x: HOLD_X + 40 * k, y: 0, z: TWY.z + (RWY.z - TWY.z) * k, heading: Math.PI / 2 + (1 - k) * 0.9, pitch: 0, phase: "lineup", tug: false };
  }
  if (t < R) {
    const k = (t - roll0) / 45_000;
    return { visible: true, x: HOLD_X + 40 + (150 - HOLD_X - 40) * k * k, y: 0, z: RWY.z, heading: Math.PI / 2, pitch: k > 0.85 ? 0.12 : 0, phase: "takeoff", tug: false };
  }
  const k = (t - R) / (1.6 * MIN);
  return { visible: true, x: 150 + 9000 * k, y: 700 * k * (1.3 - 0.3 * k), z: RWY.z, heading: Math.PI / 2, pitch: 0.16, phase: "climb", tug: false };
}

/** LA local hour (PST) for lighting. */
export const localHour = (ms: number) => ((((ms / 3_600_000 - 8) % 24) + 24) % 24);

/** Sun elevation and azimuth (degrees) for a February day in the San Fernando Valley; approximate. */
export function sun(ms: number): { el: number; az: number } {
  const h = localHour(ms), rise = 6.75, set = 17.65;
  const day = (h - rise) / (set - rise);
  const el = day >= 0 && day <= 1 ? 48 * Math.sin(Math.PI * day) : -18 * Math.sin(Math.PI * Math.min(1, Math.abs(day < 0 ? day : day - 1) * 1.5));
  const az = 110 + 140 * Math.max(0, Math.min(1, day));
  return { el, az };
}

// ---------- the other FBOs at VNY ----------
export const OTHER = { accessX: 455, x0: 470, x1: 1000, lanes: [-205, -55, 95], colPitch: 30, depthPitch: 31, depths: 3, setback: 34 };

export interface Movement { id: string; size_class: SizeClass; landed: string; departed: string; origin: string | null }

/** The rest of VNY's business jets: same runway and taxiway, parked on the other FBOs' ramp east of ours. */
export function buildOtherPlans(moves: Movement[]): FlightPlan3D[] {
  const slots: { stand: Pt; lane: Pt; via: Pt[]; busy: [number, number][] }[] = [];
  for (const laneZ of OTHER.lanes) {
    for (let x = OTHER.x0 + 25; x <= OTHER.x1 - 15; x += OTHER.colPitch) {
      for (let d = 1; d <= OTHER.depths; d++) {
        slots.push({ stand: { x, z: laneZ + OTHER.setback + (d - 1) * OTHER.depthPitch }, lane: { x, z: laneZ },
          via: [{ x: OTHER.accessX, z: TWY.z }, { x: OTHER.accessX, z: laneZ }], busy: [] });
      }
    }
  }
  return moves.map((mv) => {
    const L = Date.parse(mv.landed), D = Date.parse(mv.departed);
    const meta: FlightMeta = { id: mv.id, size: mv.size_class, position: "Other FBO", kind: "other", stayType: D - L < 3 * 3_600_000 ? "drop_and_go" : "overnight",
      origin: mv.origin ?? "", booking: null, arriveIso: mv.landed, departIso: mv.departed };
    const free = slots.find((s) => !s.busy.some(([a, b]) => a < D + 5 * MIN && L < b + 5 * MIN) && (mv.size_class !== "large" || s.stand.x % 60 < 30));
    if (free) {
      free.busy.push([L, D]);
      return { ...planFor(meta, free), other: true };
    }
    // No room in view: they taxi to the ramps beyond the east end of the taxiway.
    return { ...planFor(meta, { stand: { x: TWY.x1, z: TWY.z }, lane: { x: TWY.x1 - 30, z: TWY.z }, via: [] }), other: true, ghost: true };
  });
}

// ---------- one runway for everyone ----------
// 16R handles every jet at the field. Approach control spaces arrivals ~90 s apart; tower releases departures
// 2 min apart and never while an arrival is on short final or rolling out. Jets that push on time wait in
// line at the hold short line, nose to tail along the taxiway.
export const RWY_ARR_SEP_MS = 90_000, RWY_DEP_SEP_MS = 120_000;
const QUEUE_GAP_M = 40, QUEUE_CREEP_MS = 20_000;

export interface RunwayStats { maxQueue: number; maxQueueAt: number; delayedDepartures: number; avgDelayMin: number; maxDelayMin: number }

export function sequenceRunway(plans: FlightPlan3D[]): RunwayStats {
  // Arrivals, first come first served.
  const arr = [...plans].sort((a, b) => (a.sched?.L ?? a.L) - (b.sched?.L ?? b.L));
  let last = -Infinity;
  for (const f of arr) {
    f.sched ??= { L: f.L, taxiInEnd: f.taxiInEnd };
    const L = Math.max(f.sched.L, last + RWY_ARR_SEP_MS);
    f.L = L; f.taxiInEnd = f.sched.taxiInEnd + (L - f.sched.L);
    last = L;
  }
  const lands = arr.map((f) => f.L);
  // Departures in the order they reach the hold.
  const deps = [...plans].sort((a, b) => a.D - b.D);
  let lastDep = -Infinity, j0 = 0, delayed = 0, sumDelay = 0, maxDelay = 0;
  for (const f of deps) {
    let R = Math.max(f.D, lastDep + RWY_DEP_SEP_MS);
    while (j0 < lands.length && lands[j0] < R - 200_000) j0++;
    for (let j = j0; j < lands.length && lands[j] <= R + 40_000; j++) if (R >= lands[j] - 40_000 && R <= lands[j] + 120_000) R = lands[j] + 120_001;
    f.R = R; lastDep = R;
    if (R - f.D > 60_000) { delayed++; sumDelay += R - f.D; maxDelay = Math.max(maxDelay, R - f.D); }
  }
  // Who is ahead in the queue when each jet gets there.
  let maxQueue = 0, maxQueueAt = 0;
  deps.forEach((f, i) => {
    const ahead: number[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const lv = deps[j].R! - 75_000;
      if (lv + QUEUE_CREEP_MS <= f.taxiOutStart) break;
      ahead.push(lv);
    }
    f.ahead = ahead;
    if (ahead.length > maxQueue) { maxQueue = ahead.length; maxQueueAt = f.taxiOutStart; }
  });
  return { maxQueue, maxQueueAt, delayedDepartures: delayed, avgDelayMin: delayed ? sumDelay / delayed / MIN : 0, maxDelayMin: maxDelay / MIN };
}
