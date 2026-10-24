// Game-day TFR around SoFi Stadium, drawn as a translucent curtain on the horizon while it is active.
import { Html } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";

// Schematic placement: the real stadium is ~31 km from VNY. Core radius is inner_core_nm in contracts/assumptions.yaml.
const SOFI = { x: 21000, z: -21000 };
const R = 10 * 1852, H = 1500;

export function TfrCurtain() {
  const alpha = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 4; c.height = 256;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "rgb(40,40,40)");
    g.addColorStop(0.08, "rgb(150,150,150)");
    g.addColorStop(0.5, "rgb(70,70,70)");
    g.addColorStop(1, "rgb(170,170,170)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
    return new THREE.CanvasTexture(c);
  }, []);
  const label = useMemo(() => {
    const d = Math.hypot(SOFI.x, SOFI.z), k = (d - R) / d;
    return [SOFI.x * k, 420, SOFI.z * k] as [number, number, number];
  }, []);
  return (
    <group>
      <mesh position={[SOFI.x, H / 2, SOFI.z]} renderOrder={2}>
        <cylinderGeometry args={[R, R, H, 180, 1, true]} />
        <meshBasicMaterial color="#D946EF" alphaMap={alpha} transparent opacity={0.42} side={THREE.DoubleSide} depthWrite={false} fog={false} />
      </mesh>
      {[H, 6].map((y) => (
        <mesh key={y} position={[SOFI.x, y, SOFI.z]} rotation-x={-Math.PI / 2}>
          <torusGeometry args={[R, y > 10 ? 18 : 10, 4, 220]} />
          <meshBasicMaterial color={new THREE.Color(2.6, 0.6, 2.8)} toneMapped={false} fog={false} />
        </mesh>
      ))}
      <Html position={label} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <div style={{
          whiteSpace: "nowrap", padding: "5px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, color: "#86198F",
          background: "rgba(253,244,255,0.86)", border: "1px solid rgba(240,171,252,0.9)", boxShadow: "0 6px 18px rgba(134,25,143,0.22)",
          backdropFilter: "blur(10px)", fontFamily: '"Geist Variable", system-ui, sans-serif',
        }}>SoFi TFR · 10 nm core · active</div>
      </Html>
    </group>
  );
}
