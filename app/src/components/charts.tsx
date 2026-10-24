import { motion } from "framer-motion";
import { Fragment, useState } from "react";
import { dayShort, fmt } from "../lib/format";
import type { ForecastDay, OccupancyHour } from "../lib/types";

/** Daily arrivals: ordinary-week baseline, P10-P90 band, P50 line, optional actual dots. */
export function ForecastChart({ days, showActual, eventDate = "2027-02-14" }: { days: ForecastDay[]; showActual?: boolean; eventDate?: string }) {
  const W = 720, H = 268, L = 40, R = 16, T = 22, B = 34;
  const max = Math.max(10, ...days.map((d) => Math.max(d.p90, d.actual ?? 0, d.baseline_p50))) * 1.12;
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / days.length;
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const step = max > 80 ? 20 : 10;
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const band = [...days.map((d, i) => `${x(i)},${y(d.p90)}`), ...days.map((_, i) => `${x(days.length - 1 - i)},${y(days[days.length - 1 - i].p10)}`)].join(" ");
  const line = (k: keyof ForecastDay) => days.map((d, i) => `${x(i)},${y(d[k] as number)}`).join(" ");
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Daily arrivals forecast">
        <defs>
          <linearGradient id="bandFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#2563EB" stopOpacity="0.20" />
            <stop offset="1" stopColor="#2563EB" stopOpacity="0.06" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgba(15,30,60,0.07)" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#4A5B73" className="num">{v}</text>
          </g>
        ))}
        {days.map((d, i) => (
          <text key={d.date} x={x(i)} y={H - 12} textAnchor="middle" fontSize="11.5"
            fill={d.date === eventDate ? "#C026D3" : "#4A5B73"} fontWeight={d.date === eventDate ? 600 : 400}>
            {dayShort(d.date)} {d.date.slice(8)}
          </text>
        ))}
        <motion.polygon points={band} fill="url(#bandFill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} />
        <polyline points={line("baseline_p50")} fill="none" stroke="#7A8AA0" strokeWidth="1.6" strokeDasharray="4 4" />
        <motion.polyline key={line("p50")} points={line("p50")} fill="none" stroke="#2563EB" strokeWidth="2.4" strokeLinejoin="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.7, ease: "easeOut" }} />
        {days.map((d, i) => (
          <g key={d.date}>
            <circle cx={x(i)} cy={y(d.p50)} r={hover === i ? 5.5 : 4} fill="white" stroke="#2563EB" strokeWidth="2" />
            {showActual && d.actual !== undefined && (
              <rect x={x(i) - 4.5} y={y(d.actual) - 4.5} width="9" height="9" rx="2" fill="#0B1B33" transform={`rotate(45 ${x(i)} ${y(d.actual)})`} />
            )}
            <rect x={x(i) - (W - L - R) / days.length / 2} y={T} width={(W - L - R) / days.length} height={H - T - B}
              fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div className="glass-strong pointer-events-none absolute top-2 z-10 w-[176px] px-3 py-2 text-[12px]"
          style={{ left: `calc(${(x(hover) / W) * 100}% - 88px)` }}>
          <div className="mb-1 font-semibold">{dayShort(days[hover].date)} {days[hover].date.slice(5)}</div>
          <Row k="Forecast P50" v={days[hover].p50} />
          <Row k="P10 – P90" v={`${days[hover].p10} – ${days[hover].p90}`} />
          <Row k="Ordinary week" v={days[hover].baseline_p50} />
          {showActual && days[hover].actual !== undefined && <Row k="Actual" v={days[hover].actual!} />}
        </div>
      )}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string | number }) => (
  <div className="flex justify-between gap-2 text-ink-2"><span>{k}</span><span className="num font-medium text-ink">{v}</span></div>
);

export function occTone(ratio: number) {
  if (ratio > 1) return "#DC2626";
  if (ratio > 0.9) return "#F97316";
  if (ratio > 0.7) return "#F59E0B";
  if (ratio > 0.4) return "#60A5FA";
  return "#BFDBFE";
}

const hourOf = (iso: string) => Number(iso.slice(11, 13));
const ampm = (h: number) => `${h % 12 || 12}${h % 24 < 12 ? "am" : "pm"}`;
const FULL = "#DC2626", TIGHT = "#F59E0B", ROOM = "#60A5FA";
const cellTone = (r: number) => (r > 1 ? FULL : r >= 0.9 ? TIGHT : ROOM);

/** Contiguous over-capacity stretches in one day, as "10am–6pm" labels. */
function fullStretches(day: OccupancyHour[], capacity: number): string[] {
  const out: string[] = [];
  let start: number | null = null;
  day.forEach((h, i) => {
    const over = h.p50 > capacity;
    if (over && start === null) start = hourOf(h.t_local);
    if (start !== null && (!over || i === day.length - 1)) {
      const end = over ? hourOf(h.t_local) + 1 : hourOf(h.t_local);
      out.push(`${ampm(start)}–${ampm(end)}`);
      start = null;
    }
  });
  return out;
}

