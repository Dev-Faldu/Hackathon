import { motion } from "framer-motion";
import { BadgeCheck, CircleAlert, CircleCheck, Info, Users } from "lucide-react";
import { useState } from "react";
import { cx, fmt } from "../lib/format";
import { useApp } from "../lib/store";
import type { Strategy } from "../lib/types";
import { MiniBar } from "./charts";
import { ApproveBar, Chip, InfoTip } from "./ui";

// Plain-language description of each plan. The numbers on the card come from the engine.
const COPY: Record<Strategy["id"], { how: string[]; good: string[]; watch: string[] }> = {
  A: {
    how: [
      "Overnight bookings close before the ramp is completely full, keeping a few spaces spare.",
      "Jets that arrive after that drop off their passengers and leave.",
      "Each one flies out empty to find its own parking, then flies back empty for pickup.",
    ],
    good: ["Only the FBO manager has to sign off", "Fewest extra staff"],
    watch: ["Pilots find parking on their own, so it creates the most CO₂", "Some customers lose their overnight spot"],
  },
  B: {
    how: [
      "Same booking limit as Strategy A.",
      "Extra jets drop off passengers, then park at a nearby partner FBO: Whiteman (WHP), Camarillo (CMA) or Burbank (BUR).",
      "They come back when their passengers are ready to leave.",
    ],
    good: ["Short, planned hops instead of ad hoc ones, so much less CO₂", "Lowest risk: every jet has a known place to go"],
    watch: ["Partner FBOs must agree to hold spaces", "Needs a couple more line staff to coordinate"],
  },
  C: {
    how: [
      "Close a taxiway and use it as temporary parking spaces.",
      "More jets stay at Van Nuys; the rest go to partner FBOs, as in Strategy B.",
    ],
    good: ["Keeps the most jets on our ramp", "Fewest empty flights and lowest CO₂"],
    watch: ["Needs FAA and airport operations approval, which is slow and uncertain", "A closed taxiway slows ground traffic and needs the most staff"],
  },
};

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

interface Row { label: string; value: string; detail: string; bar: number; best: boolean; what: string }

/** Outcome rows, each shown as a share or as a comparison with the other two plans. */
function outcomeRows(s: Strategy, all: Strategy[], overflowHours: number): Row[] {
  const k = s.kpis;
  const vals = (f: (x: Strategy) => number) => all.map(f);
  const kept = (x: Strategy) => pct(x.kpis.parked_at_vny, x.kpis.aircraft_accommodated);
  const fixed = (x: Strategy) => (overflowHours ? pct(overflowHours - x.kpis.hours_over_capacity, overflowHours) : 100);
  const vsWorst = (f: (x: Strategy) => number, unit: string) => {
    const w = Math.max(...vals(f)), v = f(s);
    const top = all.filter((x) => f(x) === w);
    if (v === w) {
      const others = top.filter((x) => x.id !== s.id).map((x) => x.id);
      return others.length ? `Most, tied with ${others.join(" and ")}` : "Most of the three";
    }
    return `${pct(w - v, w)}% ${unit} than ${top.map((x) => x.id).join(" and ")}`;
  };
  const leanest = Math.min(...vals((x) => x.kpis.peak_line_staff));
  return [
    { label: "Jets kept on our ramp", value: `${kept(s)}%`, detail: `${k.parked_at_vny} of ${k.aircraft_accommodated} arrivals`,
      bar: kept(s), best: kept(s) === Math.max(...vals(kept)), what: "Arrivals that park at Van Nuys instead of somewhere else." },
    { label: "Overflow hours removed", value: `${fixed(s)}%`,
      detail: overflowHours ? `${overflowHours} h → ${k.hours_over_capacity} h` : "No overflow to remove",
      bar: fixed(s), best: fixed(s) === Math.max(...vals(fixed)), what: "Hours in the week when more jets want to park than the ramp holds, and how many of them this plan removes." },
    { label: "Empty flights", value: fmt(k.empty_legs), detail: vsWorst((x) => x.kpis.empty_legs, "fewer"),
      bar: k.empty_legs, best: k.empty_legs === Math.min(...vals((x) => x.kpis.empty_legs)), what: "Flights with no passengers: a jet flying to another airport to park, then back to pick up its passengers." },
    { label: "CO₂ from empty flights", value: `${fmt(k.co2_t, 1)} t`, detail: vsWorst((x) => x.kpis.co2_t, "less"),
      bar: k.co2_t, best: k.co2_t === Math.min(...vals((x) => x.kpis.co2_t)), what: "Tonnes of CO₂ from the empty legs, at 9.75 kg per gallon of jet fuel (EPA)." },
    { label: "Line staff at the busiest hour", value: fmt(k.peak_line_staff),
      detail: k.peak_line_staff === leanest ? "Leanest of the three" : `+${pct(k.peak_line_staff - leanest, leanest)}% vs the leanest`,
      bar: k.peak_line_staff, best: k.peak_line_staff === leanest, what: "Line service staff needed in the busiest hour to fuel, tow and marshal." },
  ];
}

