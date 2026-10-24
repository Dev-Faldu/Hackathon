import { motion } from "framer-motion";
import { Car, Fuel, Truck, Warehouse } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { cx, dayShort, hhmm, SIZE_COLOR, SIZE_LABEL } from "../lib/format";
import type { GanttBar, Occupant, ParkingPosition } from "../lib/types";

/** Top view of a business jet, nose to the right, inside a 100 x 100 box. */
const JET = [
  "M96,50 C96,47 93,45.6 88,45.6 L22,45.6 L9,44 L5,47 L5,53 L9,56 L22,54.4 L88,54.4 C93,54.4 96,53 96,50 Z",
  "M60,45.6 L43,5 L35,5 L42,45.6 Z",
  "M60,54.4 L43,95 L35,95 L42,54.4 Z",
  "M19,45.6 L10,31 L6,31 L10,45.6 Z",
  "M19,54.4 L10,69 L6,69 L10,54.4 Z",
];

export function Jet({ x, y, spanFt, color, pxPerFt = 0.31, opacity = 1 }: {
  x: number; y: number; spanFt: number; color: string; pxPerFt?: number; opacity?: number;
}) {
  const s = (spanFt * pxPerFt) / 100;
  return (
    <g transform={`translate(${x},${y}) scale(${s})`} opacity={opacity}>
      {JET.map((d, i) => <path key={i} d={d} fill={color} />)}
      <rect x="20" y="38" width="9" height="5" rx="2.5" fill={color} />
      <rect x="20" y="57" width="9" height="5" rx="2.5" fill={color} />
    </g>
  );
}

const W = 1000, H = 770;
const GX = 24, COLW = 168, COLGAP = 10, BAND = 16, SH = 32, SG = 3, ROW0 = 92;
const ROWH = BAND + 4 + 3 * (SH + SG) + 8;
const RIGHT = 744;

export interface ApronProps {
  positions: ParkingPosition[];
  occupants: Occupant[];
  towSoon: Set<string>;
  nowMs: number;
  selected: string | null;
  onSelect: (flightId: string | null, positionId?: string) => void;
  tempZone: boolean;
  overflowNow: number;
}

function standRect(p: ParkingPosition): { x: number; y: number; w: number; h: number } {
  if (p.kind === "stand") {
    const ri = "ABCD".indexOf(p.row);
    return { x: GX + (p.column - 1) * (COLW + COLGAP), y: ROW0 + ri * ROWH + BAND + 4 + (p.depth - 1) * (SH + SG), w: COLW, h: SH };
  }
  if (p.kind === "hot") return { x: GX + (p.column - 1) * 178, y: 634, w: 168, h: 36 };
  const i = p.column - 1;
  return { x: RIGHT + 8 + (i % 2) * 118, y: 240 + Math.floor(i / 2) * 60, w: 110, h: 54 };
}

