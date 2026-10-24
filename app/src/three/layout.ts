// World layout (metres, Y up) and the motion of every flight through approach, landing, taxi, parking,
// pushback, taxi-out and take-off. Schematic: the geometry is plausible, not a survey of KVNY.
import type { ParkingPlan, ParkingPosition, SizeClass } from "../lib/types";

export const RWY = { z: -330, x0: -1150, x1: 1150, width: 46 };
export const TWY = { z: -255, x0: -1080, x1: 900, width: 23 };
export const EXIT_X = 420;          // high-speed exit after landing roll
export const HOLD_X = -1010;        // departure holding point
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

/** Where a parking position sits, and the lane point an aircraft uses to reach it. */
export function positionGeometry(p: ParkingPosition): { stand: Pt; lane: Pt; via: Pt[] } {
  if (p.kind === "stand") {
    const r = ROWS.indexOf(p.row), x = COL_X(p.column);
    return { stand: { x, z: STAND_Z(r, p.depth) }, lane: { x, z: ROW_LANE_Z(r) }, via: [{ x: ACCESS_X, z: TWY.z }, { x: ACCESS_X, z: ROW_LANE_Z(r) }] };
  }
  if (p.kind === "hot") {
    const x = HOT_X(p.column);
    return { stand: { x, z: HOT_Z }, lane: { x, z: HOT_LANE_Z }, via: [{ x: ACCESS_X, z: TWY.z }, { x: ACCESS_X, z: HOT_LANE_Z }] };
  }
  const x = TEMP_X(p.column), z = TEMP_Z(p.column);
  return { stand: { x, z }, lane: { x: ACCESS_E_X, z }, via: [{ x: ACCESS_E_X, z: TWY.z }] };
}

function padGeometry(i: number): { stand: Pt; lane: Pt; via: Pt[] } {
  const c = i % PAD.cols, r = Math.floor(i / PAD.cols) % 4;
  const x = PAD.x + c * PAD.cell, z = PAD.z + r * PAD.cell + 30;
  return { stand: { x, z }, lane: { x, z: PAD.z }, via: [{ x: PAD.x - 40, z: TWY.z }, { x: PAD.x - 40, z: PAD.z }] };
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
export type Phase = "approach" | "rollout" | "taxi_in" | "parked" | "tow" | "pushback" | "taxi_out" | "lineup" | "takeoff" | "climb";

export interface FlightPlan3D {
  id: string; size: SizeClass; position: string; kind: string; stayType: string; origin: string; booking: string | null;
  L: number; D: number; stand: Pt; lane: Pt; inPath: Path; outPath: Path; taxiInEnd: number; pushStart: number; taxiOutStart: number;
  tows: number[]; arriveIso: string; departIso: string;
}

export function buildPlans(plan: ParkingPlan): FlightPlan3D[] {
  const posById = new Map(plan.positions.map((p) => [p.id, p]));
  const towsBy = new Map<string, number[]>();
  plan.tows.forEach((t) => towsBy.set(t.flight_id, [...(towsBy.get(t.flight_id) ?? []), Date.parse(t.t_local)]));
  const out: FlightPlan3D[] = [];
  let padIdx = 0;
  for (const row of plan.gantt) {
    for (const b of row.bars) {
      const pos = posById.get(row.position);
      const g = pos ? positionGeometry(pos) : padGeometry(padIdx++);
      const L = Date.parse(b.start), D = Date.parse(b.end);
      const exit: Pt[] = [{ x: EXIT_X - 40, z: RWY.z }, { x: EXIT_X, z: RWY.z + 30 }, { x: EXIT_X - 20, z: TWY.z }];
      const inPath = path([...exit, ...g.via, g.lane, g.stand]);
      const outPath = path([g.lane, ...[...g.via].reverse(), { x: HOLD_X + 60, z: TWY.z }, { x: HOLD_X, z: TWY.z }]);
      const taxiInEnd = L + 1.2 * MIN + inPath.len * TAXI_MS_PER_M;
      const taxiOutStart = D - 75_000 - outPath.len * TAXI_MS_PER_M;
      out.push({
        id: b.flight_id, size: b.size_class, position: row.position, kind: pos?.kind ?? "overflow", stayType: b.stay_type,
        origin: b.origin, booking: b.booking_code, L, D, stand: g.stand, lane: g.lane, inPath, outPath, taxiInEnd,
        pushStart: taxiOutStart - 100_000, taxiOutStart, tows: towsBy.get(b.flight_id) ?? [], arriveIso: b.start, departIso: b.end,
      });
    }
  }
  return out;
}

export interface Pose { visible: boolean; x: number; y: number; z: number; heading: number; pitch: number; phase: Phase; tug: boolean }
const HIDDEN: Pose = { visible: false, x: 0, y: 0, z: 0, heading: 0, pitch: 0, phase: "parked", tug: false };
const ease = (f: number) => 1 - (1 - f) * (1 - f);

/** Where a flight is, and what it is doing, at simulated time t (ms). */
export function poseAt(f: FlightPlan3D, t: number): Pose {
  const app0 = f.L - 3 * MIN, roll1 = f.L + 1.2 * MIN;
  if (t < app0 || t > f.D + 1.6 * MIN) return HIDDEN;
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
  if (t < f.pushStart) {
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
  const lineup0 = f.D - 75_000, roll0 = f.D - 45_000;
  if (t < lineup0) {
    const s = (t - f.taxiOutStart) / TAXI_MS_PER_M;
    const p = at(f.outPath, s);
    return { visible: true, x: p.x, y: 0, z: p.z, heading: headingAt(f.outPath, s), pitch: 0, phase: "taxi_out", tug: false };
  }
  if (t < roll0) {
    const k = (t - lineup0) / 30_000;
    return { visible: true, x: HOLD_X + 40 * k, y: 0, z: TWY.z + (RWY.z - TWY.z) * k, heading: Math.PI / 2 + (1 - k) * 0.9, pitch: 0, phase: "lineup", tug: false };
  }
  if (t < f.D) {
    const k = (t - roll0) / 45_000;
    return { visible: true, x: HOLD_X + 40 + (150 - HOLD_X - 40) * k * k, y: 0, z: RWY.z, heading: Math.PI / 2, pitch: k > 0.85 ? 0.12 : 0, phase: "takeoff", tug: false };
  }
  const k = (t - f.D) / (1.6 * MIN);
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