export function StrategyCards({ strategies, recommended, approved, overflowHours }: {
  strategies: Strategy[]; recommended?: string; approved?: string | null; overflowHours: number;
}) {
  const { simple } = useApp();
  const [all, setAll] = useState(false);
  const full = !simple || all;
  const rows = strategies.map((s) => outcomeRows(s, strategies, overflowHours));
  const barMax = (i: number) => Math.max(...rows.map((r) => r[i].bar));
  return (
    <>
    <div className="grid gap-4 xl:grid-cols-3">
      {strategies.map((s, si) => {
        const copy = COPY[s.id];
        return (
          <motion.article key={s.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: si * 0.06 }}
            className={cx("glass-strong relative flex flex-col p-5", recommended === s.id && "ring-2 ring-runway/40")}>
            {recommended === s.id && (
              <span className="absolute -top-2.5 left-5 rounded-full bg-runway px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-[0_4px_12px_rgba(37,99,235,0.35)]">
                Suggested
              </span>
            )}
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-ink text-[15px] font-semibold text-white">{s.id}</div>
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-semibold leading-tight">{s.name}</h3>
                <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{s.summary}</p>
              </div>
              <HowItWorks steps={copy.how} />
            </div>

            <div className="label mb-1.5 mt-4">What you get</div>
            <div className="space-y-2.5">
              {rows[si].slice(0, full ? undefined : 2).map((r, i) => (
                <div key={r.label}>
                  <div className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="flex items-center gap-1 text-ink-2">{r.label} <InfoTip what={r.what} /></span>
                    <span className={cx("num text-[13px] font-semibold", r.best && "text-ok")}>{r.value}</span>
                  </div>
                  <div className="mb-1 text-right text-[11px] text-ink-3">{r.detail}</div>
                  <MiniBar value={r.bar} max={i < 2 ? 100 : barMax(i)} tone={r.best ? "#16A34A" : "#2563EB"} />
                </div>
              ))}
            </div>

            {s.overflow_split && Object.keys(s.overflow_split).length > 0 && s.kpis.overflow_aircraft > 0 && <OverflowSplit split={s.overflow_split} />}

            {full && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <ProsCons title="Good" tone="ok" items={copy.good} />
                <ProsCons title="Watch out" tone="watch" items={copy.watch} />
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              <Chip tone={s.kpis.risk === "high" ? "alert" : s.kpis.risk === "medium" ? "watch" : "ok"}>Risk: {s.kpis.risk}</Chip>
              {s.kpis.co2_saved_vs_adhoc_t > 0 && <Chip tone="ok">−{fmt(s.kpis.co2_saved_vs_adhoc_t, 1)} t CO₂ vs ad hoc</Chip>}
              {s.solver === "cp-sat" && <Chip tone="runway">Optimized by CP-SAT solver</Chip>}
            </div>
            <div className="mt-3 border-t border-hairline pt-3">
              <div className="label mb-1.5 flex items-center gap-1"><Users size={12} /> Who must approve</div>
              <div className="flex flex-wrap gap-1.5">
                {s.approvers.map((a) => <Chip key={a} tone={a === "FAA" ? "tfr" : "neutral"}>{a}</Chip>)}
              </div>
            </div>
            <div className="mt-auto pt-4">
              {approved === s.id ? (
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ok"><BadgeCheck size={15} /> Approved plan</div>
              ) : (
                <ApproveBar target={`strategy:${s.id}`} approverRole={s.approvers[0]} compact />
              )}
            </div>
          </motion.article>
        );
      })}
    </div>
    {simple && (
      <button onClick={() => setAll(!all)} className="mt-2 text-[12px] font-medium text-runway hover:underline">
        {all ? "Show fewer numbers" : "Compare everything: empty flights, CO₂, staff, pros and cons"}
      </button>
    )}
    </>
  );
}