/** Schematic FBO apron at Van Nuys: 48 stacked stands, drop-and-go hot spots, temporary taxiway zone. Not to scale. */
export function ApronMap({ positions, occupants, towSoon, nowMs, selected, onSelect, tempZone, overflowNow }: ApronProps) {
  const byPos = useMemo(() => new Map(occupants.filter((o) => o.position).map((o) => [o.position!, o])), [occupants]);
  const [hover, setHover] = useState<{ o: Occupant; x: number; y: number } | null>(null);
  const temp = positions.filter((p) => p.kind === "temp");
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" role="img" aria-label="FBO apron parking map">
        <defs>
          <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(15,30,60,0.08)" strokeWidth="3" />
          </pattern>
        </defs>
        {/* Runway and parallel taxiway */}
        <rect x="12" y="10" width={W - 24} height="30" rx="6" fill="#2B3646" />
        <line x1="70" x2={W / 2 - 120} y1="25" y2="25" stroke="white" strokeWidth="2" strokeDasharray="18 14" opacity="0.85" />
        <line x1={W / 2 + 120} x2={W - 70} y1="25" y2="25" stroke="white" strokeWidth="2" strokeDasharray="18 14" opacity="0.85" />
        <text x="26" y="30" fontSize="12" fontWeight="700" fill="white">16R</text>
        <text x={W - 26} y="30" fontSize="12" fontWeight="700" fill="white" textAnchor="end">34L</text>
        <text x={W / 2} y="31" fontSize="10" fill="#CBD5E1" textAnchor="middle" letterSpacing="0.12em">RUNWAY 16R/34L · 8,000 FT</text>
        <rect x="12" y="50" width={W - 24} height="22" rx="5" fill="rgba(234,179,8,0.10)" />
        <line x1="150" x2={W - 190} y1="61" y2="61" stroke="#EAB308" strokeWidth="1.6" strokeDasharray="10 6" />
        <text x="28" y="65" fontSize="9.5" fill="#92400E" letterSpacing="0.1em">PARALLEL TAXIWAY</text>
        <text x={W - 28} y="65" fontSize="9.5" fill="#92400E" textAnchor="end" letterSpacing="0.06em">SCHEMATIC · NOT TO SCALE</text>

        {/* Apron rows A-D */}
        {"ABCD".split("").map((r, ri) => {
          const y0 = ROW0 + ri * ROWH;
          return (
            <g key={r}>
              <rect x={GX - 6} y={y0} width={4 * COLW + 3 * COLGAP + 12} height={BAND} rx="5" fill="rgba(15,30,60,0.06)" />
              <line x1={GX} x2={GX + 4 * COLW + 3 * COLGAP} y1={y0 + BAND / 2} y2={y0 + BAND / 2} stroke="#EAB308" strokeWidth="1.2" strokeDasharray="6 5" />
              <text x={GX + 2} y={y0 + 11.5} fontSize="9.5" fill="#4A5B73" letterSpacing="0.1em" style={{ paintOrder: "stroke" }} stroke="#F4F7FB" strokeWidth="3">
                TAXILANE {r} · FRONT ROW FACES THE LANE
              </text>
            </g>
          );
        })}

        {/* Hangar, temporary zone, fuel farm */}
        <g>
          <rect x={RIGHT} y={ROW0} width={W - RIGHT - 12} height="118" rx="12" fill="url(#hatch)" stroke="rgba(15,30,60,0.14)" />
          <g transform={`translate(${RIGHT + 12},${ROW0 + 12})`}><Warehouse size={18} color="#4A5B73" /></g>
          <text x={RIGHT + 40} y={ROW0 + 28} fontSize="12" fontWeight="600" fill="#0B1B33">Hangar</text>
          <text x={RIGHT + 14} y={ROW0 + 50} fontSize="10.5" fill="#4A5B73">Maintenance and</text>
          <text x={RIGHT + 14} y={ROW0 + 64} fontSize="10.5" fill="#4A5B73">based aircraft · not for</text>
          <text x={RIGHT + 14} y={ROW0 + 78} fontSize="10.5" fill="#4A5B73">transient parking</text>
        </g>
        <g>
          <rect x={RIGHT} y="222" width={W - RIGHT - 12} height="392" rx="12" fill={tempZone ? "rgba(192,38,211,0.05)" : "rgba(15,30,60,0.03)"}
            stroke={tempZone ? "#C026D3" : "rgba(15,30,60,0.14)"} strokeDasharray="6 4" />
          <text x={RIGHT + 12} y="236" fontSize="9.5" fill={tempZone ? "#A21CAF" : "#7A8AA0"} letterSpacing="0.08em">
            {tempZone ? "TEMPORARY TAXIWAY STANDS · OPEN" : "TAXIWAY · TEMP ZONE CLOSED"}
          </text>
          {!tempZone && (
            <text x={RIGHT + 12} y="420" fontSize="11" fill="#7A8AA0">
              <tspan x={RIGHT + 12}>Opens 12 stands if</tspan>
              <tspan x={RIGHT + 12} dy="15">strategy C is approved</tspan>
              <tspan x={RIGHT + 12} dy="15">(airport ops + FAA)</tspan>
            </text>
          )}
        </g>
        <g>
          <rect x={RIGHT} y="628" width={W - RIGHT - 12} height="128" rx="12" fill="rgba(15,30,60,0.03)" stroke="rgba(15,30,60,0.14)" />
          <g transform={`translate(${RIGHT + 12},640)`}><Fuel size={18} color="#4A5B73" /></g>
          <text x={RIGHT + 40} y="656" fontSize="12" fontWeight="600" fill="#0B1B33">Fuel farm</text>
          <text x={RIGHT + 14} y="678" fontSize="10.5" fill="#4A5B73">Jet A · trucks stage here</text>
          <g transform={`translate(${RIGHT + 12},690)`}><Truck size={18} color="#4A5B73" /></g>
          <text x={RIGHT + 40} y="706" fontSize="10.5" fill="#4A5B73">Tugs and GPUs</text>
        </g>

        {/* Terminal, hot spots, car staging */}
        <rect x={GX - 6} y="620" width={4 * 178 - 10 + 12} height="62" rx="10" fill="rgba(37,99,235,0.04)" stroke="rgba(37,99,235,0.18)" strokeDasharray="5 4" />
        <text x={GX + 2} y="631" fontSize="9.5" fill="#1D4ED8" letterSpacing="0.1em">DROP-AND-GO HOT SPOTS · MAX 3 H</text>
        <rect x={GX - 6} y="690" width="440" height="66" rx="12" fill="white" stroke="rgba(15,30,60,0.14)" />
        <text x={GX + 12} y="716" fontSize="13" fontWeight="600" fill="#0B1B33">FBO terminal · Sepulveda Jet Center</text>
        <text x={GX + 12} y="736" fontSize="10.5" fill="#4A5B73">Passenger lounge · crew rest · customer service (fictional FBO)</text>
        <rect x="462" y="690" width="268" height="66" rx="12" fill="rgba(15,30,60,0.03)" stroke="rgba(15,30,60,0.14)" />
        <g transform="translate(474,700)"><Car size={18} color="#4A5B73" /></g>
        <text x="502" y="716" fontSize="12" fontWeight="600" fill="#0B1B33">VIP car staging</text>
        <text x="476" y="736" fontSize="10.5" fill="#4A5B73">Planeside access with FBO escort</text>

        {/* Every parking position */}
        {positions.map((p) => {
          const r = standRect(p);
          const o = byPos.get(p.id);
          const color = o ? SIZE_COLOR[o.size_class] : "";
          const depMs = o ? Date.parse(o.depart_local) : 0;
          const leavingSoon = o && depMs - nowMs <= 60 * 60 * 1000 && depMs > nowMs;
          const tow = o && towSoon.has(o.flight_id);
          const isSel = o && selected === o.flight_id;
          const inactive = p.kind === "temp" && !tempZone;
          const planeSpan = o ? o.wingspan_ft : 0;
          const big = false;
          return (
            <g key={p.id} className={cx(!inactive && "cursor-pointer")} opacity={inactive ? 0.35 : 1}
              onClick={() => !inactive && onSelect(o ? o.flight_id : null, p.id)}
              onMouseEnter={() => o && setHover({ o, x: r.x + r.w / 2, y: r.y })} onMouseLeave={() => setHover(null)}>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="7"
                fill={o ? color : "rgba(255,255,255,0.85)"} fillOpacity={o ? 0.16 : 1}
                stroke={isSel ? "#2563EB" : tow ? "#D97706" : o ? color : "rgba(15,30,60,0.14)"}
                strokeWidth={isSel ? 2.6 : tow ? 1.8 : o ? 1.3 : 1} strokeDasharray={o ? (tow ? "5 3" : undefined) : "3 3"} />
              {leavingSoon && (
                <motion.rect x={r.x - 2} y={r.y - 2} width={r.w + 4} height={r.h + 4} rx="9" fill="none" stroke="#16A34A" strokeWidth="1.6"
                  animate={{ opacity: [0.9, 0.15, 0.9] }} transition={{ duration: 1.6, repeat: Infinity }} />
              )}
              <text x={r.x + r.w - 6} y={r.y + 11} fontSize="9.5" fontWeight="700" fill="#4A5B73" textAnchor="end">{p.id}</text>
              {!o && <text x={r.x + 8} y={r.y + r.h / 2 + 3.5} fontSize="9.5" fill="#94A3B8">≤{p.max_wingspan_ft} ft · open</text>}
              {o && (
                <Fragment>
                  <Jet x={r.x + 5} y={r.y + (r.h - planeSpan * (big ? 0.42 : 0.29)) / 2} spanFt={planeSpan} pxPerFt={big ? 0.42 : 0.29}
                    color={o.size_class === "light" ? "#0EA5E9" : color} />
                  <text x={r.x + (big ? 52 : 40)} y={r.y + (big ? 22 : 14)} fontSize="10.5" fontWeight="600" fill="#0B1B33" className="num">{o.flight_id}</text>
                  <text x={r.x + (big ? 52 : 40)} y={r.y + (big ? 38 : 26)} fontSize="9.5" fill="#4A5B73">
                    out {dayShort(o.depart_local)} {hhmm(o.depart_local)}
                  </text>
                  {tow && <text x={r.x + r.w - 6} y={r.y + r.h - 5} fontSize="9" fontWeight="700" fill="#B45309" textAnchor="end">TOW</text>}
                </Fragment>
              )}
            </g>
          );
        })}
        {temp.length === 0 && Array.from({ length: 12 }, (_, i) => {
          const r = standRect({ id: `T${i + 1}`, kind: "temp", row: "T", column: i + 1, depth: 1, max_wingspan_ft: 100 });
          return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx="7" fill="none" stroke="rgba(15,30,60,0.10)" strokeDasharray="3 3" opacity="0.6" />;
        })}
        {overflowNow > 0 && (
          <g>
            <rect x={GX + 4 * COLW + 3 * COLGAP - 214} y={ROW0 - 22} width="214" height="18" rx="9" fill="rgba(220,38,38,0.1)" stroke="rgba(220,38,38,0.35)" />
            <text x={GX + 4 * COLW + 3 * COLGAP - 107} y={ROW0 - 9.5} fontSize="10.5" fontWeight="600" fill="#DC2626" textAnchor="middle">
              {overflowNow} aircraft without a position now
            </text>
          </g>
        )}
      </svg>
      {hover && (
        <div className="glass-strong pointer-events-none absolute z-10 w-[220px] px-3 py-2.5 text-[12px]"
          style={{ left: `calc(${(hover.x / W) * 100}% - 110px)`, top: `calc(${(hover.y / H) * 100}% - 112px)` }}>
          <div className="num font-semibold">{hover.o.flight_id} · {hover.o.booking_code ?? "—"}</div>
          <div className="text-ink-2">{SIZE_LABEL[hover.o.size_class]} · {hover.o.wingspan_ft} ft span · from {hover.o.origin}</div>
          <div className="mt-1 grid grid-cols-2 gap-y-0.5">
            <span className="text-ink-2">In</span><span className="num text-right">{dayShort(hover.o.arrive_local)} {hhmm(hover.o.arrive_local)}</span>
            <span className="text-ink-2">Out</span><span className="num text-right">{dayShort(hover.o.depart_local)} {hhmm(hover.o.depart_local)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Stand allocation chart: one row per position across the week, a bar per aircraft stay. */
export function StandGantt({ rows, windowDays, nowMs, selected, onSelect, tempZone }: {
  rows: { position: string; kind: string; bars: GanttBar[] }[]; windowDays: string[]; nowMs: number;
  selected: string | null; onSelect: (flightId: string) => void; tempZone: boolean;
}) {
  const L = 62, R = 10, RH = 13, GW = 1200;
  const t0 = Date.parse(`${windowDays[0]}T00:00:00-08:00`), t1 = Date.parse(`${windowDays[windowDays.length - 1]}T23:59:59-08:00`);
  const x = (ms: number) => L + ((Math.min(t1, Math.max(t0, ms)) - t0) / (t1 - t0)) * (GW - L - R);
  const shown = rows.filter((r) => r.kind !== "temp" || tempZone);
  const H = 26 + shown.length * RH;
  let lastGroup = "";
  return (
    <svg viewBox={`0 0 ${GW} ${H}`} className="w-full" style={{ minWidth: 900 }} role="img" aria-label="Stand allocation chart">
      {windowDays.map((d, i) => {
        const ms = Date.parse(`${d}T00:00:00-08:00`);
        return (
          <g key={d}>
            <rect x={x(ms)} y={20} width={(GW - L - R) / windowDays.length} height={H - 20} fill={i % 2 ? "rgba(15,30,60,0.025)" : "transparent"} />
            <text x={x(ms) + 6} y={13} fontSize="11" fontWeight={d === "2027-02-14" ? 700 : 500} fill={d === "2027-02-14" ? "#C026D3" : "#4A5B73"}>
              {dayShort(d)} {d.slice(8)}
            </text>
          </g>
        );
      })}
      {shown.map((r, i) => {
        const y = 24 + i * RH;
        const group = r.kind === "stand" ? r.position[0] : r.kind;
        const newGroup = group !== lastGroup;
        lastGroup = group;
        return (
          <g key={r.position}>
            {newGroup && i > 0 && <line x1={0} x2={GW} y1={y - 1} y2={y - 1} stroke="rgba(15,30,60,0.12)" />}
            <text x={6} y={y + 9.5} fontSize="9.5" fontWeight={r.kind === "overflow" ? 700 : 500}
              fill={r.kind === "overflow" ? "#DC2626" : r.kind === "hot" ? "#1D4ED8" : r.kind === "temp" ? "#A21CAF" : "#4A5B73"} className="num">
              {r.position === "OVERFLOW" ? "Overflow" : r.position}
            </text>
            {r.bars.map((b) => {
              const bx = x(Date.parse(b.start)), bw = Math.max(2, x(Date.parse(b.end)) - bx);
              const sel = selected === b.flight_id;
              return (
                <rect key={b.flight_id} x={bx} y={y + 1.5} width={bw} height={RH - 3} rx="3"
                  fill={SIZE_COLOR[b.size_class]} fillOpacity={r.kind === "overflow" ? 0.35 : sel ? 1 : 0.7}
                  stroke={sel ? "#0B1B33" : b.tow_involved ? "#D97706" : "none"} strokeWidth={sel ? 1.6 : 1.2}
                  className="cursor-pointer" onClick={() => onSelect(b.flight_id)}>
                  <title>{`${b.flight_id} · ${b.size_class} · ${b.start.slice(5, 16)} → ${b.end.slice(5, 16)}${b.tow_involved ? " · tow involved" : ""}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
      <line x1={x(nowMs)} x2={x(nowMs)} y1={18} y2={H} stroke="#2563EB" strokeWidth="1.6" />
      <circle cx={x(nowMs)} cy={18} r="3.5" fill="#2563EB" />
    </svg>
  );
}
