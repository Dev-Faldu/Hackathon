// The 3D world: sky and sun that follow the replay clock, cinematic camera rig, and post-processing.
import { OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { ParkingPosition } from "../lib/types";
import { Airport, lightMats } from "./Airport";
import type { Slot } from "./compact";
import { createSkyDome, updateSkyDome } from "./sky";
import { COMPASS_OFFSET_DEG, type FlightPlan3D, sun } from "./layout";
import { CAMERAS, type CameraMode, focus, sim } from "./state";
import { Surroundings } from "./Surroundings";
import { TfrCurtain } from "./Tfr";
import { Traffic } from "./Traffic";

const DAY = new THREE.Color("#C3D3E4"), DUSK = new THREE.Color("#E3AE8A"), NIGHT = new THREE.Color("#0A1322");
const tmpC = new THREE.Color();

function SimClock({ tMs, playing, speed }: { tMs: number; playing: boolean; speed: number }) {
  useEffect(() => { if (!playing) sim.ms = tMs; }, [tMs, playing]);
  useEffect(() => { sim.ms = tMs; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((_, dt) => {
    if (playing) {
      sim.ms += Math.min(dt, 0.1) * speed * 1000;
      if (Math.abs(sim.ms - tMs) > speed * 1000 * 0.75) sim.ms = tMs;
    } else sim.ms = tMs;
  }, -2);
  return null;
}

function Atmosphere() {
  const { scene, gl } = useThree();
  const sky = useMemo(createSkyDome, []);
  const skyScene = useMemo(() => { const sc = new THREE.Scene(); return sc; }, []);
  const pmrem = useMemo(() => new THREE.PMREMGenerator(gl), [gl]);
  const sunLight = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const stars = useRef<THREE.Group>(null);
  const floods = useRef<THREE.Group>(null);
  const lastEl = useRef(999);
  const envRT = useRef<THREE.WebGLRenderTarget | null>(null);
  const sunVec = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    scene.add(sky);
    scene.fog = new THREE.Fog(DAY.clone(), 1800, 32000);
    return () => { scene.remove(sky); scene.fog = null; };
  }, [scene, sky]);

  useFrame(() => {
    const { el, az } = sun(sim.ms);
    const phi = THREE.MathUtils.degToRad(90 - el), theta = THREE.MathUtils.degToRad(az - COMPASS_OFFSET_DEG);
    sunVec.setFromSphericalCoords(1, phi, theta);
    const day = THREE.MathUtils.clamp(el / 12, 0, 1);
    const dusk = THREE.MathUtils.clamp(1 - Math.abs(el - 2) / 9, 0, 1);
    const night = THREE.MathUtils.clamp((-el + 1) / 8, 0, 1);
    const horizon = updateSkyDome(sky, sunVec, el, dusk, night);
    sim.night = night;
    if (sunLight.current) {
      const L = sunLight.current;
      if (el > -2) L.position.copy(sunVec).multiplyScalar(1600).add(new THREE.Vector3(0, 0, 150));
      else L.position.set(-600, 900, -300); // moonlight
      L.intensity = el > -2 ? 0.3 + 3.4 * day + 1.3 * dusk : 0.25;
      L.color.set(el > -2 ? "#FFF6E8" : "#9DB4E0").lerp(tmpC.set("#FFB37A"), dusk * 0.7);
    }
    if (hemi.current) {
      hemi.current.intensity = 0.18 + 0.36 * day + 0.38 * dusk;
      hemi.current.color.copy(DAY).lerp(DUSK, dusk * 0.85).lerp(NIGHT, night * 0.85);
    }
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(horizon);
    if (stars.current) stars.current.visible = night > 0.35;
    if (floods.current) floods.current.children.forEach((c) => { (c as THREE.PointLight).intensity = 2600 * night; });
    lightMats.pool.opacity = 0.3 * night;
    const city = THREE.MathUtils.smoothstep(night, 0.05, 0.6);
    lightMats.sodium.visible = lightMats.cityWindow.visible = city > 0.02;
    lightMats.sodium.color.setRGB(3.6 * city, 1.8 * city, 0.5 * city);
    lightMats.cityWindow.color.setRGB(2.1 * city, 1.55 * city, 0.9 * city);
    lightMats.window.emissiveIntensity = 0.15 + 2.4 * night;
    lightMats.flood.color.setScalar(0.6 + 2.8 * night);
    if (Math.abs(el - lastEl.current) > 1.2) {
      lastEl.current = el;
      skyScene.add(sky);
      envRT.current?.dispose();
      envRT.current = pmrem.fromScene(skyScene, 0, 1, 200000);
      scene.add(sky);
      scene.environment = envRT.current.texture;
      scene.environmentIntensity = 0.12 + 0.3 * day;
    }
  });

  return (
    <>
      <directionalLight ref={sunLight} castShadow intensity={2.4} shadow-mapSize={[4096, 4096]} shadow-bias={-0.0004} shadow-normalBias={0.6}
        shadow-camera-left={-760} shadow-camera-right={760} shadow-camera-top={760} shadow-camera-bottom={-760}
        shadow-camera-near={10} shadow-camera-far={4200}>
        <object3D attach="target" position={[0, 0, 150]} />
      </directionalLight>
      <hemisphereLight ref={hemi} args={["#C3D3E4", "#5B5A48", 0.5]} />
      <group ref={floods}>
        {[[-150, 45, -120], [-150, 45, 160], [-60, 45, 420], [240, 45, -60], [240, 45, 240], [-560, 40, -60]].map((p, i) => (
          <pointLight key={i} position={p as [number, number, number]} intensity={0} distance={0} decay={2} color="#FFE2B0" />
        ))}
      </group>
      <group ref={stars}><Stars radius={30000} depth={8000} count={5000} factor={260} saturation={0} fade /></group>
    </>
  );
}

function CameraRig({ mode, follow, cinematic, modeNonce, cockpit }: { mode: CameraMode; follow: boolean; cinematic: boolean; modeNonce: number; cockpit: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const look = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    // Wider lens in the cockpit, the usual one outside; orbit controls hand back where the pilot was looking.
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = cockpit ? 62 : 40; cam.near = cockpit ? 0.5 : 4; cam.updateProjectionMatrix();
    if (controls.current) controls.current.enabled = !cockpit;
    if (!cockpit && controls.current && focus.active) {
      controls.current.target.set(focus.x, focus.y + 3, focus.z);
      camera.position.set(focus.x - Math.sin(focus.heading) * 70, focus.y + 30, focus.z - Math.cos(focus.heading) * 70);
    }
  }, [cockpit, camera]);
  const flying = useRef(true);
  const goal = useRef({ pos: new THREE.Vector3(...CAMERAS[mode].pos), target: new THREE.Vector3(...CAMERAS[mode].target) });
  useEffect(() => {
    goal.current = { pos: new THREE.Vector3(...CAMERAS[mode].pos), target: new THREE.Vector3(...CAMERAS[mode].target) };
    flying.current = true;
  }, [mode, modeNonce]);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const stop = () => { flying.current = false; };
    c.addEventListener("start", stop);
    return () => c.removeEventListener("start", stop);
  }, []);
  const off = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const k = 1 - Math.exp(-dt * 2.2);
    if (cockpit && focus.active) {
      // Pilot's eye: just behind the windscreen, looking along the jet's heading and a little down the nose.
      const h = focus.heading, pt = focus.pitch, fx = Math.sin(h) * Math.cos(pt), fz = Math.cos(h) * Math.cos(pt), fy = Math.sin(pt);
      camera.position.set(focus.x + fx * focus.nose, focus.y + focus.eye + fy * focus.nose, focus.z + fz * focus.nose);
      look.set(camera.position.x + fx * 200, camera.position.y + fy * 200 - 11, camera.position.z + fz * 200);
      camera.lookAt(look);
      c.target.copy(look);
      return;
    }
    if (follow && focus.active) {
      const target = new THREE.Vector3(focus.x, focus.y + 3, focus.z);
      off.copy(camera.position).sub(c.target);
      const dist = THREE.MathUtils.clamp(off.length(), 45, 260);
      off.setLength(dist);
      if (off.y < 12) off.y = 12;
      c.target.lerp(target, Math.min(1, k * 2));
      camera.position.lerp(target.clone().add(off), Math.min(1, k * 2));
    } else if (flying.current) {
      camera.position.lerp(goal.current.pos, k);
      c.target.lerp(goal.current.target, k);
      if (camera.position.distanceTo(goal.current.pos) < 1 && c.target.distanceTo(goal.current.target) < 1) flying.current = false;
    }
    c.autoRotate = cinematic && !follow;
    c.update();
  });
  return (
    <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI / 2 - 0.03}
      minDistance={20} maxDistance={6000} autoRotateSpeed={0.35} />
  );
}