/** One row per day: a 24-hour strip in three plain colors, and a sentence saying when the ramp is full. */
export function RampDays({ hours, capacity }: { hours: OccupancyHour[]; capacity: number }) {
  const rows: OccupancyHour[][] = [];
  for (let i = 0; i < hours.length; i += 24) rows.push(hours.slice(i, i + 24));
  const [tip, setTip] = useState<OccupancyHour | null>(null);
  return (
    <div>
      <div className="grid items-center gap-x-4 gap-y-2" style={{ gridTemplateColumns: "64px minmax(0, 1fr) minmax(170px, 0.55fr)" }}>
        <div />
        <div className="relative h-4 text-[10.5px] text-ink-2">
          {[0, 6, 12, 18].map((h) => (
            <span key={h} className="absolute -translate-x-1/2 first:translate-x-0" style={{ left: `${(h / 24) * 100}%` }}>
              {h === 12 ? "noon" : ampm(h)}
            </span>
          ))}
        </div>
        <div />
        {rows.map((row) => {
          const day = row[0].t_local.slice(0, 10);
          const game = day === "2027-02-14";
          const peak = Math.max(...row.map((h) => h.p50));
          const peakPct = Math.round((peak / capacity) * 100);
          const stretches = fullStretches(row, capacity);
          const fullHours = row.filter((h) => h.p50 > capacity).length;
          return (
            <Fragment key={day}>
              <div className={"text-[12px] " + (game ? "font-semibold text-tfr" : "text-ink-2")}>
                {dayShort(day)} {day.slice(8, 10)}{game && <div className="text-[10px] font-medium">Game day</div>}
              </div>
              <div className="flex h-[22px] gap-[2px]">
                {row.map((h) => {
                  const r = h.p50 / capacity;
                  return (
                    <div key={h.t_local} onMouseEnter={() => setTip(h)} onMouseLeave={() => setTip(null)}
                      className="flex-1 rounded-[4px] transition-transform hover:scale-y-125"
                      style={{ background: cellTone(r), opacity: r >= 0.9 ? 1 : 0.18 + 0.6 * r }} />
                  );
                })}
              </div>
              <div className="text-[12px] leading-snug">
                {stretches.length ? (
                  <><span className="font-semibold text-alert">Full {stretches.slice(0, 2).join(", ")}</span>
                    <span className="text-ink-2"> · {fullHours} h, peaks at {peakPct}%</span></>
                ) : (
                  <><span className="font-semibold text-ok">Fits all day</span><span className="text-ink-2"> · peaks at {peakPct}%</span></>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className="mt-4 flex min-h-[20px] flex-wrap items-center justify-between gap-3 text-[11.5px] text-ink-2">
        <div className="flex flex-wrap items-center gap-3">
          {[["Room to spare (darker = busier)", ROOM], ["Nearly full (90%+)", TIGHT], ["Over capacity", FULL]].map(([l, c]) => (
            <span key={l} className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />{l}</span>
          ))}
        </div>
        {tip ? (
          <span className="text-ink">
            <span className="font-medium">{dayShort(tip.t_local)} {ampm(hourOf(tip.t_local))}</span> · needs <span className="num">{fmt(tip.p50)}</span> of <span className="num">{capacity}</span> spaces
            ({Math.round((tip.p50 / capacity) * 100)}%) · <span className="num">{Math.round(tip.p_over_capacity * 100)}%</span> chance it overflows
          </span>
        ) : <span>Hover an hour for details</span>}
      </div>
      <p className="mt-2 text-[11px] text-ink-2">
        Each square is one hour, showing the typical result of {fmt(120)} simulated weeks. One space fits one large jet; smaller jets take less.
      </p>
    </div>
  );
}


export function Sparkline({ values, cap, height = 36 }: { values: number[]; cap?: number; height?: number }) {
  const W = 200, H = height;
  if (!values.length) return null;
  const max = Math.max(...values, cap ?? 0) * 1.08 || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - (v / max) * H}`);
  const last = pts[pts.length - 1].split(",").map(Number);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full" preserveAspectRatio="none" style={{ height }}>
      {cap && <line x1="0" x2={W} y1={H - (cap / max) * H} y2={H - (cap / max) * H} stroke="#DC2626" strokeDasharray="3 3" strokeWidth="1" />}
      <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill="rgba(37,99,235,0.10)" />
      <polyline points={pts.join(" ")} fill="none" stroke="#2563EB" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill="#2563EB" />
    </svg>
  );
}

/** Horizontal comparison bar used inside strategy cards. */
export function MiniBar({ value, max, tone = "#2563EB" }: { value: number; max: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]">
      <motion.div className="h-full rounded-full" style={{ background: tone }}
        initial={{ width: 0 }} animate={{ width: `${max ? Math.max(3, (value / max) * 100) : 0}%` }} transition={{ duration: 0.6, ease: "easeOut" }} />
    </div>
  );
}
