// Procedural surface textures painted on canvases at load time: no image assets to ship.
import * as THREE from "three";

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function finish(c: HTMLCanvasElement, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function grain(ctx: CanvasRenderingContext2D, size: number, amount: number) {
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function blot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

/** Portland-cement apron: 4 x 4 slabs per tile with sawn joints, tonal variation and oil stains. */
export function concreteTexture(widthM: number, depthM: number, slabM = 7.5): THREE.CanvasTexture {
  const size = 512, n = 4, s = size / n;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = 162 + Math.round((rnd() - 0.5) * 16);
    ctx.fillStyle = `rgb(${v},${v + 2},${v + 5})`;
    ctx.fillRect(i * s, j * s, s, s);
  }
  for (let k = 0; k < 9; k++) blot(ctx, rnd() * size, rnd() * size, 8 + rnd() * 30, "rgba(60,58,52,1)", 0.18 + rnd() * 0.18);
  grain(ctx, size, 22);
  ctx.strokeStyle = "rgba(78,82,88,0.6)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath(); ctx.moveTo(i * s, 0); ctx.lineTo(i * s, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * s); ctx.lineTo(size, i * s); ctx.stroke();
  }
  const tile = slabM * n;
  return finish(c, widthM / tile, depthM / tile);
}

/** Grooved asphalt with fine aggregate. */
export function asphaltTexture(widthM: number, depthM: number, tileM = 24, base = 78): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = `rgb(${base},${base + 2},${base + 6})`;
  ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 14; k++) blot(ctx, rnd() * size, rnd() * size, 20 + rnd() * 50, rnd() > 0.5 ? "rgba(40,40,44,1)" : "rgba(120,122,126,1)", 0.12);
  grain(ctx, size, 30);
  return finish(c, widthM / tileM, depthM / tileM);
}

/** Winter-green Valley grass with drier patches, so large areas do not read as a flat colour. */
export function grassTexture(repeat: number): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgb(118,128,82)";
  ctx.fillRect(0, 0, size, size);
  const tones = ["rgba(150,146,96,1)", "rgba(96,112,64,1)", "rgba(168,156,108,1)", "rgba(84,100,58,1)"];
  for (let k = 0; k < 70; k++) {
    const x = rnd() * size, y = rnd() * size, r = 30 + rnd() * 110, col = tones[k % tones.length];
    // Draw wrapped copies so the tile has no seams.
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) blot(ctx, x + dx, y + dy, r, col, 0.22);
  }
  grain(ctx, size, 26);
  return finish(c, repeat, repeat);
}

/** Soft radial pool used for floodlight footprints and the tug beacon glow. */
export function poolTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.55)");
  g.addColorStop(0.7, "rgba(255,255,255,0.14)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
