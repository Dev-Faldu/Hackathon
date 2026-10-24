// Art-directed sky dome: zenith-to-horizon gradient, sun disc and glow, blended day -> dusk -> night.
// Cheaper and more controllable than a physical sky; the fog takes the horizon colour so the hills melt into it.
import * as THREE from "three";

const PALETTE = {
  day: { zenith: new THREE.Color("#3A78CF"), horizon: new THREE.Color("#CFE0F0") },
  dusk: { zenith: new THREE.Color("#3F4F88"), horizon: new THREE.Color("#F2AE7A") },
  night: { zenith: new THREE.Color("#02060E"), horizon: new THREE.Color("#0F1A2D") },
};

export function createSkyDome(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uZenith: { value: PALETTE.day.zenith.clone() }, uHorizon: { value: PALETTE.day.horizon.clone() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color("#FFF2D6") }, uSun: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // pin to the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSun;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
        col = mix(col, uHorizon * 0.82, smoothstep(0.0, -0.12, h));
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSunColor * uSun * (pow(s, 2200.0) * 14.0 + pow(s, 40.0) * 0.35 + pow(s, 6.0) * 0.12);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(60000, 48, 24), mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

const tmpZ = new THREE.Color(), tmpH = new THREE.Color();

/** Updates the dome for the current sun and returns the horizon colour (for fog and ambient). */
export function updateSkyDome(dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>, sunDir: THREE.Vector3, el: number,
  dusk: number, night: number): THREE.Color {
  const u = dome.material.uniforms;
  tmpZ.copy(PALETTE.day.zenith).lerp(PALETTE.dusk.zenith, dusk * 0.85).lerp(PALETTE.night.zenith, night);
  tmpH.copy(PALETTE.day.horizon).lerp(PALETTE.dusk.horizon, dusk * 0.9).lerp(PALETTE.night.horizon, night);
  u.uZenith.value.copy(tmpZ);
  u.uHorizon.value.copy(tmpH);
  u.uSunDir.value.copy(sunDir);
  u.uSunColor.value.set("#FFF2D6").lerp(new THREE.Color("#FF9A4D"), dusk);
  u.uSun.value = THREE.MathUtils.clamp((el + 1.5) / 3, 0, 1);
  return tmpH;
}
