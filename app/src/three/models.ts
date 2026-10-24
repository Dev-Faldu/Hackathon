// Procedural low-poly models, each merged into one vertex-coloured geometry so a whole fleet
// renders as a handful of instanced draw calls. Nose points along +Z; wheels sit on y = 0.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SizeClass } from "../lib/types";
import { DIMS } from "./layout";

const PAINT = "#F4F6F9", GLASS = "#0F172A", METAL = "#B8C2CF", INTAKE = "#1E293B", GEAR = "#334155";

function tint(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute("uv");
  if (geo.getAttribute("uv1")) geo.deleteAttribute("uv1");
  const c = new THREE.Color(color);
  const n = geo.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: string, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return tint(g, color);
}

function wing(half: number, rootX: number, rootLE: number, rootTE: number, tipLE: number, tipTE: number, thick: number, side: 1 | -1) {
  // Shape in (span, -z) then laid flat: shape y maps to world -z after rotateX(-90deg).
  const s = new THREE.Shape();
  s.moveTo(side * rootX, -rootLE);
  s.lineTo(side * half, -tipLE);
  s.lineTo(side * half, -tipTE);
  s.lineTo(side * rootX, -rootTE);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

const cache = new Map<string, THREE.BufferGeometry>();

export interface JetLights { tipL: THREE.Vector3; tipR: THREE.Vector3; tail: THREE.Vector3; beacon: THREE.Vector3; nose: THREE.Vector3; centerY: number }

export function jetLights(size: SizeClass): JetLights {
  const { span, length: L, r } = DIMS[size];
  const cy = r + 1.0, wy = cy - 0.45 * r;
  return {
    tipL: new THREE.Vector3(-span / 2, wy + 0.2, -0.20 * L),
    tipR: new THREE.Vector3(span / 2, wy + 0.2, -0.20 * L),
    tail: new THREE.Vector3(0, cy + r + 0.17 * L + 0.2, -0.53 * L),
    beacon: new THREE.Vector3(0, cy + r + 0.15, -0.05 * L),
    nose: new THREE.Vector3(0, cy - 0.45 * r, 0.5 * L + 0.15),
    centerY: cy,
  };
}

export function jetGeometry(size: SizeClass): THREE.BufferGeometry {
  if (cache.has("jet-" + size)) return cache.get("jet-" + size)!;
  const { span, length: L, r, color } = DIMS[size];
  const cy = r + 1.0;
  const parts: THREE.BufferGeometry[] = [];

  const fus = new THREE.CapsuleGeometry(r, L - 2 * r, 6, 18);
  fus.rotateX(Math.PI / 2);
  fus.scale(1, 1.04, 1);
  fus.translate(0, cy, 0);
  parts.push(tint(fus, PAINT));

  // Cockpit glass, cabin windows, cheatline
  parts.push(box(1.25 * r, 0.32 * r, 0.11 * L, 0, cy + 0.52 * r, 0.40 * L, GLASS));
  for (let i = 0; i < 7; i++) {
    const z = 0.27 * L - i * 0.075 * L;
    parts.push(box(0.06, 0.3 * r, 0.03 * L, r * 0.985, cy + 0.18 * r, z, GLASS));
    parts.push(box(0.06, 0.3 * r, 0.03 * L, -r * 0.985, cy + 0.18 * r, z, GLASS));
  }
  parts.push(box(0.05, 0.1 * r, 0.82 * L, r * 0.995, cy - 0.22 * r, -0.01 * L, color));
  parts.push(box(0.05, 0.1 * r, 0.82 * L, -r * 0.995, cy - 0.22 * r, -0.01 * L, color));

  // Wings with winglets
  const wy = cy - 0.45 * r;
  for (const side of [1, -1] as const) {
    const w = wing(span / 2, r * 0.5, 0.06 * L, -0.17 * L, -0.15 * L, -0.25 * L, 0.24, side);
    w.translate(0, wy, 0);
    parts.push(tint(w, PAINT));
    parts.push(box(0.12, 1.3, 0.08 * L, side * (span / 2 - 0.05), wy + 0.75, -0.21 * L, color));
  }

  // T-tail: fin and horizontal stabiliser
  const finH = 0.17 * L;
  const fin = new THREE.Shape();
  fin.moveTo(0.30 * L, 0);
  fin.lineTo(0.50 * L, 0);
  fin.lineTo(0.54 * L, finH);
  fin.lineTo(0.44 * L, finH);
  fin.closePath();
  const finG = new THREE.ExtrudeGeometry(fin, { depth: 0.3, bevelEnabled: false });
  finG.rotateY(Math.PI / 2);
  finG.translate(-0.15, cy + 0.6 * r, 0);
  parts.push(tint(finG, color));
  for (const side of [1, -1] as const) {
    const st = wing(span * 0.18, 0.1, -0.42 * L, -0.52 * L, -0.50 * L, -0.56 * L, 0.16, side);
    st.translate(0, cy + 0.6 * r + finH - 0.08, 0);
    parts.push(tint(st, PAINT));
  }

  // Aft-mounted engines with pylons and dark intakes
  const er = 0.55 * r + 0.15, el = 0.2 * L;
  for (const side of [1, -1] as const) {
    const ex = side * (r + er + 0.25), ey = cy + 0.3 * r, ez = -0.3 * L;
    const eng = new THREE.CylinderGeometry(er, er * 0.88, el, 16);
    eng.rotateX(Math.PI / 2);
    eng.translate(ex, ey, ez);
    parts.push(tint(eng, METAL));
    const intake = new THREE.CylinderGeometry(er * 0.78, er * 0.78, 0.08, 16);
    intake.rotateX(Math.PI / 2);
    intake.translate(ex, ey, ez + el / 2 + 0.03);
    parts.push(tint(intake, INTAKE));
    parts.push(box(Math.abs(ex) - r * 0.6, 0.25, 0.12 * L, side * (r * 0.6 + (Math.abs(ex) - r * 0.6) / 2), ey, ez, PAINT));
  }

  // Landing gear
  for (const [gx, gz] of [[0, 0.36 * L], [0.85 * r, -0.08 * L], [-0.85 * r, -0.08 * L]]) {
    const leg = new THREE.CylinderGeometry(0.09, 0.09, 1.0, 6);
    leg.translate(gx, 0.85, gz);
    parts.push(tint(leg, GEAR));
    const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12);
    wheel.rotateZ(Math.PI / 2);
    wheel.translate(gx, 0.34, gz);
    parts.push(tint(wheel, "#111827"));
  }

  const merged = mergeGeometries(parts, false)!;
  merged.computeBoundingSphere();
  cache.set("jet-" + size, merged);
  return merged;
}

