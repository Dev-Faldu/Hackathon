// What a pilot reads on the airfield: runway designators, taxiway and holding position signs, distance
// remaining boards and the windsock. Colours and layouts follow FAA AC 150/5340-18 (signs) and -1 (markings).
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ACCESS_X, EXIT_X, HOLD_X, OTHER, RWY, RWY_L, TWY } from "./layout";
import { tint } from "./models";

type Kind = "loc" | "dir" | "mand" | "dist";
type Panel = [Kind, string];
// Location: yellow on black with a yellow border. Direction: black on yellow. Mandatory: white on red, outlined black.
const STYLE: Record<Kind, { bg: string; fg: string; edge?: string; outline?: string }> = {
  loc: { bg: "#111111", fg: "#FACC15", edge: "#FACC15" },
  dir: { bg: "#FACC15", fg: "#111111" },
  mand: { bg: "#C81E1E", fg: "#FFFFFF", outline: "#111111" },
  dist: { bg: "#111111", fg: "#F8FAFC" },
};
const ARROWS: Record<string, number> = { "←": Math.PI, "→": 0, "↘": Math.PI / 4, "↙": (3 * Math.PI) / 4 };
const FONT = "bold 92px Arial, Helvetica, sans-serif", H = 128, ARROW_W = 78;

