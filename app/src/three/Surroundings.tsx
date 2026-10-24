// The Valley around the field: a low-rise street grid, trees, and a freeway with live traffic.
// Everything is instanced; nothing here casts shadows (the sun's shadow box only covers the airfield).
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { lightMats } from "./Airport";
import { tint } from "./models";
import { sim } from "./state";
import { grassTexture } from "./textures";

const FIELD = { x0: -1450, x1: 1450, z0: -640, z1: 740 };
const CITY = { x0: -3900, x1: 3900, z0: -3300, z1: 3700 };
const LOT = 46, STREET_EVERY = 4;
const FWY_X = 1720, FWY_W = 44, FWY_LANES = [-15, -9, 9, 15];
const CARS_PER_LANE = 34;
const STUCCO = ["#E8DCC8", "#D9CBB3", "#F1ECE2", "#C9B79C", "#B7A58A", "#DAD4C8", "#A9A49A", "#E3D5BF", "#CFC6B8", "#BFC5CC"];
const CAR = ["#F8FAFC", "#0F172A", "#94A3B8", "#475569", "#991B1B", "#1E3A8A", "#E5E7EB", "#111827"];

let s = 11;
const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
const inField = (x: number, z: number, pad = 0) => x > FIELD.x0 - pad && x < FIELD.x1 + pad && z > FIELD.z0 - pad && z < FIELD.z1 + pad;
const nearFreeway = (x: number) => Math.abs(x - FWY_X) < FWY_W / 2 + 20;
// Runway protection zones off both ends: kept clear so the approach lights run over open ground.
const inRpz = (x: number, z: number) => Math.abs(z + 330) < 120 && Math.abs(x) > 1100 && Math.abs(x) < 2500;
const o = new THREE.Object3D();