export interface WorldProps {
  plans: FlightPlan3D[]; positions: ParkingPosition[]; tempZone: boolean; labels: boolean;
  selected: string | null; onSelect: (id: string | null) => void;
  camera: CameraMode; cameraNonce: number; follow: boolean; cinematic: boolean; tMs: number; playing: boolean; speed: number;
  quality: "high" | "fast"; tfr: boolean; compactSlots: Slot[] | null; cockpit: boolean; colorBySize: boolean;
}

export default function World(p: WorldProps) {
  return (
    <Canvas shadows dpr={[1, p.quality === "high" ? 1.75 : 1.1]} flat
      camera={{ position: [-3200, 1700, 3400], fov: 40, near: 4, far: 80000 }}
      gl={{ antialias: false, powerPreference: "high-performance", stencil: false }}
      onPointerMissed={() => p.onSelect(null)}>
      <SimClock tMs={p.tMs} playing={p.playing} speed={p.speed} />
      <Atmosphere />
      <Suspense fallback={null}>
        <Airport positions={p.positions} tempZone={p.tempZone} labels={p.labels} compactSlots={p.compactSlots} />
        <Surroundings />
        {p.tfr && <TfrCurtain />}
        <Traffic plans={p.plans} selected={p.selected} onSelect={p.onSelect} colorBySize={p.colorBySize} />
      </Suspense>
      <CameraRig mode={p.camera} follow={p.follow} cinematic={p.cinematic} modeNonce={p.cameraNonce} cockpit={p.cockpit} />
      <EffectComposer multisampling={p.quality === "high" ? 4 : 0} enableNormalPass={false}>
        {p.quality === "high" ? <N8AO halfRes aoRadius={8} intensity={2.4} distanceFalloff={1.2} quality="performance" /> : <></>}
        <Bloom mipmapBlur luminanceThreshold={1.05} luminanceSmoothing={0.2} intensity={1.1} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <Vignette offset={0.28} darkness={0.42} />
      </EffectComposer>
    </Canvas>
  );
}
