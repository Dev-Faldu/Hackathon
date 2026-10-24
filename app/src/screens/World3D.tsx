import { Box, Camera, Crosshair, Eye, EyeOff, Loader2, Moon, Pause, Play, PlaneLanding, Sparkles, SquareParking, Sun, Sunset, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Chip } from "../components/ui";
import { api, useApi } from "../lib/api";
import { cx, dayLabel, dayShort, hhmm, SIZE_COLOR, SIZE_LABEL } from "../lib/format";
import { useApp } from "../lib/store";
import { buildPlans, type Phase, poseAt, sun } from "../three/layout";
import { CAMERAS, type CameraMode, TFR_WINDOW, trafficStats } from "../three/state";

const World = lazy(() => import("../three/World"));

const PHASE_LABEL: Record<Phase, string> = {
  approach: "On final approach", rollout: "Landing roll", taxi_in: "Taxiing to stand", parked: "Parked", tow: "Being towed",
  pushback: "Pushback", taxi_out: "Taxiing to runway", lineup: "Lining up", takeoff: "Take-off roll", climb: "Climbing out",
};

export default function World3D() {
  const { tMs, setT, playing, setPlaying, speed, setSpeed, windowMs, go } = useApp();
  const [temp, setTemp] = useState(false);
  const [labels, setLabels] = useState(true);
  const [camera, setCamera] = useState<CameraMode>("overview");
  const [nonce, setNonce] = useState(0);
  const [follow, setFollow] = useState(false);
  const [cinematic, setCinematic] = useState(false);
  const [quality, setQuality] = useState<"high" | "fast">("high");
  const [selected, setSelected] = useState<string | null>(null);
  const plan = useApi(() => api.parkingPlan("optimized", temp), [temp]);
  const plans = useMemo(() => (plan.data ? buildPlans(plan.data) : []), [plan.data]);
  const [stats, setStats] = useState({ ...trafficStats });
  useEffect(() => { const id = setInterval(() => setStats({ ...trafficStats }), 400); return () => clearInterval(id); }, []);

  const sel = plans.find((p) => p.id === selected) ?? null;
  const selPose = sel ? poseAt(sel, tMs) : null;
  const { el } = sun(tMs);
  const light = el > 8 ? { label: "Daylight", icon: <Sun size={13} /> } : el > -4 ? { label: "Golden hour", icon: <Sunset size={13} /> } : { label: "Night", icon: <Moon size={13} /> };
  const pct = ((tMs - windowMs[0]) / (windowMs[1] - windowMs[0])) * 100;
  const iso = new Date(tMs).toISOString();
  const tfr = tMs >= TFR_WINDOW[0] && tMs <= TFR_WINDOW[1];
  const gameDay = new Date(tMs).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) === "2027-02-14";

  const followNextArrival = () => {
    const next = plans.filter((p) => p.L - 3 * 60_000 > tMs).sort((a, b) => a.L - b.L)[0];
    if (!next) return;
    setT(next.L - 3.2 * 60_000);
    setSelected(next.id);
    setFollow(true);
    setSpeed(10);
    setPlaying(true);
  };
  const pickCamera = (m: CameraMode) => { setFollow(false); setCamera(m); setNonce((n) => n + 1); };

  return (
    <div className="relative h-[calc(100vh-3rem)] min-h-[620px] overflow-hidden rounded-[24px] border border-white/70 bg-[#cfd9e6] shadow-glass">
      {plans.length > 0 && plan.data ? (
        <Suspense fallback={<Loading />}>
          <World plans={plans} positions={plan.data.positions} tempZone={temp} labels={labels} selected={selected}
            onSelect={(id) => { setSelected(id); if (!id) setFollow(false); }} camera={camera} cameraNonce={nonce}
            follow={follow} cinematic={cinematic} tMs={tMs} playing={playing} speed={speed} quality={quality} tfr={tfr} />
        </Suspense>
      ) : <Loading />}

      {/* Top-left: clock and live counts */}
      <div className="glass-strong pointer-events-auto absolute z-40 left-4 top-4 w-[300px] px-4 py-3.5">
        <div className="label flex items-center gap-1.5"><Box size={12} className="text-runway" /> Airport 3D · KVNY</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="num text-[30px] font-semibold leading-none">{hhmm(iso)}</span>
          <span className="text-[12.5px] text-ink-2">{dayLabel(iso)} · PST</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip tone="runway">{light.icon} {light.label}</Chip>
          {gameDay && <Chip tone="tfr">{tfr ? "Game day · TFR active" : "Game day"}</Chip>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
          <Stat label="On final" value={stats.approach + stats.rollout} />
          <Stat label="Taxiing" value={stats.taxi_in + stats.taxi_out + stats.lineup} />
          <Stat label="Parked" value={stats.parked} />
          <Stat label="Pushback / tows" value={stats.pushback + stats.tow} tone="watch" />
          <Stat label="Departing" value={stats.takeoff + stats.climb} />
          <Stat label="In view" value={stats.visible} />
        </div>
      </div>

      {/* Top-right: camera and layers */}
      <div className="pointer-events-auto absolute right-4 top-4 z-40 flex flex-col items-end gap-2">
        <div className="glass-strong flex items-center gap-1 p-1">
          {(Object.keys(CAMERAS) as CameraMode[]).map((m) => (
            <button key={m} onClick={() => pickCamera(m)}
              className={cx("rounded-[10px] px-2.5 py-1.5 text-[12px] font-medium transition", camera === m && !follow ? "bg-runway text-white" : "text-ink-2 hover:bg-white/70 hover:text-ink")}>
              {CAMERAS[m].label}
            </button>
          ))}
        </div>
        <div className="glass-strong flex flex-wrap items-center justify-end gap-1 p-1">
          <Toggle on={cinematic} onClick={() => setCinematic(!cinematic)} icon={<Camera size={13} />} label="Cinematic orbit" />
          <Toggle on={labels} onClick={() => setLabels(!labels)} icon={labels ? <Eye size={13} /> : <EyeOff size={13} />} label="Labels" />
          <Toggle on={temp} onClick={() => setTemp(!temp)} icon={<SquareParking size={13} />} label={temp ? "Temp zone open" : "Temp zone closed"} tone="tfr" />
          <Toggle on={quality === "high"} onClick={() => setQuality(quality === "high" ? "fast" : "high")} icon={<Sparkles size={13} />} label={quality === "high" ? "High quality" : "Fast mode"} />
        </div>
        <button onClick={followNextArrival} className="btn-primary shadow-lift"><PlaneLanding size={15} /> Follow next arrival</button>
      </div>

      {/* Right: selected aircraft */}
      {sel && (
        <div className="glass-strong pointer-events-auto absolute z-40 right-4 top-[178px] w-[300px] px-4 py-3.5">
          <div className="flex items-start justify-between">
            <div>
              <div className="label">Selected aircraft</div>
              <div className="num mt-0.5 text-[16px] font-semibold">{sel.id}</div>
              <div className="text-[12px] text-ink-2">{SIZE_LABEL[sel.size]} · from {sel.origin} · {sel.booking ?? "no booking"}</div>
            </div>
            <button onClick={() => { setSelected(null); setFollow(false); }} className="rounded-full p-1 text-ink-2 hover:bg-white" aria-label="Close"><X size={15} /></button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SIZE_COLOR[sel.size] }} />
            <span className="text-[13px] font-medium">{selPose?.visible ? PHASE_LABEL[selPose.phase] : sel.L > tMs ? "Not yet inbound" : "Departed"}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
            <Box2 label="Position" value={sel.position === "OVERFLOW" ? "Overflow pad" : sel.position} />
            <Box2 label="Stay" value={sel.stayType.replace(/_/g, " ")} />
            <Box2 label="Lands" value={`${dayShort(sel.arriveIso)} ${hhmm(sel.arriveIso)}`} />
            <Box2 label="Departs" value={`${dayShort(sel.departIso)} ${hhmm(sel.departIso)}`} />
          </div>
          {sel.tows.length > 0 && <p className="mt-2 text-[11.5px] text-[#B45309]">{sel.tows.length} planned tow(s) during its stay</p>}
          <div className="mt-3 flex gap-2">
            <button onClick={() => setFollow(!follow)} className={cx(follow ? "btn-primary" : "btn-ghost", "flex-1")}><Crosshair size={14} /> {follow ? "Following" : "Follow"}</button>
            <button onClick={() => go("parking")} className="btn-ghost flex-1"><SquareParking size={14} /> Parking</button>
          </div>
        </div>
      )}

      {/* Bottom: replay controls */}
      <div className="glass-strong pointer-events-auto absolute z-40 bottom-4 left-4 right-4 flex items-center gap-4 px-4 py-3 2xl:left-[332px]">
        <button onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-runway text-white shadow-[0_6px_18px_rgba(37,99,235,0.35)]">
          {playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
        </button>
        <div className="relative h-8 min-w-0 flex-1">
          <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-ink/10" />
          <div className="absolute top-3 h-2 rounded-full bg-runway/70" style={{ width: `${pct}%` }} />
          <input type="range" min={windowMs[0]} max={windowMs[1]} step={60_000} value={tMs} onChange={(e) => setT(Number(e.target.value))}
            aria-label="Replay time" className="absolute inset-0 h-8 w-full cursor-pointer opacity-0" />
          <div className="pointer-events-none absolute top-1 h-6 w-6 -translate-x-1/2 rounded-full border-2 border-white bg-runway shadow-[0_4px_12px_rgba(37,99,235,0.45)]" style={{ left: `${pct}%` }} />
        </div>
        <div className="flex shrink-0 rounded-control border border-hairline bg-white/60 p-0.5">
          {[1, 10, 60, 600].map((s) => (
            <button key={s} onClick={() => setSpeed(s)}
              className={cx("rounded-[10px] px-2.5 py-1 text-[12px] font-medium", speed === s ? "bg-runway text-white" : "text-ink-2 hover:text-ink")}>{s}×</button>
          ))}
        </div>
      </div>

      {/* Bottom-left: legend */}
      <div className="glass pointer-events-none absolute bottom-4 left-4 z-40 hidden max-w-[300px] px-3 py-2 text-[11px] leading-snug text-ink-2 2xl:block">
        <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1">
          {(["light", "mid", "super_mid", "large"] as const).map((k) => (
            <span key={k} className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full" style={{ background: SIZE_COLOR[k] }} />{SIZE_LABEL[k]}</span>
          ))}
        </div>
        Stands, tows and flights come from the RAMPCAST parking plan. Schematic airfield, not to scale. Drag to orbit, scroll to zoom, click a jet.
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="glass-strong flex items-center gap-2 px-4 py-3 text-[13px] text-ink-2"><Loader2 size={16} className="animate-spin text-runway" /> Building the airfield…</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "watch" }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-ink-2">{label}</span>
      <span className={cx("num font-semibold", tone === "watch" && value > 0 && "text-[#B45309]")}>{value}</span>
    </div>
  );
}

function Box2({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-hairline bg-white/60 px-2.5 py-1.5">
      <div className="label">{label}</div>
      <div className="num mt-0.5 truncate font-semibold">{value}</div>
    </div>
  );
}

function Toggle({ on, onClick, icon, label, tone = "runway" }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string; tone?: "runway" | "tfr" }) {
  return (
    <button onClick={onClick} className={cx("flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[12px] font-medium transition",
      on ? (tone === "tfr" ? "bg-tfr/15 text-tfr" : "bg-runway/12 text-runway") : "text-ink-2 hover:bg-white/70 hover:text-ink")}>
      {icon}{label}
    </button>
  );
}
