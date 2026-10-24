// Every flight as an instanced jet, plus the ground vehicles that serve them, animated from the sim clock.
import { Html } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { SIZE_LABEL } from "../lib/format";
import type { SizeClass } from "../lib/types";
import { CURB, lightMats } from "./Airport";
import { DIMS, type FlightPlan3D, poseAt, TOW_ASIDE_MS } from "./layout";
import { crewStats, focus, sim, trafficStats } from "./state";
import { coneGeometry, fuelTruckGeometry, jetGeometry, jetLights, personGeometry, suvGeometry, tugGeometry, wandGeometry } from "./models";


const SIZES: SizeClass[] = ["light", "mid", "super_mid", "large", "other"];
const MIN = 60_000;
const o3 = new THREE.Object3D();
const v = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const am = new THREE.Matrix4(); // the current aircraft's matrix (o3 is reused for lights and vehicles)
const AIRBORNE = new Set(["approach", "rollout", "lineup", "takeoff", "climb"]);
const N_WALK = 160, N_MARSHAL = 40, N_CREW = 160, N_CONE = 900, N_QUEUE = 60;
const MARSHAL_MS = 100_000; // marshaller on the stand for the last 100 s of the taxi in

function pool(geom: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow = true) {
  const m = new THREE.InstancedMesh(geom, mat, n);
  m.frustumCulled = false;
  m.castShadow = shadow;
  m.receiveShadow = false;
  for (let i = 0; i < n; i++) m.setMatrixAt(i, ZERO);
  return m;
}