/** Paints a row of sign panels onto a canvas and returns it with its width/height ratio. */
function paint(panels: Panel[]): { tex: THREE.CanvasTexture; aspect: number } {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = FONT;
  const widths = panels.map(([, t]) => [...t].reduce((w, ch) => w + (ch in ARROWS ? ARROW_W : ch === " " ? 18 : ctx.measureText(ch).width + 4), 0) + 48);
  c.width = Math.ceil(widths.reduce((a, b) => a + b, 0)); c.height = H;
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  let x = 0;
  panels.forEach(([kind, text], i) => {
    const st = STYLE[kind], w = widths[i];
    ctx.fillStyle = st.bg;
    ctx.fillRect(x, 0, w, H);
    if (st.edge) { ctx.strokeStyle = st.edge; ctx.lineWidth = 7; ctx.strokeRect(x + 9, 9, w - 18, H - 18); }
    let cx = x + 24;
    for (const ch of text) {
      if (ch in ARROWS) {
        ctx.save(); ctx.translate(cx + ARROW_W / 2, H / 2); ctx.rotate(ARROWS[ch]);
        ctx.beginPath();
        ctx.moveTo(-30, -8); ctx.lineTo(4, -8); ctx.lineTo(4, -26); ctx.lineTo(32, 0); ctx.lineTo(4, 26); ctx.lineTo(4, 8); ctx.lineTo(-30, 8);
        ctx.closePath(); ctx.fillStyle = st.fg; ctx.fill(); ctx.restore();
        cx += ARROW_W;
      } else if (ch === " ") cx += 18;
      else {
        if (st.outline) { ctx.strokeStyle = st.outline; ctx.lineWidth = 6; ctx.strokeText(ch, cx, H / 2 + 4); }
        ctx.fillStyle = st.fg; ctx.fillText(ch, cx, H / 2 + 4);
        cx += ctx.measureText(ch).width + 4;
      }
    }
    if (i < panels.length - 1) { ctx.fillStyle = "#111111"; ctx.fillRect(x + w - 2, 0, 4, H); }
    x += w;
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, aspect: c.width / c.height };
}

interface SignSpec { front: Panel[]; back?: Panel[]; x: number; z: number; face: number; h?: number }

const FRAME = new THREE.MeshStandardMaterial({ color: "#3F4650", roughness: 0.7 });

/** One sign: a lit panel box on two frangible legs. `face` is the heading its front looks toward. */
function Sign({ spec }: { spec: SignSpec }) {
  const { mesh, legs } = useMemo(() => {
    const f = paint(spec.front), b = spec.back ? paint(spec.back) : f;
    const h = spec.h ?? 1.1, w = h * Math.max(f.aspect, b.aspect);
    const mat = (t: THREE.Texture) => new THREE.MeshStandardMaterial({ map: t, emissive: "#FFFFFF", emissiveMap: t, emissiveIntensity: 0.28, roughness: 0.55 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.3), [FRAME, FRAME, FRAME, FRAME, mat(f.tex), mat(b.tex)]);
    mesh.position.y = 0.45 + h / 2;
    const legs = mergeGeometries([-1, 1].map((s) => { const g = new THREE.BoxGeometry(0.12, 0.5, 0.12); g.translate(s * w * 0.35, 0.25, 0); return g; }), false)!;
    return { mesh, legs };
  }, [spec]);
  return (
    <group position={[spec.x, 0, spec.z]} rotation-y={spec.face}>
      <primitive object={mesh} />
      <mesh geometry={legs} material={FRAME} />
    </group>
  );
}

// Faces: the direction the sign's front looks, as a world heading (0 = +Z, PI/2 = +X).
const TOWARD_PLUS_Z = 0, TOWARD_MINUS_Z = Math.PI, TOWARD_PLUS_X = Math.PI / 2, TOWARD_MINUS_X = -Math.PI / 2;
export const CONNECTORS = { C: -700, D: 200 };

function signs(): SignSpec[] {
  const out: SignSpec[] = [
    // A1: holding position for 16R at the departure end, location sign outboard.
    { front: [["loc", "A1"], ["mand", "16R-34L"]], x: HOLD_X - 22, z: RWY.z + 41, face: TOWARD_PLUS_Z },
    // Approaching A1 westbound on A.
    { front: [["loc", "A"], ["dir", "A1→"]], x: HOLD_X + 95, z: TWY.z + 20, face: TOWARD_PLUS_X },
    // Leaving our ramp and the other FBOs' ramp onto A; destination sign for the departure runway.
    { front: [["dir", "←A→"], ["dir", "←16R"]], x: ACCESS_X - 24, z: TWY.z + 22, face: TOWARD_PLUS_Z },
    { front: [["dir", "←A→"], ["dir", "←16R"]], x: OTHER.accessX - 24, z: TWY.z + 22, face: TOWARD_PLUS_Z },
    // High-speed exit B off 16R, then B meets A.
    { front: [["dir", "B↘"]], x: EXIT_X - 130, z: RWY.z + RWY.width / 2 + 13, face: TOWARD_MINUS_X },
    { front: [["loc", "B"], ["dir", "←A→"]], x: EXIT_X + 22, z: TWY.z - 26, face: TOWARD_MINUS_Z },
  ];
  // Location signs along A, readable both ways.
  for (const x of [-820, -420, 260, 700]) out.push({ front: [["loc", "A"]], back: [["loc", "A"]], x, z: TWY.z - 20, face: TOWARD_PLUS_X });
  // Crossing connectors C and D between the parallel runways: hold short of each runway.
  for (const [name, x] of Object.entries(CONNECTORS)) {
    out.push({ front: [["loc", name], ["mand", "16R-34L"]], x: x + 16, z: RWY.z - RWY.width / 2 - 15, face: TOWARD_MINUS_Z });
    out.push({ front: [["loc", name], ["mand", "16L-34R"]], x: x - 16, z: RWY_L.z + RWY_L.width / 2 + 15, face: TOWARD_PLUS_Z });
  }
  // Distance remaining, thousands of feet: front for 16R landings, back for 34L. The two always add to 8.
  for (let n = 1; n <= 7; n++) {
    const x = RWY.x1 - n * 304.8;
    out.push({ front: [["dist", String(n)]], back: [["dist", String(8 - n)]], x, z: RWY.z - RWY.width / 2 - 18, face: TOWARD_MINUS_X, h: 1.5 });
  }
  return out;
}

/** Runway designators: number beyond the letter, both read upright by a pilot on final. */
function Designator({ num, letter, x, z, toward, scale = 1 }: { num: string; letter: string; x: number; z: number; toward: 1 | -1; scale?: number }) {
  const mesh = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 512;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#F8FAFC";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold 220px 'Arial Narrow', Arial, sans-serif";
    ctx.fillText(num, 128, 140);
    ctx.fillText(letter, 128, 390);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const g = new THREE.PlaneGeometry(18 * scale, 36 * scale);
    g.rotateX(-Math.PI / 2);
    g.rotateY(toward > 0 ? -Math.PI / 2 : Math.PI / 2); // canvas top points along the landing direction
    g.translate(x, 0.14, z);
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false }));
  }, [num, letter, x, z, toward, scale]);
  return <primitive object={mesh} />;
}

