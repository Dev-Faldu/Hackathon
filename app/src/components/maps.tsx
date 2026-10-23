import { geoConicConformal, geoGraticule10, geoInterpolate, geoMercator, geoPath } from "d3-geo";
import { motion } from "framer-motion";
import { Plane } from "lucide-react";
import { useMemo, useState } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countries from "world-atlas/countries-50m.json";
import { cx, dayShort, hhmm, SIZE_COLOR, SIZE_LABEL } from "../lib/format";
import type { Airborne, Ground, Stand } from "../lib/types";

const KVNY: [number, number] = [-118.49, 34.2098];
const SOFI: [number, number] = [-118.3392, 33.9535];
const W = 980, H = 660;

const topo = countries as unknown as Topology<{ countries: GeometryCollection }>;
// Antarctica's ring wraps the pole and floods conic projections, so it is dropped.
const allCountries = feature(topo, topo.objects.countries) as unknown as GeoJSON.FeatureCollection;
const land = { ...allCountries, features: allCountries.features.filter((f) => f.id !== "010") } as GeoJSON.FeatureCollection;

// North America view: conic projection fitted to the continental US, Mexico and southern Canada.
const projection = geoConicConformal().parallels([29.5, 45.5]).rotate([98, 0]);
projection.fitExtent([[24, 24], [W - 24, H - 24]], {
  type: "Feature", properties: {},
  geometry: { type: "MultiPoint", coordinates: [[-124, 49], [-122, 31], [-67, 46], [-79, 25], [-100, 17], [-123, 52]] },
} as never);
const path = geoPath(projection);

// LA basin inset: final ~120 nm, with SoFi's 2022 game-day TFR rings.
const IW = 250, IH = 176;
const inset = geoMercator().center([-118.22, 34.02]).scale(7200).translate([IW / 2, IH / 2]);
const insetPath = geoPath(inset);
const BASIN = [
  { id: "VNY", ll: [-118.49, 34.2098], dx: -8, dy: -6, anchor: "end" }, { id: "BUR", ll: [-118.3585, 34.2007], dx: 6, dy: -4, anchor: "start" },
  { id: "LAX", ll: [-118.4081, 33.9425], dx: -6, dy: 3, anchor: "end" }, { id: "SMO", ll: [-118.4513, 34.0158], dx: -6, dy: -2, anchor: "end" },
  { id: "LGB", ll: [-118.1516, 33.8177], dx: 6, dy: 4, anchor: "start" }, { id: "SNA", ll: [-117.8682, 33.6757], dx: 6, dy: 4, anchor: "start" },
] as { id: string; ll: [number, number]; dx: number; dy: number; anchor: "start" | "end" }[];

function nmRadius(proj: typeof inset, center: [number, number], nm: number) {
  const a = proj(center)!, b = proj([center[0], center[1] + nm / 60])!;
  return Math.abs(a[1] - b[1]);
}

function heading(f: Airborne) {
  const ahead = geoInterpolate([f.lon, f.lat], KVNY)(0.02);
  const a = projection([f.lon, f.lat]), b = projection(ahead);
  if (!a || !b) return 0;
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}