export function Surroundings() {
  const urban = useMemo(() => grassTexture(1), []);

  const { buildings, roofs, trees, windows, streetLamps } = useMemo(() => {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    unit.translate(0, 0.5, 0);
    const crown = new THREE.IcosahedronGeometry(1, 0);
    const bMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    const tMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
    const bList: { x: number; z: number; w: number; d: number; h: number; c: string }[] = [];
    const lamps: [number, number][] = [];
    const tList: { x: number; z: number; r: number; c: string }[] = [];
    for (let i = 0, x = CITY.x0; x < CITY.x1; i++, x += LOT) {
      for (let j = 0, z = CITY.z0; z < CITY.z1; j++, z += LOT) {
        const cx = x + LOT / 2, cz = z + LOT / 2;
        if (i % STREET_EVERY === 0 || j % STREET_EVERY === 0) {
          // Street lamps at every intersection and every other lot along the streets.
          if (!inField(cx, cz, 30) && !nearFreeway(cx) && ((i % STREET_EVERY === 0 && j % STREET_EVERY === 0) || (i + j) % 2 === 0)) lamps.push([cx, cz]);
          continue;
        }
        if (inField(cx, cz, 40) || nearFreeway(cx) || inRpz(cx, cz)) continue;
        const dist = Math.hypot(cx, cz - 100);
        if (rnd() < Math.min(0.55, dist / 9000)) continue; // thins out toward the horizon
        const roll = rnd();
        if (roll < 0.16) {
          for (let k = 0; k < 3; k++) tList.push({ x: cx + (rnd() - 0.5) * 34, z: cz + (rnd() - 0.5) * 34, r: 3.5 + rnd() * 3.5, c: rnd() > 0.5 ? "#4D5E3A" : "#5E6B44" });
          continue;
        }
        const tall = roll > 0.965, mid = roll > 0.8;
        const h = tall ? 26 + rnd() * 44 : mid ? 10 + rnd() * 12 : 4 + rnd() * 5;
        const w = tall ? 26 + rnd() * 10 : 16 + rnd() * 18, d = tall ? 22 + rnd() * 12 : 14 + rnd() * 18;
        bList.push({ x: cx + (rnd() - 0.5) * 6, z: cz + (rnd() - 0.5) * 6, w, d, h, c: tall ? "#C7D2DE" : STUCCO[Math.floor(rnd() * STUCCO.length)] });
        if (!tall && rnd() < 0.55) tList.push({ x: cx + (rnd() > 0.5 ? 1 : -1) * (w / 2 + 4), z: cz + (rnd() - 0.5) * 20, r: 3 + rnd() * 3, c: "#55663E" });
      }
    }
    // A loose line of trees along the airport fence.
    for (let x = FIELD.x0; x < FIELD.x1; x += 38 + rnd() * 30) {
      tList.push({ x, z: FIELD.z1 + 12 + rnd() * 10, r: 4 + rnd() * 3, c: "#4D5E3A" });
      tList.push({ x, z: FIELD.z0 - 12 - rnd() * 10, r: 4 + rnd() * 3, c: "#55663E" });
    }
    const col = new THREE.Color();
    const b = new THREE.InstancedMesh(unit, bMat, bList.length);
    bList.forEach((q, k) => {
      o.position.set(q.x, 0, q.z); o.scale.set(q.w, q.h, q.d); o.rotation.set(0, 0, 0); o.updateMatrix();
      b.setMatrixAt(k, o.matrix); b.setColorAt(k, col.set(q.c));
    });
    // Flat roofs: a darker slab with a parapet inset, the detail that reads from the air.
    const roofs = new THREE.InstancedMesh(unit, bMat, bList.length);
    const ROOF = ["#8C8F94", "#6B6E73", "#A39E94", "#B4AFA6", "#7D7A73"];
    bList.forEach((q, k) => {
      o.position.set(q.x, q.h, q.z); o.scale.set(q.w * 0.9, 0.6, q.d * 0.9); o.updateMatrix();
      roofs.setMatrixAt(k, o.matrix); roofs.setColorAt(k, col.set(ROOF[k % ROOF.length]));
    });
    const t = new THREE.InstancedMesh(crown, tMat, tList.length);
    tList.forEach((q, k) => {
      o.position.set(q.x, q.r * 1.15, q.z); o.scale.set(q.r, q.r * 1.25, q.r); o.rotation.set(0, q.x, 0); o.updateMatrix();
      t.setMatrixAt(k, o.matrix); t.setColorAt(k, col.set(q.c));
    });
    b.receiveShadow = t.receiveShadow = true;
    // Lit windows for after dark: a few warm panes on each street-facing wall.
    const panes: THREE.Matrix4[] = [];
    o.rotation.set(0, 0, 0);
    bList.forEach((q) => {
      const n = q.h > 10 ? 3 + Math.floor(rnd() * 5) : rnd() < 0.45 ? 1 : 0;
      for (let k = 0; k < n; k++) {
        const side = Math.floor(rnd() * 4), y = 2 + rnd() * Math.max(1, q.h - 4);
        const along = (rnd() - 0.5) * 0.8;
        o.scale.set(side < 2 ? 3.2 : 0.3, 1.6, side < 2 ? 0.3 : 3.2);
        if (side === 0) o.position.set(q.x + along * q.w, y, q.z + q.d / 2 + 0.1);
        else if (side === 1) o.position.set(q.x + along * q.w, y, q.z - q.d / 2 - 0.1);
        else if (side === 2) o.position.set(q.x + q.w / 2 + 0.1, y, q.z + along * q.d);
        else o.position.set(q.x - q.w / 2 - 0.1, y, q.z + along * q.d);
        o.updateMatrix();
        panes.push(o.matrix.clone());
      }
    });
    const windows = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), lightMats.cityWindow, panes.length);
    panes.forEach((mx, k) => windows.setMatrixAt(k, mx));
    const lampGeo = new THREE.OctahedronGeometry(1.3, 0);
    const streetLamps = new THREE.InstancedMesh(lampGeo, lightMats.sodium, lamps.length);
    lamps.forEach(([lx, lz], k) => { o.position.set(lx + 6, 8, lz + 6); o.scale.setScalar(1); o.updateMatrix(); streetLamps.setMatrixAt(k, o.matrix); });
    return { buildings: b, roofs, trees: t, windows, streetLamps };
  }, []);

  const streets = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const strip = (x0: number, x1: number, z0: number, z1: number, color: string, y = 0.02) => {
      if (x1 - x0 < 1 || z1 - z0 < 1) return;
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      g.rotateX(-Math.PI / 2);
      g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
      parts.push(tint(g, color));
    };
    const W = 14;
    for (let i = 0, x = CITY.x0; x < CITY.x1; i++, x += LOT) {
      if (i % STREET_EVERY) continue;
      const cx = x + LOT / 2;
      if (cx > FIELD.x0 - 40 && cx < FIELD.x1 + 40) {
        strip(cx - W / 2, cx + W / 2, CITY.z0, FIELD.z0 - 40, "#5B5F66");
        strip(cx - W / 2, cx + W / 2, FIELD.z1 + 40, CITY.z1, "#5B5F66");
      } else strip(cx - W / 2, cx + W / 2, CITY.z0, CITY.z1, "#5B5F66");
    }
    for (let j = 0, z = CITY.z0; z < CITY.z1; j++, z += LOT) {
      if (j % STREET_EVERY) continue;
      const cz = z + LOT / 2;
      if (cz > FIELD.z0 - 40 && cz < FIELD.z1 + 40) {
        strip(CITY.x0, FIELD.x0 - 40, cz - W / 2, cz + W / 2, "#5B5F66", 0.025);
        strip(FIELD.x1 + 40, CITY.x1, cz - W / 2, cz + W / 2, "#5B5F66", 0.025);
      } else strip(CITY.x0, CITY.x1, cz - W / 2, cz + W / 2, "#5B5F66", 0.025);
    }
    // Freeway: concrete deck, median barrier, lane stripes
    strip(FWY_X - FWY_W / 2, FWY_X + FWY_W / 2, CITY.z0, CITY.z1, "#8D9198", 0.05);
    strip(FWY_X - 0.6, FWY_X + 0.6, CITY.z0, CITY.z1, "#CBD5E1", 0.6);
    for (const lx of [-12, 12]) for (let z = CITY.z0; z < CITY.z1; z += 24) strip(FWY_X + lx - 0.15, FWY_X + lx + 0.15, z, z + 9, "#F1F5F9", 0.07);
    return mergeGeometries(parts, false)!;
  }, []);

  // Freeway traffic: two lanes each way, continuous loop; cars glow head/tail lights after dusk.
  const cars = useMemo(() => {
    const body = new THREE.BoxGeometry(2, 1.5, 4.6);
    body.translate(0, 0.85, 0);
    const m = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5 }), FWY_LANES.length * CARS_PER_LANE);
    const col = new THREE.Color();
    for (let k = 0; k < m.count; k++) m.setColorAt(k, col.set(CAR[k % CAR.length]));
    m.frustumCulled = false;
    const bulb = new THREE.SphereGeometry(0.5, 6, 4);
    const head = new THREE.InstancedMesh(bulb, lightMats.white, m.count);
    const tail = new THREE.InstancedMesh(bulb, lightMats.red, m.count);
    head.frustumCulled = tail.frustumCulled = false;
    const phase = Array.from({ length: m.count }, () => rnd());
    const speed = Array.from({ length: m.count }, () => 26 + rnd() * 8);
    return { m, head, tail, phase, speed };
  }, []);

  useFrame((state) => {
    const t = state.clock.elapsedTime, span = CITY.z1 - CITY.z0;
    const glow = sim.night > 0.2 ? 1 : 0.001;
    FWY_LANES.forEach((lx, li) => {
      const dir = lx < 0 ? 1 : -1; // west lanes run north-to-south (+z)
      for (let c = 0; c < CARS_PER_LANE; c++) {
        const k = li * CARS_PER_LANE + c;
        const along = (((cars.phase[k] + c / CARS_PER_LANE) * span + t * cars.speed[k]) % span + span) % span;
        const z = dir > 0 ? CITY.z0 + along : CITY.z1 - along, x = FWY_X + lx;
        o.position.set(x, 0, z); o.rotation.set(0, dir > 0 ? 0 : Math.PI, 0); o.scale.setScalar(1); o.updateMatrix();
        cars.m.setMatrixAt(k, o.matrix);
        o.rotation.set(0, 0, 0); o.scale.setScalar(glow);
        o.position.set(x, 0.9, z + dir * 2.4); o.updateMatrix(); cars.head.setMatrixAt(k, o.matrix);
        o.position.set(x, 0.9, z - dir * 2.4); o.updateMatrix(); cars.tail.setMatrixAt(k, o.matrix);
      }
    });
    cars.m.instanceMatrix.needsUpdate = cars.head.instanceMatrix.needsUpdate = cars.tail.instanceMatrix.needsUpdate = true;
  });

  const ground = useMemo(() => {
    // Urban ground around the field: four slabs that leave the airfield grass alone.
    const parts = [
      [CITY.x0, FIELD.x0, CITY.z0, CITY.z1], [FIELD.x1, CITY.x1, CITY.z0, CITY.z1],
      [FIELD.x0, FIELD.x1, CITY.z0, FIELD.z0], [FIELD.x0, FIELD.x1, FIELD.z1, CITY.z1],
    ].map(([x0, x1, z0, z1]) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      const uv = g.getAttribute("uv") as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, (x0 + uv.getX(k) * (x1 - x0)) / 260, (z0 + uv.getY(k) * (z1 - z0)) / 260);
      g.rotateX(-Math.PI / 2);
      g.translate((x0 + x1) / 2, -0.15, (z0 + z1) / 2);
      return g;
    });
    return mergeGeometries(parts, false)!;
  }, []);

  return (
    <group>
      <mesh geometry={ground} receiveShadow><meshStandardMaterial color="#C9C0AE" map={urban} roughness={1} polygonOffset polygonOffsetFactor={2} polygonOffsetUnits={2} /></mesh>
      <mesh geometry={streets}><meshStandardMaterial vertexColors roughness={0.9} /></mesh>
      <primitive object={buildings} />
      <primitive object={roofs} />
      <primitive object={windows} />
      <primitive object={streetLamps} />
      <primitive object={trees} />
      <primitive object={cars.m} /><primitive object={cars.head} /><primitive object={cars.tail} />
    </group>
  );
}