/** Windsock beside the 16R touchdown zone. Wind 160 deg at 8 kt: the sock points down the runway toward 34L's end, half full. */
function Windsock({ x, z }: { x: number; z: number }) {
  const sock = useRef<THREE.Group>(null);
  const { pole, cloth, circle } = useMemo(() => {
    const p = new THREE.CylinderGeometry(0.09, 0.14, 6, 8); p.translate(0, 3, 0);
    const ring = new THREE.TorusGeometry(0.45, 0.04, 6, 16); ring.rotateY(Math.PI / 2); ring.translate(0, 6, 0);
    // Five bands, orange and white, each 3 kt of wind when full.
    const bands = [0, 1, 2, 3, 4].map((i) => {
      const r0 = 0.45 - i * 0.05, r1 = 0.45 - (i + 1) * 0.05;
      const g = new THREE.CylinderGeometry(r0, r1, 0.75, 14, 1, true);
      g.rotateZ(Math.PI / 2); g.translate(-0.375 - i * 0.75, 0, 0);
      return tint(g, i % 2 ? "#F8FAFC" : "#F97316");
    });
    // Segmented circle around the sock, as at most US fields.
    const segs = Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2, g = new THREE.BoxGeometry(3.2, 0.3, 0.6);
      g.rotateY(-a + Math.PI / 2); g.translate(Math.cos(a) * 13, 0.15, Math.sin(a) * 13);
      return tint(g, "#F1F5F9");
    });
    return { pole: mergeGeometries([tint(p, "#E5E7EB"), tint(ring, "#9CA3AF")], false)!, cloth: mergeGeometries(bands, false)!, circle: mergeGeometries(segs, false)! };
  }, []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (sock.current) {
      sock.current.rotation.y = 0.08 * Math.sin(t * 0.7) + 0.04 * Math.sin(t * 2.3); // gusts swing it a few degrees
      sock.current.rotation.z = 0.32 + 0.06 * Math.sin(t * 1.1);                    // 8 kt: drooping about 20 degrees
    }
  });
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={pole}><meshStandardMaterial vertexColors roughness={0.6} /></mesh>
      <mesh geometry={circle}><meshStandardMaterial vertexColors roughness={0.8} /></mesh>
      <group ref={sock} position={[0, 6, 0]}>
        <mesh geometry={cloth}><meshStandardMaterial vertexColors roughness={0.9} side={THREE.DoubleSide} /></mesh>
      </group>
    </group>
  );
}

export function AirfieldSigns() {
  const list = useMemo(signs, []);
  return (
    <group>
      {list.map((s, i) => <Sign key={i} spec={s} />)}
      <Designator num="16" letter="R" x={RWY.x0 + 63} z={RWY.z} toward={1} />
      <Designator num="34" letter="L" x={RWY.x1 - 63} z={RWY.z} toward={-1} />
      <Designator num="16" letter="L" x={RWY_L.x0 + 42} z={RWY_L.z} toward={1} scale={0.62} />
      <Designator num="34" letter="R" x={RWY_L.x1 - 42} z={RWY_L.z} toward={-1} scale={0.62} />
      <Windsock x={RWY.x0 + 340} z={RWY.z - 95} />
    </group>
  );
}
