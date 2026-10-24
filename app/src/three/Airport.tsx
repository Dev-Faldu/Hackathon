// The static airfield: terrain, mountains, runway, taxiways, apron markings, buildings and lights.
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ParkingPosition } from "../lib/types";
import {
  ACCESS_E_X, ACCESS_X, EXIT_X, HOLD_X, HOT_LANE_Z, HOT_Z, PAD, positionGeometry, ROW_LANE_Z, RWY, STAND_SIZE, TERMINAL, TWY,
} from "./layout";
import { box, tint } from "./models";
import { asphaltTexture, concreteTexture, grassTexture, poolTexture } from "./textures";

// ---------- shared, night-aware materials (World updates `night` every frame) ----------
export const lightMats = {
  white: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 2.6), toneMapped: false }),
  blue: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.9, 4), toneMapped: false }),
  green: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 4, 0.8), toneMapped: false }),
  red: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.3, 0.3), toneMapped: false }),
  amber: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.2, 0.3), toneMapped: false }),
  window: new THREE.MeshStandardMaterial({ color: "#FDE7B0", emissive: new THREE.Color("#FFD58A"), emissiveIntensity: 0, roughness: 0.6 }),
  flood: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.0, 2.4), toneMapped: false }),
  // City lights after dark; World scales their colour with the night factor.
  sodium: new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 0), toneMapped: false }),
  cityWindow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 0), toneMapped: false }),
  // Floodlight footprints on the apron; opacity follows the night factor.
  pool: new THREE.MeshBasicMaterial({
    map: poolTexture(), color: new THREE.Color("#FFD9A0"), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  }),
};

function flat(w: number, d: number, x: number, z: number, y: number, color: string, ry = 0) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return tint(g, color);
}

function Pavement({ w, d, x, z, y, kind }: { w: number; d: number; x: number; z: number; y: number; kind: "concrete" | "runway" | "taxiway" }) {
  const tex = useMemo(() => (kind === "concrete" ? concreteTexture(w, d) : asphaltTexture(w, d, 24, kind === "runway" ? 66 : 80)), [w, d, kind]);
  return (
    <mesh position={[x, y, z]} rotation-x={-Math.PI / 2} receiveShadow>
      <planeGeometry args={[w, d]} />
      <meshStandardMaterial map={tex} roughness={kind === "concrete" ? 0.86 : 0.95} metalness={0} />
    </mesh>
  );
}

function Instanced({ points, geom, mat }: { points: [number, number, number][]; geom: THREE.BufferGeometry; mat: THREE.Material }) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geom, mat, points.length);
    const o = new THREE.Object3D();
    points.forEach((p, i) => { o.position.set(...p); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, [points, geom, mat]);
  return <primitive object={mesh} />;
}

function standLabels(positions: ParkingPosition[]): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 1024;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillRect(0, 0, 1024, 1024);
  ctx.font = "bold 46px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const geos: THREE.BufferGeometry[] = [];
  positions.forEach((p, i) => {
    const col = i % 8, row = Math.floor(i / 8);
    ctx.fillStyle = p.kind === "hot" ? "#93C5FD" : p.kind === "temp" ? "#F0ABFC" : "#FACC15";
    ctx.fillText(p.id, col * 128 + 64, row * 64 + 32);
    const g = positionGeometry(p);
    const dir = Math.atan2(g.stand.x - g.lane.x, g.stand.z - g.lane.z);
    const plane = new THREE.PlaneGeometry(9, 4.5);
    const uv = plane.getAttribute("uv") as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, (col + uv.getX(k)) / 8, 1 - (row + 1 - uv.getY(k)) / 16);
    }
    plane.rotateX(-Math.PI / 2);
    plane.rotateY(dir + Math.PI);
    const off = 14;
    plane.translate(g.stand.x - Math.sin(dir) * off, 0.15, g.stand.z - Math.cos(dir) * off);
    geos.push(plane);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.Mesh(mergeGeometries(geos, false)!, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
}