/** Inbound jets converging on Van Nuys. Positions are interpolated along great circles between departure and landing. */
export function FlightMap({ airborne }: { airborne: Airborne[] }) {
  const [hover, setHover] = useState<Airborne | null>(null);
  const vny = projection(KVNY)!;
  const graticule = useMemo(() => path(geoGraticule10()), []);
  const landPath = useMemo(() => path(land), []);
  const insetLand = useMemo(() => insetPath(land), []);
  const sofi = inset(SOFI)!;
  const near = airborne.filter((f) => {
    const p = inset([f.lon, f.lat]);
    return p && p[0] > 4 && p[0] < IW - 4 && p[1] > 4 && p[1] < IH - 4;
  });
  return (
    <div className="relative overflow-hidden rounded-[16px] border border-white/70 bg-gradient-to-b from-[#DCE8F7] to-[#E9F1FB]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Inbound aircraft map">
        <defs>
          <clipPath id="mapclip"><rect width={W} height={H} /></clipPath>
        </defs>
        <g clipPath="url(#mapclip)">
          <path d={graticule ?? ""} fill="none" stroke="rgba(37,99,235,0.07)" />
          <path d={landPath ?? ""} fill="#FFFFFF" stroke="rgba(15,30,60,0.18)" strokeWidth="0.7" />
          {airborne.map((f) => {
            const interp = geoInterpolate([f.origin_lon, f.origin_lat], KVNY);
            const pts = Array.from({ length: 49 }, (_, i) => projection(interp(i / 48))).filter(Boolean) as [number, number][];
            const done = Math.max(1, Math.round(f.progress * 48));
            const c = f.is_international ? "192,38,211" : "37,99,235";
            return (
              <g key={f.flight_id + "-path"}>
                <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={`rgba(${c},0.16)`} strokeWidth="1" strokeDasharray="3 4" />
                <polyline points={pts.slice(0, done + 1).map((p) => p.join(",")).join(" ")} fill="none" stroke={`rgba(${c},0.5)`} strokeWidth="1.5" />
              </g>
            );
          })}
        </g>
        <circle cx={vny[0]} cy={vny[1]} r="20" fill="rgba(37,99,235,0.10)">
          <animate attributeName="r" values="8;26;8" dur="3s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.15;1" dur="3s" repeatCount="indefinite" />
        </circle>
        <circle cx={vny[0]} cy={vny[1]} r="5.5" fill="#2563EB" stroke="white" strokeWidth="2" />
        <text x={vny[0] - 10} y={vny[1] + 22} textAnchor="end" fontSize="12.5" fontWeight="600" fill="#0B1B33">KVNY</text>
        {airborne.map((f) => {
          const raw = projection([f.lon, f.lat]);
          if (!raw) return null;
          const off = raw[0] < 14 || raw[0] > W - 14 || raw[1] < 14 || raw[1] > H - 14;
          const p: [number, number] = [Math.min(W - 18, Math.max(18, raw[0])), Math.min(H - 18, Math.max(18, raw[1]))];
          const color = f.is_international ? "#C026D3" : "#1D4ED8";
          return (
            <motion.g key={f.flight_id} initial={false} animate={{ x: p[0], y: p[1] }} transition={{ duration: 0.45, ease: "linear" }}
              onMouseEnter={() => setHover(f)} onMouseLeave={() => setHover(null)} className="cursor-pointer">
              <circle r={off ? 12 : 10} fill="white" stroke={f.is_international ? "#C026D3" : SIZE_COLOR[f.size_class]} strokeWidth="1.6"
                strokeDasharray={off ? "3 2" : undefined} />
              <g transform={`rotate(${heading(f) + 45}) translate(-6.5,-6.5)`}>
                <Plane size={13} color={color} strokeWidth={2.3} />
              </g>
              {off && <text y={-17} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={color}>{f.origin} · {hhmm(f.eta_local)}</text>}
            </motion.g>
          );
        })}
      </svg>

      <div className="glass-strong absolute bottom-3 right-3 overflow-hidden p-0" style={{ width: IW, borderRadius: 14 }}>
        <div className="flex items-center justify-between px-3 pt-2 text-[10.5px]">
          <span className="font-mono uppercase tracking-[0.08em] text-ink-2">LA basin</span>
          <span className="text-tfr">SoFi TFR 10/30 nm</span>
        </div>
        <svg viewBox={`0 0 ${IW} ${IH}`} className="block w-full">
          <rect width={IW} height={IH} fill="#DCE8F7" />
          <path d={insetLand ?? ""} fill="#FFFFFF" stroke="rgba(15,30,60,0.16)" strokeWidth="0.8" />
          <circle cx={sofi[0]} cy={sofi[1]} r={nmRadius(inset, SOFI, 30)} fill="none" stroke="#C026D3" strokeOpacity="0.5" strokeDasharray="4 3" />
          <circle cx={sofi[0]} cy={sofi[1]} r={nmRadius(inset, SOFI, 10)} fill="rgba(192,38,211,0.08)" stroke="#C026D3" strokeOpacity="0.7" />
          <rect x={sofi[0] - 3.5} y={sofi[1] - 3.5} width="7" height="7" fill="#C026D3" transform={`rotate(45 ${sofi[0]} ${sofi[1]})`} />
          {BASIN.map((a) => {
            const p = inset(a.ll)!;
            const us = a.id === "VNY";
            return (
              <g key={a.id}>
                <circle cx={p[0]} cy={p[1]} r={us ? 4.5 : 2.6} fill={us ? "#2563EB" : "#7A8AA0"} stroke="white" strokeWidth="1.2" />
                <text x={p[0] + a.dx} y={p[1] + a.dy} textAnchor={a.anchor} fontSize="9.5" fontWeight={us ? 700 : 500} fill={us ? "#0B1B33" : "#4A5B73"}>{a.id}</text>
              </g>
            );
          })}
          {near.map((f) => {
            const p = inset([f.lon, f.lat])!;
            return <circle key={f.flight_id} cx={p[0]} cy={p[1]} r="3.4" fill={f.is_international ? "#C026D3" : "#1D4ED8"} stroke="white" strokeWidth="1" />;
          })}
        </svg>
      </div>

      {hover && (
        <div className="glass-strong pointer-events-none absolute right-3 top-3 w-[236px] px-3.5 py-3 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="num font-semibold">{hover.flight_id}</span>
            {hover.is_international && <span className="chip border-tfr/25 bg-tfr/10 text-tfr">Intl · CBP</span>}
          </div>
          <div className="mt-1 text-ink-2">{hover.origin_name} ({hover.origin}) → KVNY</div>
          <div className="mt-2 grid grid-cols-2 gap-y-1">
            <span className="text-ink-2">Aircraft</span><span className="text-right">{SIZE_LABEL[hover.size_class]}</span>
            <span className="text-ink-2">ETA</span><span className="num text-right">{hhmm(hover.eta_local)}</span>
            <span className="text-ink-2">P90 arrival</span><span className="num text-right">{hhmm(hover.eta_p90_local)}</span>
            <span className="text-ink-2">Booking</span><span className="num text-right">{hover.booking_code ?? "—"}</span>
          </div>
        </div>
      )}
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-3 rounded-full border border-white/70 bg-white/75 px-3 py-1 text-[11px] text-ink-2 backdrop-blur">
        <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-runway" /> Domestic</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-tfr" /> International (customs)</span>
        <span>Dashed ring: beyond the map edge · paths interpolated</span>
      </div>
    </div>
  );
}