export function Traffic({ plans, selected, onSelect }: {
  plans: FlightPlan3D[]; selected: string | null; onSelect: (id: string | null) => void;
}) {
  const paint = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.3, envMapIntensity: 1.1 }), []);
  const vehMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 }), []);
  const bySize = useMemo(() => {
    const out = {} as Record<SizeClass, FlightPlan3D[]>;
    SIZES.forEach((s) => { out[s] = plans.filter((p) => p.size === s); });
    return out;
  }, [plans]);
  const jets = useMemo(() => {
    const out = {} as Record<SizeClass, THREE.InstancedMesh>;
    SIZES.forEach((s) => { out[s] = pool(jetGeometry(s), paint, Math.max(1, bySize[s].length)); });
    return out;
  }, [bySize, paint]);
  const bulb = useMemo(() => new THREE.SphereGeometry(0.32, 8, 6), []);
  const lights = useMemo(() => ({
    red: pool(bulb, lightMats.red, plans.length * 2 + 1, false),
    green: pool(bulb, lightMats.green, plans.length + 1, false),
    white: pool(bulb, lightMats.white, plans.length + 1, false),
    amber: pool(bulb, lightMats.amber, 60, false),
    land: pool(bulb, lightMats.white, plans.length + 1, false),
  }), [plans.length, bulb]);
  const navLights = useMemo(() => Object.fromEntries(SIZES.map((s) => [s, jetLights(s)])) as Record<SizeClass, ReturnType<typeof jetLights>>, []);
  const vehicles = useMemo(() => ({
    tug: pool(tugGeometry(), vehMat, 60), fuel: pool(fuelTruckGeometry(), vehMat, 24), suv: pool(suvGeometry(), vehMat, 40),
    queue: pool(suvGeometry(), vehMat, N_QUEUE),
  }), [vehMat]);
  // Ramp people: wing walkers (lime vests), marshallers (orange vests, lit wands), service crew (yellow), cones.
  const people = useMemo(() => ({
    walker: pool(personGeometry("#C6F432"), vehMat, N_WALK),
    marshal: pool(personGeometry("#F97316"), vehMat, N_MARSHAL),
    wand: pool(wandGeometry(), lightMats.amber, N_MARSHAL * 2, false),
    crew: pool(personGeometry("#FACC15"), vehMat, N_CREW),
    cone: pool(coneGeometry(), vehMat, N_CONE),
  }), [vehMat]);
  const ring = useRef<THREE.Mesh>(null);
  const tag = useRef<THREE.Group>(null);
  const selPlan = plans.find((p) => p.id === selected) ?? null;

  useFrame((state) => {
    const t = sim.ms;
    const blink = Math.floor(state.clock.elapsedTime * 1.6) % 2 === 0;
    for (const k of Object.keys(trafficStats) as (keyof typeof trafficStats)[]) trafficStats[k] = 0;
    let nRed = 0, nGreen = 0, nWhite = 0, nAmber = 0, nLand = 0, nTug = 0, nFuel = 0, nSuv = 0;
    let nWalk = 0, nMarshal = 0, nWand = 0, nCrew = 0, nCone = 0, queue = 0, rampJets = 0, towsAside = 0;
    const wave = Math.sin(state.clock.elapsedTime * 3.2);
    const person = (m: THREE.InstancedMesh, i: number, x: number, z: number, heading: number) => {
      if (i >= m.count) return;
      o3.position.set(x, 0, z); o3.rotation.set(0, heading, 0); o3.scale.setScalar(1); o3.updateMatrix();
      m.setMatrixAt(i, o3.matrix);
    };
    focus.active = false;
    for (const s of SIZES) {
      const mesh = jets[s], list = bySize[s], L = navLights[s], dim = DIMS[s];
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const p = poseAt(f, t);
        if (!p.visible) { mesh.setMatrixAt(i, ZERO); continue; }
        trafficStats.visible++;
        trafficStats[p.phase]++;
        o3.position.set(p.x, p.y, p.z);
        o3.rotation.set(-p.pitch, p.heading, 0, "YXZ");
        o3.scale.setScalar(1);
        o3.updateMatrix();
        mesh.setMatrixAt(i, o3.matrix);
        am.copy(o3.matrix);
        // Navigation lights: red left tip, green right tip, white tail, flashing red beacon
        v.copy(L.tipL).applyMatrix4(am); setAt(lights.red, nRed++, v);
        v.copy(L.tipR).applyMatrix4(am); setAt(lights.green, nGreen++, v);
        v.copy(L.tail).applyMatrix4(am); setAt(lights.white, nWhite++, v);
        if (blink && p.phase !== "parked") { v.copy(L.beacon).applyMatrix4(am); setAt(lights.red, nRed++, v, 1.5); }
        // Landing lights on the runway and in the air, taxi light on the ground
        if (AIRBORNE.has(p.phase) || p.phase === "taxi_in" || p.phase === "taxi_out") {
          v.copy(L.nose).applyMatrix4(am); setAt(lights.land, nLand++, v, AIRBORNE.has(p.phase) ? 3.4 : 1.8);
        }
        // Cars at the terminal curb: passengers just landed, and drop-offs for the next hour of departures.
        if (!f.other && ((t > f.taxiInEnd && t < f.taxiInEnd + 30 * MIN && t < f.pushStart) || (t > f.pushStart - 45 * MIN && t < f.pushStart))) queue++;
        if (!f.other && (p.phase === "parked" || p.phase === "tow" || p.phase === "pushback")) rampJets++;
        const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
        if (!f.other) {
          const walk = (side: 1 | -1, back = 0) => {
            // Wing walker 1.5 m outboard of the tip, keeping pace with the wing.
            v.set(side * (dim.span / 2 + 1.5), 0, -0.2 * dim.length - back).applyMatrix4(am);
            person(people.walker, nWalk++, v.x, v.z, p.heading);
          };
          const aside = p.phase === "tow" && f.towMoves?.some((mv) => t >= mv.t && t < mv.t + TOW_ASIDE_MS);
          if (aside) towsAside++;
          if (p.phase === "tow" || p.phase === "pushback") { walk(1); walk(-1); if (aside) walk(1, dim.length * 0.4); }
          if (p.phase === "taxi_in" && t > f.taxiInEnd - MARSHAL_MS) {
            // Marshaller ahead of the stop bar facing the cockpit; wing walkers guide the tips into the box.
            const ph = Math.atan2(f.stand.x - f.lane.x, f.stand.z - f.lane.z), d = dim.length / 2 + 7;
            const mx = f.stand.x + Math.sin(ph) * d, mz = f.stand.z + Math.cos(ph) * d;
            if (nMarshal < N_MARSHAL) {
              person(people.marshal, nMarshal++, mx, mz, ph + Math.PI);
              const near = Math.hypot(p.x - f.stand.x, p.z - f.stand.z) < 12;
              for (const side of [1, -1]) {
                // "Come ahead" wands beat overhead; crossed above the head means stop.
                const tilt = near ? side * 0.62 : -side * (0.35 + 0.45 * (0.5 + 0.5 * wave));
                o3.position.set(mx + Math.cos(ph) * side * 0.32, 1.45, mz - Math.sin(ph) * side * 0.32);
                o3.rotation.set(0, ph + Math.PI, tilt, "YXZ"); o3.scale.setScalar(1); o3.updateMatrix();
                if (nWand < people.wand.count) people.wand.setMatrixAt(nWand++, o3.matrix);
              }
            }
            if (Math.hypot(p.x - f.lane.x, p.z - f.lane.z) < dim.length * 4 || Math.hypot(p.x - f.stand.x, p.z - f.stand.z) < 60) { walk(1); walk(-1); }
          }
          if (p.phase === "parked") {
            // Cones off both wingtips and the tail, as soon as the chocks are in.
            for (const c of [[dim.span / 2 + 0.6, -0.2 * dim.length], [-dim.span / 2 - 0.6, -0.2 * dim.length], [0, -0.55 * dim.length], [0, 0.55 * dim.length]]) {
              v.set(c[0], 0, c[1]).applyMatrix4(am);
              person(people.cone, nCone++, v.x, v.z, p.heading);
            }
            if (t < f.taxiInEnd + 20 * MIN || (t > f.pushStart - 30 * MIN)) {
              // Line service at the airstair and the baggage door.
              v.set(-(dim.r + 1.6), 0, 0.3 * dim.length).applyMatrix4(am);
              person(people.crew, nCrew++, v.x, v.z, p.heading - Math.PI / 2);
              v.set(dim.r + 1.8, 0, -0.25 * dim.length).applyMatrix4(am);
              person(people.crew, nCrew++, v.x, v.z, p.heading + Math.PI / 2);
            }
          }
        }
        if (p.tug && nTug < 60) {
          const d = dim.length / 2 + 3.5;
          o3.position.set(p.x + fx * d, 0, p.z + fz * d);
          o3.rotation.set(0, p.heading + Math.PI, 0);
          o3.updateMatrix();
          vehicles.tug.setMatrixAt(nTug++, o3.matrix);
          if (nAmber < 60) setAt(lights.amber, nAmber++, v.set(p.x + fx * d, 2.6, p.z + fz * d), blink ? 1.3 : 0.6);
        }
        if (!f.other && p.phase === "parked" && t > f.D - 50 * MIN && t < f.D - 26 * MIN && nFuel < 24) {
          const d = dim.span / 2 + 4;
          o3.position.set(p.x + fz * d - fx * 4, 0, p.z - fx * d - fz * 4);
          o3.rotation.set(0, p.heading, 0);
          o3.updateMatrix();
          vehicles.fuel.setMatrixAt(nFuel++, o3.matrix);
        }
        if (!f.other && p.phase === "parked" && t > f.taxiInEnd && t < f.taxiInEnd + 18 * MIN && nSuv < 40) {
          const d = dim.r + 5;
          o3.position.set(p.x - fz * d + fx * dim.length * 0.22, 0, p.z + fx * d + fz * dim.length * 0.22);
          o3.rotation.set(0, p.heading, 0);
          o3.updateMatrix();
          vehicles.suv.setMatrixAt(nSuv++, o3.matrix);
        }
        if (f.id === selected) {
          focus.active = true; focus.x = p.x; focus.y = p.y; focus.z = p.z; focus.heading = p.heading;
          if (ring.current) {
            ring.current.visible = p.y < 3; // ground ring only while on the ground
            ring.current.position.set(p.x, 0.2, p.z);
            ring.current.scale.setScalar(dim.span * 0.62 * (1 + 0.06 * Math.sin(state.clock.elapsedTime * 4)));
          }
          if (tag.current) tag.current.position.set(p.x, p.y + dim.r * 2 + 9, p.z);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (!focus.active && ring.current) ring.current.visible = false;
    // The curb queue: nose to tail eastbound in the inside lane, then spilling into the outside lane.
    const nQ = Math.min(N_QUEUE, queue);
    for (let i = 0; i < nQ; i++) {
      const lane = i < 30 ? 0 : 1, k = i % 30;
      o3.position.set(60 - k * 7.2 - lane * 3, 0, CURB.z - 4 + lane * 5.5); o3.rotation.set(0, Math.PI / 2, 0); o3.scale.setScalar(1); o3.updateMatrix();
      vehicles.queue.setMatrixAt(i, o3.matrix);
    }
    crewStats.walkers = nWalk; crewStats.marshallers = nMarshal; crewStats.curbQueue = queue; crewStats.rampJets = rampJets; crewStats.towsAside = towsAside;
    clear(people.walker, nWalk); clear(people.marshal, nMarshal); clear(people.wand, nWand); clear(people.crew, nCrew); clear(people.cone, nCone);
    clear(vehicles.queue, nQ);
    clear(lights.red, nRed); clear(lights.green, nGreen); clear(lights.white, nWhite); clear(lights.amber, nAmber); clear(lights.land, nLand);
    clear(vehicles.tug, nTug); clear(vehicles.fuel, nFuel); clear(vehicles.suv, nSuv);
  });

  const click = (s: SizeClass) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const id = e.instanceId !== undefined ? bySize[s][e.instanceId]?.id : undefined;
    if (id) onSelect(id);
  };

  return (
    <group>
      {SIZES.map((s) => (
        <primitive key={s} object={jets[s]} onPointerDown={click(s)}
          onPointerOver={() => { document.body.style.cursor = "pointer"; }} onPointerOut={() => { document.body.style.cursor = ""; }} />
      ))}
      <primitive object={lights.red} /><primitive object={lights.green} /><primitive object={lights.white} /><primitive object={lights.amber} /><primitive object={lights.land} />
      <primitive object={vehicles.tug} /><primitive object={vehicles.fuel} /><primitive object={vehicles.suv} /><primitive object={vehicles.queue} />
      <primitive object={people.walker} /><primitive object={people.marshal} /><primitive object={people.wand} /><primitive object={people.crew} /><primitive object={people.cone} />
      <mesh ref={ring} rotation-x={-Math.PI / 2} visible={false}>
        <ringGeometry args={[0.92, 1, 64]} />
        <meshBasicMaterial color={new THREE.Color(0.6, 1.6, 4)} toneMapped={false} transparent opacity={0.9} />
      </mesh>
      {selPlan && (
        <group ref={tag}>
          <Html center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
            <div style={{
              whiteSpace: "nowrap", padding: "6px 10px", borderRadius: 12, fontSize: 12, color: "#0B1B33",
              background: "rgba(255,255,255,0.86)", border: "1px solid rgba(255,255,255,0.95)", backdropFilter: "blur(12px)",
              boxShadow: "0 10px 28px rgba(15,30,60,0.22)", fontFamily: '"Geist Variable", system-ui, sans-serif',
            }}>
              <b style={{ fontFamily: '"Geist Mono Variable", monospace' }}>{selPlan.id}</b>
              <span style={{ color: "#4A5B73" }}> · {SIZE_LABEL[selPlan.size]} · {selPlan.position === "OVERFLOW" ? "overflow pad" : selPlan.position}</span>
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}

function setAt(m: THREE.InstancedMesh, i: number, p: THREE.Vector3, scale = 1) {
  if (i >= m.count) return;
  o3.position.copy(p);
  o3.rotation.set(0, 0, 0);
  o3.scale.setScalar(scale);
  o3.updateMatrix();
  m.setMatrixAt(i, o3.matrix);
  o3.scale.setScalar(1);
}

function clear(m: THREE.InstancedMesh, from: number) {
  for (let i = from; i < m.count; i++) m.setMatrixAt(i, ZERO);
  m.instanceMatrix.needsUpdate = true;
}