export function tugGeometry(): THREE.BufferGeometry {
  if (cache.has("tug")) return cache.get("tug")!;
  const g = mergeGeometries([
    box(2.4, 0.9, 4.2, 0, 0.75, 0, "#F59E0B"),
    box(1.6, 0.9, 1.2, 0, 1.6, -1.1, "#1F2937"),
    box(2.5, 0.2, 0.5, 0, 0.6, 2.2, "#111827"),
    ...[[-1.1, 1.3], [1.1, 1.3], [-1.1, -1.3], [1.1, -1.3]].map(([x, z]) => {
      const w = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 10);
      w.rotateZ(Math.PI / 2);
      w.translate(x, 0.42, z);
      return tint(w, "#111827");
    }),
  ], false)!;
  cache.set("tug", g);
  return g;
}

export function fuelTruckGeometry(): THREE.BufferGeometry {
  if (cache.has("fuel")) return cache.get("fuel")!;
  const tank = new THREE.CylinderGeometry(1.2, 1.2, 6.2, 16);
  tank.rotateX(Math.PI / 2);
  tank.translate(0, 2.0, -1.2);
  const g = mergeGeometries([
    box(2.5, 2.2, 2.2, 0, 1.6, 3.2, "#1D4ED8"),
    box(2.0, 0.6, 1.0, 0, 2.2, 4.3, GLASS),
    tint(tank, "#E5E7EB"),
    box(2.52, 0.25, 6.2, 0, 1.4, -1.2, "#DC2626"),
    box(2.6, 0.5, 9.0, 0, 0.6, 0.6, "#374151"),
  ], false)!;
  cache.set("fuel", g);
  return g;
}

export function suvGeometry(): THREE.BufferGeometry {
  if (cache.has("suv")) return cache.get("suv")!;
  const g = mergeGeometries([
    box(2.0, 1.0, 5.0, 0, 0.85, 0, "#0B1220"),
    box(1.85, 0.75, 3.0, 0, 1.7, -0.3, "#111827"),
    box(1.9, 0.5, 2.8, 0, 1.75, -0.3, "#1E293B"),
    ...[[-0.95, 1.6], [0.95, 1.6], [-0.95, -1.6], [0.95, -1.6]].map(([x, z]) => {
      const w = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 10);
      w.rotateZ(Math.PI / 2);
      w.translate(x, 0.38, z);
      return tint(w, "#000000");
    }),
  ], false)!;
  cache.set("suv", g);
  return g;
}

