import { motion } from "framer-motion";
import { BarChart3, Box, CalendarCheck, Database, FlaskConical, Medal, Pause, Play, Plane, Radar, Settings2, ShieldCheck, Sparkles, SquareParking } from "lucide-react";
import type { ReactNode } from "react";
import { cx, dayLabel, hhmm, sourceOf } from "../lib/format";
import { useApp, type Screen } from "../lib/store";
import { Chip, Segmented } from "./ui";

const NAV: { id: Screen; label: string; icon: ReactNode; hint: string }[] = [
  { id: "setup", label: "Event setup", icon: <Settings2 size={17} />, hint: "Capacity, staff, priority rules" },
  { id: "bookings", label: "Booking desk", icon: <CalendarCheck size={17} />, hint: "Instant answers, one inbox" },
  { id: "parking", label: "Parking control", icon: <SquareParking size={17} />, hint: "Stands, tows, reservations" },
  { id: "world", label: "Airport 3D", icon: <Box size={17} />, hint: "Live 3D world of the airfield" },
  { id: "plan", label: "Plan board", icon: <BarChart3 size={17} />, hint: "Forecast and strategy options" },
  { id: "live", label: "Live ops", icon: <Radar size={17} />, hint: "Replay, ramp, priority queue" },
  { id: "whatif", label: "What-if", icon: <FlaskConical size={17} />, hint: "Disruptions and re-plans" },
  { id: "after", label: "After-action", icon: <ShieldCheck size={17} />, hint: "Accuracy, impact, audit" },
  { id: "la28", label: "LA28 stretch", icon: <Medal size={17} />, hint: "Olympics opening week" },
];

export function Sidebar() {
  const { screen, go, meta } = useApp();
  return (
    <aside className="glass sticky top-4 m-4 mr-0 flex h-[calc(100vh-2rem)] w-[236px] shrink-0 flex-col p-3">
      <div className="flex items-center gap-2.5 px-2 pb-5 pt-2">
        <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-runway text-white shadow-[0_6px_18px_rgba(37,99,235,0.35)]">
          <Plane size={18} className="-rotate-45" />
        </div>
        <div>
          <div className="text-[15px] font-semibold tracking-[0.04em]">RAMPCAST</div>
          <div className="text-[11px] text-ink-2">Event ops co-pilot</div>
        </div>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map((n) => (
          <button key={n.id} onClick={() => go(n.id)}
            className={cx("relative flex items-start gap-3 rounded-control px-3 py-2.5 text-left transition-colors",
              screen === n.id ? "text-ink" : "text-ink-2 hover:bg-white/50 hover:text-ink")}>
            {screen === n.id && (
              <motion.span layoutId="nav-active" className="absolute inset-0 rounded-control border border-white/80 bg-white/80 shadow-[0_6px_20px_rgba(20,40,80,0.08)]"
                transition={{ type: "spring", stiffness: 500, damping: 40 }} />
            )}
            <span className={cx("relative mt-0.5", screen === n.id && "text-runway")}>{n.icon}</span>
            <span className="relative">
              <span className="block text-[13.5px] font-medium">{n.label}</span>
              <span className="block text-[11px] text-ink-2">{n.hint}</span>
            </span>
          </button>
        ))}
      </nav>
      <div className="mt-auto space-y-2 px-1 pb-1">
        <div className="rounded-control border border-hairline bg-white/50 p-3">
          <div className="label mb-1.5">Data</div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium">
            <Database size={13} className={meta?.live_source === "sample" ? "text-watch" : "text-ok"} />
            {sourceOf(meta?.live_source).label}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[12px] font-medium">
            <Sparkles size={13} className="text-runway" />
            {meta?.claude_enabled ? "Claude wording on" : "Built-in briefings · offline"}
          </div>
        </div>
        <p className="px-1 text-[10.5px] leading-snug text-ink-2">
          AI suggests. People decide. Never sequences landings, picks diversions, or ranks people by who they are.
        </p>
      </div>
    </aside>
  );
}

export function TopBar({ title, subtitle, children, event }: { title: string; subtitle: string; children?: ReactNode; event?: ReactNode }) {
  const { scenario, setScenario, meta } = useApp();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 pb-5">
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <Chip tone="tfr">{event ?? "Super Bowl LXI · Sun Feb 14 2027"}</Chip>
          <Chip>KVNY · {meta?.settings.fbo_name ?? "Sepulveda Jet Center (fictional)"}</Chip>
        </div>
        <h1 className="text-[28px] font-semibold tracking-[-0.025em]">{title}</h1>
        <p className="mt-0.5 text-[13.5px] text-ink-2">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        {children}
        <div className="flex items-center gap-2">
          <span className="label">Demand</span>
          <Segmented value={scenario} onChange={setScenario}
            options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} />
        </div>
      </div>
    </div>
  );
}

export function ReplayBar() {
  const { tMs, setT, playing, setPlaying, speed, setSpeed, windowMs, meta } = useApp();
  const span = windowMs[1] - windowMs[0];
  const days = meta?.window ?? [];
  const gameStart = Date.parse("2027-02-14T15:30:00-08:00");
  const tfr = [Date.parse("2027-02-14T14:30:00-08:00"), Date.parse("2027-02-14T20:30:00-08:00")];
  const pct = (ms: number) => ((ms - windowMs[0]) / span) * 100;
  const iso = new Date(tMs).toISOString();
  return (
    <div className="glass flex items-center gap-4 px-4 py-3">
      <button onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause replay" : "Play replay"}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-runway text-white shadow-[0_6px_18px_rgba(37,99,235,0.35)]">
        {playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
      </button>
      <div className="w-[118px] shrink-0">
        <div className="num text-[22px] font-semibold leading-none">{hhmm(iso)}</div>
        <div className="mt-1 text-[11.5px] text-ink-2">{dayLabel(iso)} · PST</div>
      </div>
      <div className="relative min-w-0 flex-1 pt-1">
        <div className="relative h-8">
          <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-ink/[0.06]" />
          <div className="absolute top-3 h-2 rounded-full bg-tfr/25" style={{ left: `${pct(tfr[0])}%`, width: `${pct(tfr[1]) - pct(tfr[0])}%` }}
            title="Game-day TFR window (2022 precedent)" />
          <div className="absolute top-3 h-2 rounded-full bg-runway/70" style={{ width: `${pct(tMs)}%` }} />
          <div className="absolute top-0.5 h-7 w-[2px] bg-tfr" style={{ left: `${pct(gameStart)}%` }} title="Kickoff" />
          <input type="range" min={windowMs[0]} max={windowMs[1]} step={5 * 60 * 1000} value={tMs}
            onChange={(e) => setT(Number(e.target.value))} aria-label="Replay time"
            className="absolute inset-0 h-8 w-full cursor-pointer opacity-0" />
          <div className="pointer-events-none absolute top-1 h-6 w-6 -translate-x-1/2 rounded-full border-2 border-white bg-runway shadow-[0_4px_12px_rgba(37,99,235,0.45)]"
            style={{ left: `${pct(tMs)}%` }} />
        </div>
        <div className="mt-0.5 flex justify-between text-[11px] text-ink-2">
          {days.map((d) => (
            <span key={d} className={cx("num", d === "2027-02-14" && "font-semibold text-tfr")}>{dayLabel(d)}</span>
          ))}
        </div>
      </div>
      <Segmented size="sm" value={String(speed)} onChange={(v) => setSpeed(Number(v))}
        options={[{ value: "60", label: "60×" }, { value: "600", label: "600×" }, { value: "3600", label: "3600×" }]} />
    </div>
  );
}