export function Airport({ positions, tempZone, labels }: { positions: ParkingPosition[]; tempZone: boolean; labels: boolean }) {
  const grass = useMemo(() => grassTexture(110), []);

  const markings = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    // Runway: edge lines, centerline dashes, threshold piano keys, aiming points
    parts.push(flat(RWY.x1 - RWY.x0, 0.9, 0, RWY.z - RWY.width / 2 + 1.5, 0.13, "#F8FAFC"));
    parts.push(flat(RWY.x1 - RWY.x0, 0.9, 0, RWY.z + RWY.width / 2 - 1.5, 0.13, "#F8FAFC"));
    for (let x = RWY.x0 + 160; x < RWY.x1 - 160; x += 60) parts.push(flat(36, 0.9, x, RWY.z, 0.13, "#F8FAFC"));
    for (const end of [RWY.x0 + 18, RWY.x1 - 18]) for (let k = -5; k <= 5; k++) if (k) parts.push(flat(30, 1.8, end, RWY.z + k * 3.6, 0.13, "#F8FAFC"));
    for (const x of [RWY.x0 + 300, RWY.x1 - 300]) for (const s of [-1, 1]) parts.push(flat(45, 9, x, RWY.z + s * 9, 0.13, "#F8FAFC"));
    // Taxiway and connectors: yellow centerlines and hold bars
    parts.push(flat(TWY.x1 - TWY.x0, 0.5, (TWY.x0 + TWY.x1) / 2, TWY.z, 0.13, "#EAB308"));
    parts.push(flat(0.5, TWY.z - RWY.z, EXIT_X, (TWY.z + RWY.z) / 2, 0.13, "#EAB308"));
    parts.push(flat(0.5, TWY.z - RWY.z, HOLD_X, (TWY.z + RWY.z) / 2, 0.13, "#EAB308"));
    for (let k = 0; k < 4; k++) parts.push(flat(22, 0.35, HOLD_X, RWY.z + 36 + k * 1.1, 0.135, "#EAB308"));
    // Apron access lanes and row taxilanes
    parts.push(flat(0.45, 470 - TWY.z, ACCESS_X, (470 + TWY.z) / 2, 0.13, "#EAB308"));
    parts.push(flat(0.45, 260, ACCESS_E_X, TWY.z + 130, 0.13, "#EAB308"));
    for (let r = 0; r < 4; r++) parts.push(flat(ACCESS_E_X - ACCESS_X, 0.45, (ACCESS_X + ACCESS_E_X) / 2, ROW_LANE_Z(r), 0.13, "#EAB308"));
    parts.push(flat(300, 0.45, ACCESS_X + 150, HOT_LANE_Z, 0.13, "#EAB308"));
    parts.push(flat(PAD.cols * PAD.cell + 40, 0.45, PAD.x + 40, PAD.z, 0.13, "#EAB308"));
    parts.push(flat(0.45, PAD.z - TWY.z, PAD.x - 40, (PAD.z + TWY.z) / 2, 0.13, "#EAB308"));
    // Every stand: white box, yellow lead-in line, red stop bar
    positions.forEach((p) => {
      const g = positionGeometry(p);
      const dir = Math.atan2(g.stand.x - g.lane.x, g.stand.z - g.lane.z);
      const len = Math.hypot(g.stand.x - g.lane.x, g.stand.z - g.lane.z);
      const white = p.kind === "temp" && !tempZone ? "#94A3B8" : "#F1F5F9";
      const W = STAND_SIZE.w - (p.kind === "temp" ? 6 : 0), D = STAND_SIZE.d - 2;
      const sx = Math.sin(dir), sz = Math.cos(dir);
      parts.push(flat(W, 0.35, g.stand.x - sx * D / 2, g.stand.z - sz * D / 2, 0.135, white, dir));
      parts.push(flat(W, 0.35, g.stand.x + sx * D / 2, g.stand.z + sz * D / 2, 0.135, white, dir));
      parts.push(flat(0.35, D, g.stand.x + sz * W / 2, g.stand.z - sx * W / 2, 0.135, white, dir));
      parts.push(flat(0.35, D, g.stand.x - sz * W / 2, g.stand.z + sx * W / 2, 0.135, white, dir));
      parts.push(flat(0.4, len, (g.stand.x + g.lane.x) / 2, (g.stand.z + g.lane.z) / 2, 0.137, "#EAB308", dir));
      parts.push(flat(5, 0.8, g.stand.x + sx * 12, g.stand.z + sz * 12, 0.14, "#DC2626", dir));
      if (p.kind === "temp" && !tempZone) {
        parts.push(flat(0.8, 44, g.stand.x, g.stand.z, 0.14, "#DC2626", Math.PI / 4));
        parts.push(flat(0.8, 44, g.stand.x, g.stand.z, 0.14, "#DC2626", -Math.PI / 4));
      }
    });
    const geo = mergeGeometries(parts, false)!;
    return geo;
  }, [positions, tempZone]);

  const labelMesh = useMemo(() => standLabels(positions), [positions]);

  const mountains = useMemo(() => {
    // Chaparral ridgelines 14-21 km out, 3-5 degrees above the horizon like the hills around the Valley.
    const parts: THREE.BufferGeometry[] = [];
    const rnd = (i: number) => Math.abs((Math.sin(i * 127.1) * 43758.5453) % 1);
    for (let i = 0; i < 54; i++) {
      const a = (i / 54) * Math.PI * 2 + rnd(i) * 0.15;
      const dist = 14000 + rnd(i + 3) * 7000;
      const h = (380 + rnd(i + 7) * 820) * (Math.sin(a) > 0.2 ? 1.35 : 0.85);
      const r = 2400 + rnd(i + 11) * 2600;
      const g = new THREE.ConeGeometry(r, h, 6 + (i % 5), 1);
      g.scale(1, 1, 0.55 + rnd(i + 5) * 0.4);
      g.rotateY(-a);
      g.translate(Math.cos(a) * dist, h / 2 - 30, Math.sin(a) * dist);
      parts.push(tint(g, ["#6F7356", "#7A775E", "#646B50", "#80806A"][i % 4]));
    }
    return mergeGeometries(parts, false)!;
  }, []);

  const skids = useMemo(() => {
    // Rubber deposits in both touchdown zones.
    const parts: THREE.BufferGeometry[] = [];
    const r = (i: number) => Math.abs((Math.sin(i * 91.7) * 9871.13) % 1);
    for (const [from, dir] of [[RWY.x0 + 200, 1], [RWY.x1 - 200, -1]] as const) {
      for (let i = 0; i < 70; i++) {
        const len = 20 + r(i + from) * 90, x = from + dir * r(i * 3 + from) * 520;
        const zOff = (r(i * 7 + from) - 0.5) * 7 + (i % 2 ? 2.8 : -2.8);
        parts.push(flat(len, 0.5 + r(i * 5) * 0.9, x, RWY.z + zOff, 0.11, "#15181D"));
      }
    }
    return mergeGeometries(parts, false)!;
  }, []);

  const buildings = useMemo(() => {
    const T = TERMINAL;
    const parts: THREE.BufferGeometry[] = [
      // Terminal: concrete body, roof canopy, mullions
      box(T.w, T.h, T.d, T.x, T.h / 2, T.z, "#E7EBF0"),
      box(T.w + 14, 1.2, T.d + 14, T.x, T.h + 0.6, T.z - 4, "#CBD5E1"),
      ...Array.from({ length: 22 }, (_, i) => box(0.5, T.h - 3, 0.5, T.x - T.w / 2 + 6 + i * ((T.w - 12) / 21), T.h / 2 - 0.5, T.z - T.d / 2 - 0.5, "#94A3B8")),
      // Hangar: walls and door
      box(140, 14, 100, 225, 7, 340, "#D9DEE5"),
      box(118, 12, 1, 225, 6, 289.5, "#64748B"),
      // Control tower: shaft, cab roof, base
      box(14, 6, 14, 320, 3, -150, "#CBD5E1"),
      // Fuel farm containment wall
      box(90, 2.2, 60, 265, 1.1, 485, "#A8B1BD"),
      // Car park kerbs
      box(110, 0.25, 70, 115, 0.12, 520, "#6B7280"),
    ];
    const roof = new THREE.CylinderGeometry(50, 50, 140, 28, 1, false, 0, Math.PI);
    roof.rotateZ(Math.PI / 2);
    roof.scale(1, 0.38, 1);
    roof.translate(225, 14, 340);
    parts.push(tint(roof, "#B8C2CF"));
    const shaft = new THREE.CylinderGeometry(3.2, 4.2, 40, 16);
    shaft.translate(320, 26, -150);
    parts.push(tint(shaft, "#E2E8F0"));
    const cabRoof = new THREE.CylinderGeometry(8.5, 7.2, 1.6, 16);
    cabRoof.translate(320, 53.5, -150);
    parts.push(tint(cabRoof, "#475569"));
    for (const [x, z] of [[245, 475], [272, 475], [258, 500], [285, 500]]) {
      const t = new THREE.CylinderGeometry(9, 9, 13, 24);
      t.translate(x, 6.5, z);
      parts.push(tint(t, "#F1F5F9"));
      const c = new THREE.CylinderGeometry(9.2, 9.2, 0.8, 24);
      c.translate(x, 13.2, z);
      parts.push(tint(c, "#94A3B8"));
    }
    return mergeGeometries(parts, false)!;
  }, []);

  const parkedCars = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const colors = ["#0F172A", "#E5E7EB", "#334155", "#991B1B", "#1E3A8A", "#F8FAFC", "#111827"];
    for (let i = 0; i < 26; i++) {
      const x = 70 + (i % 9) * 11, z = 498 + Math.floor(i / 9) * 18;
      parts.push(box(2.0, 1.4, 4.7, x, 0.8, z, colors[i % colors.length]));
      parts.push(box(1.8, 0.6, 2.4, x, 1.75, z - 0.2, "#1E293B"));
    }
    return mergeGeometries(parts, false)!;
  }, []);

  const runwayLights = useMemo(() => {
    const white: [number, number, number][] = [], blue: [number, number, number][] = [], green: [number, number, number][] = [], red: [number, number, number][] = [];
    for (let x = RWY.x0; x <= RWY.x1; x += 60) { white.push([x, 0.4, RWY.z - RWY.width / 2 - 2]); white.push([x, 0.4, RWY.z + RWY.width / 2 + 2]); }
    for (let k = -6; k <= 6; k++) { green.push([RWY.x0 - 3, 0.4, RWY.z + k * 3.6]); red.push([RWY.x1 + 3, 0.4, RWY.z + k * 3.6]); }
    for (let x = TWY.x0; x <= TWY.x1; x += 45) { blue.push([x, 0.4, TWY.z - 14]); blue.push([x, 0.4, TWY.z + 14]); }
    return { white, blue, green, red };
  }, []);

  const poles = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let z = -220; z <= 440; z += 110) { pts.push([ACCESS_X - 22, 0, z]); pts.push([ACCESS_E_X + 150, 0, z]); }
    for (let x = -150; x <= 260; x += 100) pts.push([x, 0, 430]);
    return pts;
  }, []);
  const poleGeo = useMemo(() => {
    const p = new THREE.CylinderGeometry(0.35, 0.5, 24, 8);
    p.translate(0, 12, 0);
    return tint(p, "#94A3B8");
  }, []);
  const pools = useMemo(() => mergeGeometries(poles.map(([x, , z]) => {
    const g = new THREE.PlaneGeometry(120, 120);
    g.rotateX(-Math.PI / 2);
    g.translate(x + (x < 0 ? 22 : -22), 0.17, z);
    return g;
  }), false)!, [poles]);
  const headGeo = useMemo(() => new THREE.BoxGeometry(5, 0.8, 2.2), []);
  const bulb = useMemo(() => new THREE.SphereGeometry(0.55, 8, 6), []);
  const poleMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }), []);

  return (
    <group>
      {/* Ground: subdivided so depth interpolation stays exact, and pushed back so pavement always wins. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.3, 0]} receiveShadow>
        <planeGeometry args={[40000, 40000, 64, 64]} />
        <meshStandardMaterial map={grass} roughness={1} polygonOffset polygonOffsetFactor={4} polygonOffsetUnits={4} />
      </mesh>
      <mesh geometry={mountains}><meshStandardMaterial vertexColors flatShading roughness={1} /></mesh>

      <Pavement w={RWY.x1 - RWY.x0 + 60} d={RWY.width} x={0} z={RWY.z} y={0.02} kind="runway" />
      <Pavement w={TWY.x1 - TWY.x0} d={TWY.width} x={(TWY.x0 + TWY.x1) / 2} z={TWY.z} y={0.06} kind="taxiway" />
      <Pavement w={TWY.width} d={TWY.z - RWY.z} x={EXIT_X} z={(TWY.z + RWY.z) / 2} y={0.045} kind="taxiway" />
      <Pavement w={TWY.width} d={TWY.z - RWY.z} x={HOLD_X} z={(TWY.z + RWY.z) / 2} y={0.045} kind="taxiway" />
      <Pavement w={520} d={785} x={10} z={150} y={0.07} kind="concrete" />
      <Pavement w={PAD.cols * PAD.cell + 100} d={250} x={PAD.x + 60} z={PAD.z + 85} y={0.07} kind="concrete" />
      <mesh geometry={skids}><meshBasicMaterial vertexColors transparent opacity={0.45} depthWrite={false} /></mesh>
      <mesh geometry={pools} material={lightMats.pool} />

      <mesh geometry={markings}><meshStandardMaterial vertexColors roughness={0.7} polygonOffset polygonOffsetFactor={-1} /></mesh>
      <primitive object={labelMesh} />

      <mesh geometry={buildings} castShadow receiveShadow><meshStandardMaterial vertexColors roughness={0.55} metalness={0.15} /></mesh>
      <mesh geometry={parkedCars} castShadow><meshStandardMaterial vertexColors roughness={0.35} metalness={0.5} /></mesh>
      {/* Terminal glass curtain wall and the warm interior glow that shows at night */}
      <mesh position={[TERMINAL.x, TERMINAL.h / 2 - 0.5, TERMINAL.z - TERMINAL.d / 2 - 0.3]}>
        <boxGeometry args={[TERMINAL.w - 8, TERMINAL.h - 3, 0.4]} />
        <meshStandardMaterial color="#8FB1D0" metalness={0.92} roughness={0.06} />
      </mesh>
      <mesh position={[TERMINAL.x, TERMINAL.h / 2 - 0.5, TERMINAL.z - TERMINAL.d / 2 + 0.6]} material={lightMats.window}>
        <boxGeometry args={[TERMINAL.w - 10, TERMINAL.h - 4, 0.3]} />
      </mesh>
      {/* Tower cab glass */}
      <mesh position={[320, 49.5, -150]}>
        <cylinderGeometry args={[7.2, 6.2, 6.5, 16]} />
        <meshStandardMaterial color="#7DA2C4" metalness={0.9} roughness={0.08} />
      </mesh>
      <Instanced points={[[320, 55, -150]]} geom={bulb} mat={lightMats.red} />

      <Instanced points={runwayLights.white} geom={bulb} mat={lightMats.white} />
      <Instanced points={runwayLights.blue} geom={bulb} mat={lightMats.blue} />
      <Instanced points={runwayLights.green} geom={bulb} mat={lightMats.green} />
      <Instanced points={runwayLights.red} geom={bulb} mat={lightMats.red} />
      <Instanced points={poles} geom={poleGeo} mat={poleMat} />
      <ApproachLights bulb={bulb} />
      <Instanced points={poles.map(([x, , z]) => [x, 24, z] as [number, number, number])} geom={headGeo} mat={lightMats.flood} />

      {labels && (
        <>
          <Label pos={[-620, 30, RWY.z]} text="RWY 16R/34L · 8,000 ft" />
          <Label pos={[TERMINAL.x, TERMINAL.h + 26, TERMINAL.z + 10]} text="Sepulveda Jet Center · FBO terminal" strong />
          <Label pos={[225, 40, 340]} text="Hangar" />
          <Label pos={[320, 68, -150]} text="Tower" />
          <Label pos={[265, 26, 485]} text="Fuel farm" />
          <Label pos={[115, 12, 520]} text="VIP car staging" />
          <Label pos={[ACCESS_X - 72, 8, HOT_Z - 4]} text="Drop-and-go hot spots" />
          <Label pos={[190, 12, -200]} text={tempZone ? "Temporary taxiway stands · OPEN" : "Temp zone · closed"} />
          <Label pos={[PAD.x + 60, 12, PAD.z + 85]} text="Overflow pad" />
          {["A", "B", "C", "D"].map((r, i) => <Label key={r} pos={[ACCESS_X - 34, 8, ROW_LANE_Z(i) + 70]} text={`Row ${r}`} />)}
        </>
      )}
    </group>
  );
}