/** Ramp agent, 1.8 m: dark trousers, a vest in `vest` colour with reflective bands, ear defenders. Faces +Z. */
export function personGeometry(vest: string): THREE.BufferGeometry {
  const key = "person-" + vest;
  if (cache.has(key)) return cache.get(key)!;
  const head = new THREE.SphereGeometry(0.13, 10, 8);
  head.translate(0, 1.66, 0);
  const g = mergeGeometries([
    box(0.15, 0.85, 0.18, -0.11, 0.43, 0, "#1F2937"),
    box(0.15, 0.85, 0.18, 0.11, 0.43, 0, "#1F2937"),
    box(0.46, 0.62, 0.26, 0, 1.18, 0, vest),
    box(0.47, 0.06, 0.27, 0, 1.0, 0, "#E5E7EB"),
    box(0.47, 0.06, 0.27, 0, 1.3, 0, "#E5E7EB"),
    box(0.11, 0.55, 0.13, -0.3, 1.18, 0, vest),
    box(0.11, 0.55, 0.13, 0.3, 1.18, 0, vest),
    tint(head, "#C08A64"),
    box(0.34, 0.12, 0.1, 0, 1.68, 0, "#111827"),
  ], false)!;
  cache.set(key, g);
  return g;
}

/** Lighted marshalling wand, 0.5 m, pivot at the grip. */
export function wandGeometry(): THREE.BufferGeometry {
  if (cache.has("wand")) return cache.get("wand")!;
  const g = new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6);
  g.translate(0, 0.25, 0);
  cache.set("wand", g);
  return g;
}

/** Safety cone, 0.7 m, orange with a reflective collar. */
export function coneGeometry(): THREE.BufferGeometry {
  if (cache.has("cone")) return cache.get("cone")!;
  const c = new THREE.ConeGeometry(0.16, 0.62, 10);
  c.translate(0, 0.39, 0);
  const band = new THREE.CylinderGeometry(0.1, 0.12, 0.1, 10);
  band.translate(0, 0.42, 0);
  const g = mergeGeometries([box(0.38, 0.06, 0.38, 0, 0.03, 0, "#EA580C"), tint(c, "#F97316"), tint(band, "#F8FAFC")], false)!;
  cache.set("cone", g);
  return g;
}

/** Ground support equipment parked in a staging box: tugs, power units, stairs, carts, a lav truck. */
export function stagedEquipment(x0: number, z0: number, cols: number, rows: number, pitchX: number, pitchZ: number, seed: number): THREE.BufferGeometry[] {
  const kinds = [
    (x: number, z: number) => [box(2.2, 0.9, 3.8, x, 0.7, z, "#F59E0B"), box(1.5, 0.8, 1.1, x, 1.5, z - 1.0, "#1F2937")],         // tow tug
    (x: number, z: number) => [box(1.5, 1.3, 2.4, x, 0.9, z, "#F8FAFC"), box(1.52, 0.12, 2.42, x, 0.5, z, "#DC2626")],             // ground power unit
    (x: number, z: number) => [box(1.8, 0.5, 3.4, x, 0.45, z, "#64748B"), box(1.6, 0.25, 3.0, x, 0.85, z, "#94A3B8")],             // baggage cart
    (x: number, z: number) => [box(1.9, 1.7, 4.4, x, 1.1, z, "#2563EB"), box(1.8, 0.8, 1.4, x, 2.0, z + 1.4, "#0F172A")],          // lav / water truck
    (x: number, z: number) => [box(1.6, 0.4, 3.6, x, 0.4, z, "#334155"), ...[0, 1, 2, 3, 4].map((k) => box(1.2, 0.08, 0.35, x, 0.7 + k * 0.32, z - 1.2 + k * 0.55, "#E2E8F0"))], // airstair
    (x: number, z: number) => [box(1.8, 1.4, 3.8, x, 0.9, z, "#E5E7EB"), box(1.7, 0.6, 1.2, x, 1.7, z + 1.1, "#0F172A")],          // crew car
  ];
  const out: THREE.BufferGeometry[] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const k = (seed + c * 7 + r * 3) % (kinds.length + 1);
    if (k === kinds.length) continue; // an empty bay
    out.push(...kinds[k](x0 + c * pitchX, z0 + r * pitchZ));
  }
  return out;
}

export { tint, box };