/** Top-down apron: rows A-D, four columns per row, three stands deep. Depth 1 faces the taxilane. */
export function RampMap({ stands, ground, overflow }: { stands: Stand[]; ground: Ground[]; overflow: number }) {
  const byStand = new Map(ground.filter((g) => g.stand_id).map((g) => [g.stand_id!, g]));
  const rows = [...new Set(stands.map((s) => s.row))];
  const cols = Math.max(...stands.map((s) => s.column ?? 1));
  const CW = 150, CG = 16, SH = 30, SG = 5, BAND = 18;
  const ROWH = BAND + 6 + 3 * (SH + SG) + 10;
  const width = cols * CW + (cols - 1) * CG;
  const [hover, setHover] = useState<Ground | null>(null);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${rows.length * ROWH}`} className="w-full" role="img" aria-label="Ramp stand map">
        {rows.map((r, ri) => {
          const y0 = ri * ROWH;
          return (
            <g key={r}>
              <rect x="0" y={y0} width={width} height={BAND} rx="6" fill="rgba(15,30,60,0.05)" />
              <text x="8" y={y0 + 12.5} fontSize="10" fill="#4A5B73" letterSpacing="0.08em">TAXILANE {r}</text>
              {stands.filter((s) => s.row === r).map((s) => {
                const g = byStand.get(s.stand_id);
                const x = ((s.column ?? 1) - 1) * (CW + CG);
                const y = y0 + BAND + 6 + (s.depth - 1) * (SH + SG);
                const color = g ? SIZE_COLOR[g.size_class] : "";
                return (
                  <g key={s.stand_id} onMouseEnter={() => g && setHover(g)} onMouseLeave={() => setHover(null)}>
                    <rect x={x} y={y} width={CW} height={SH} rx="8" fill={g ? color : "rgba(255,255,255,0.8)"}
                      fillOpacity={g ? 0.24 : 1} stroke={g ? color : "rgba(15,30,60,0.12)"} strokeWidth={g ? 1.4 : 1}
                      strokeDasharray={g ? undefined : "3 3"} />
                    <text x={x + 9} y={y + 19} fontSize="10.5" fill="#0B1B33" fontWeight="600">{s.stand_id}</text>
                    <text x={x + 34} y={y + 19} fontSize="9.5" fill="#7A8AA0">{"\u2264"}{s.max_wingspan_ft} ft</text>
                    {g && (
                      <g transform={`translate(${x + CW - 30},${y + SH / 2 - 9})`}>
                        <Plane size={18} color={g.size_class === "light" ? "#0284C7" : color} strokeWidth={2.2} />
                      </g>
                    )}
                    {g && g.conflicts > 0 && <circle cx={x + CW - 5} cy={y + 5} r="4" fill="#DC2626" stroke="white" strokeWidth="1.2" />}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-2">
        <div className="flex flex-wrap gap-3">
          {(["light", "mid", "super_mid", "large"] as const).map((k) => (
            <span key={k} className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: SIZE_COLOR[k] }} />{SIZE_LABEL[k]}</span>
          ))}
          <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full bg-alert" />Boxed in</span>
        </div>
        <span className={cx("font-medium", overflow > 0 ? "text-alert" : "text-ok")}>
          {overflow > 0 ? `${overflow} aircraft need overflow handling` : "Every aircraft has a stand"}
        </span>
      </div>
      {hover && (
        <div className="glass-strong pointer-events-none absolute right-2 top-2 w-[220px] px-3 py-2.5 text-[12px]">
          <div className="num font-semibold">{hover.stand_id} · {hover.flight_id}</div>
          <div className="text-ink-2">{SIZE_LABEL[hover.size_class]} · {hover.stay_type.replace(/_/g, " ")}</div>
          <div className="mt-1.5 grid grid-cols-2 gap-y-0.5">
            <span className="text-ink-2">Landed</span><span className="num text-right">{hhmm(hover.landed_local)}</span>
            <span className="text-ink-2">Departs</span><span className="num text-right">{dayShort(hover.departs_local)} {hhmm(hover.departs_local)}</span>
          </div>
          {hover.conflicts > 0 && <div className="mt-1.5 text-alert">Leaves before the jet parked in front of it</div>}
        </div>
      )}
    </div>
  );
}

export function PulseDot({ tone = "runway" }: { tone?: "runway" | "alert" | "ok" }) {
  const c = { runway: "bg-runway", alert: "bg-alert", ok: "bg-ok" }[tone];
  return (
    <span className="relative inline-flex h-2 w-2">
      <motion.span className={cx("absolute inline-flex h-full w-full rounded-full opacity-60", c)}
        animate={{ scale: [1, 2.2], opacity: [0.6, 0] }} transition={{ duration: 1.6, repeat: Infinity }} />
      <span className={cx("relative inline-flex h-2 w-2 rounded-full", c)} />
    </span>
  );
}