/** Approach lighting west of the threshold with the sequenced flasher ("rabbit"), and a PAPI on the glide path. */
function ApproachLights({ bulb }: { bulb: THREE.BufferGeometry }) {
  const BARS = 28, SPACING = 30;
  const bars = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let k = 1; k <= BARS; k++) for (let j = -2; j <= 2; j++) pts.push([RWY.x0 - k * SPACING, 0.8, RWY.z + j * 3]);
    return pts;
  }, []);
  // PAPI left of the touchdown zone: two white over two red means on the 3-degree slope.
  const papiW = useMemo<[number, number, number][]>(() => [[RWY.x0 + 300, 0.9, RWY.z - 40], [RWY.x0 + 300, 0.9, RWY.z - 46]], []);
  const papiR = useMemo<[number, number, number][]>(() => [[RWY.x0 + 300, 0.9, RWY.z - 52], [RWY.x0 + 300, 0.9, RWY.z - 58]], []);
  const strobe = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    // Two runs per second from the outer bar toward the runway.
    const f = (state.clock.elapsedTime * 2) % 1, k = BARS - Math.floor(f * BARS);
    if (strobe.current) strobe.current.position.set(RWY.x0 - k * SPACING, 1.4, RWY.z);
  });
  return (
    <group>
      <Instanced points={bars} geom={bulb} mat={lightMats.white} />
      <Instanced points={papiW} geom={bulb} mat={lightMats.white} />
      <Instanced points={papiR} geom={bulb} mat={lightMats.red} />
      <mesh ref={strobe} geometry={bulb} material={lightMats.white} scale={3.2} />
    </group>
  );
}

function Label({ pos, text, strong }: { pos: [number, number, number]; text: string; strong?: boolean }) {
  return (
    <Html position={pos} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
      <div style={{
        whiteSpace: "nowrap", padding: strong ? "5px 10px" : "3px 8px", borderRadius: 999, fontSize: strong ? 12 : 11,
        fontWeight: strong ? 600 : 500, color: "#0B1B33", background: "rgba(255,255,255,0.78)",
        border: "1px solid rgba(255,255,255,0.9)", boxShadow: "0 6px 18px rgba(15,30,60,0.15)", backdropFilter: "blur(10px)",
        fontFamily: '"Geist Variable", system-ui, sans-serif',
      }}>{text}</div>
    </Html>
  );
}