const PARTNER_NAME: Record<string, string> = { KWHP: "Whiteman", KBUR: "Burbank", KCMA: "Camarillo", adhoc: "Ad hoc (finds own parking)" };

/** Where the solver sends each overflow jet, within the spaces each partner holds. */
function OverflowSplit({ split }: { split: Record<string, number> }) {
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  const rows = Object.entries(split).filter(([, n]) => n > 0);
  return (
    <div className="mt-4">
      <div className="label mb-1.5">Where the overflow jets go</div>
      <div className="flex h-2 overflow-hidden rounded-full bg-ink/[0.06]">
        {rows.map(([k, n]) => (
          <div key={k} style={{ width: `${(n / total) * 100}%`, background: k === "adhoc" ? "#D97706" : "#2563EB", opacity: k === "adhoc" ? 1 : 0.45 + 0.55 * (n / total) }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-2">
        {rows.map(([k, n]) => (
          <span key={k}><b className={cx("num", k === "adhoc" ? "text-watch" : "text-ink")}>{n}</b> {PARTNER_NAME[k] ?? k}{k !== "adhoc" && <span className="num text-ink-3"> ({k.slice(1)})</span>}</span>
        ))}
      </div>
    </div>
  );
}

/** Info button; the steps appear only while it is hovered (or focused, for keyboard users). */
function HowItWorks({ steps }: { steps: string[] }) {
  return (
    <div className="group relative shrink-0">
      <button type="button" aria-label="How it works"
        className="grid h-7 w-7 place-items-center rounded-full text-ink-3 transition hover:bg-runway/10 hover:text-runway focus:bg-runway/10 focus:text-runway focus:outline-none">
        <Info size={16} />
      </button>
      <div role="tooltip"
        className="glass-strong invisible !bg-white/95 absolute right-0 top-8 z-30 w-[300px] p-3.5 opacity-0 shadow-lift transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="label mb-2">How it works</div>
        <ol className="space-y-1.5 text-[12.5px] leading-snug">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="num grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-runway/10 text-[10.5px] font-semibold text-runway">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function ProsCons({ title, tone, items }: { title: string; tone: "ok" | "watch"; items: string[] }) {
  const Icon = tone === "ok" ? CircleCheck : CircleAlert;
  return (
    <div className="rounded-control border border-hairline bg-white/50 p-2.5">
      <div className={cx("mb-1 text-[11.5px] font-semibold", tone === "ok" ? "text-ok" : "text-watch")}>{title}</div>
      <ul className="space-y-1 text-[12px] leading-snug text-ink-2">
        {items.map((t) => (
          <li key={t} className="flex gap-1.5"><Icon size={13} className={cx("mt-[2px] shrink-0", tone === "ok" ? "text-ok" : "text-watch")} />{t}</li>
        ))}
      </ul>
    </div>
  );
}
