import { CalendarRange } from "lucide-react";
import { RampDays, ForecastChart } from "../components/charts";
import { StrategyCards } from "../components/decision";
import { TopBar } from "../components/Shell";
import { Chip, ErrorNote, Fold, g, Glance, Kpi, KpiRow, Panel, Skeleton } from "../components/ui";
import { api, useApi } from "../lib/api";
import { fmt } from "../lib/format";
import { useApp } from "../lib/store";
import type { Strategy } from "../lib/types";

const RISK_RANK = { low: 0, medium: 1, high: 2 };

// Same rule the server's briefing uses: the safest plan that keeps the ramp under capacity; CO2 and staff break ties.
function suggest(strategies: Strategy[]): Strategy | undefined {
  const key = (s: Strategy) => [s.kpis.hours_over_capacity, RISK_RANK[s.kpis.risk], s.kpis.co2_t, s.kpis.peak_line_staff];
  return [...strategies].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  })[0];
}

const pct = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

export default function PlanBoard() {
  const { scenario, decisionsVersion } = useApp();
  const fc = useApi(() => api.forecast(scenario), [scenario]);
  const occ = useApi(() => api.occupancy(scenario), [scenario]);
  const st = useApi(() => api.strategies(scenario), [scenario, decisionsVersion]);

  const days = fc.data?.days ?? [];
  const week = days.reduce((a, d) => a + d.p50, 0);
  const ordinary = days.reduce((a, d) => a + d.baseline_p50, 0);
  const peakDay = days.length ? days.reduce((a, d) => (d.p50 > a.p50 ? d : a)) : undefined;
  const peakWeekday = peakDay ? new Date(peakDay.date + "T12:00:00-08:00").toLocaleDateString("en-US", { weekday: "long" }) : "";
  const weekHours = days.length * 24 || 168;

  const cap = st.data?.capacity ?? 0;
  const peakDemand = st.data?.status_quo.peak_demand ?? 0;
  const hoursOver = st.data?.status_quo.hours_over_capacity ?? 0;
  const recCard = st.data ? suggest(st.data.strategies) : undefined;
  const rec = recCard?.id;
  const fixedPct = hoursOver && recCard ? pct(hoursOver - recCard.kpis.hours_over_capacity, hoursOver) : 0;

  return (
    <div>
      <TopBar title="Plan board" subtitle="Ordinary week vs Super Bowl week, the hours the ramp overflows, and three ways to handle it." />
      {(fc.error || st.error) && <div className="mb-4"><ErrorNote error={(fc.error || st.error)!} onRetry={() => { fc.reload(); st.reload(); }} /></div>}

      <Glance steps={["Read the forecast", "Compare the three strategies", "Approve one"]}>
        {fc.data && st.data ? <>Super Bowl week brings about <b className="num">{week}</b> jets to our FBO, against <b className="num">{ordinary}</b> in an ordinary week.
          With no plan the ramp is full for <b className="num">{hoursOver}</b> hours{recCard ? <>; Strategy {recCard.id} cuts that to <b className="num">{recCard.kpis.hours_over_capacity}</b></> : null}.</> : "Loading the forecast…"}
      </Glance>
      <KpiRow keep={3}>
        <Kpi label="Super Bowl surge" value={week} unit="arrivals" rel={ordinary ? `${fmt(week / ordinary, 1)}×` : undefined} tone="runway" info={g("arrivals_week")}
          sub={<>vs <span className="num">{ordinary}</span> in an ordinary week (+{fmt(pct(week - ordinary, ordinary))}%)</>} />
        <Kpi label={`Busiest day${peakWeekday ? ` · ${peakWeekday}` : ""}`} value={peakDay?.p50 ?? 0} unit="arrivals"
          rel={peakDay?.baseline_p50 ? `${fmt(peakDay.p50 / peakDay.baseline_p50, 1)}×` : undefined}
          sub={peakDay ? <>vs <span className="num">{peakDay.baseline_p50}</span> on an ordinary {peakWeekday}</> : ""} info={g("peak_day")} />
        <Kpi label="Ramp at its fullest" value={peakDemand} unit="spaces" rel={cap ? `${fmt(pct(peakDemand, cap))}%` : undefined} tone={peakDemand > cap ? "alert" : "ok"}
          sub={<>needed, but we have <span className="num">{fmt(cap)}</span></>} info={g("ramp_demand")} />
        <Kpi label="Hours over capacity" value={hoursOver} unit="h" rel={`${fmt(pct(hoursOver, weekHours))}%`} tone={hoursOver ? "alert" : "ok"}
          sub={<>of the week's <span className="num">{weekHours}</span> hours, if nothing changes</>} info={g("hours_over")} />
        <Kpi label="Overflow fixed by plan" value={recCard ? hoursOver - recCard.kpis.hours_over_capacity : 0} unit="h" rel={recCard ? `${fmt(fixedPct)}%` : undefined} tone="ok"
          sub={recCard ? (hoursOver ? <><span className="num">{hoursOver}</span> h → <span className="num">{recCard.kpis.hours_over_capacity}</span> h with Strategy {recCard.id}</> : "No overflow to fix") : "…"} info={g("hours_with_plan")} />
        <Kpi label="Jets kept on our ramp" value={recCard?.kpis.parked_at_vny ?? 0} unit="jets"
          rel={recCard ? `${fmt(pct(recCard.kpis.parked_at_vny, recCard.kpis.aircraft_accommodated))}%` : undefined}
          sub={recCard ? <>of <span className="num">{recCard.kpis.aircraft_accommodated}</span>; <span className="num">{recCard.kpis.overflow_aircraft}</span> park elsewhere (Strategy {recCard.id}). Planning week, total space vs booking cap</> : "…"} />
      </KpiRow>

      <Panel className="mt-5" eyebrow="Forecast · daily arrivals at our FBO" title="Ordinary week vs Super Bowl week"
        actions={<><Chip><span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-ink-3" /> Ordinary</Chip><Chip tone="runway">P50 + P10–P90</Chip></>}>
        {fc.data ? <ForecastChart days={fc.data.days} /> : <Skeleton className="h-[260px] w-full" />}
        <p className="mt-1 text-[11.5px] text-ink-2">
          Model: {fc.data?.model === "reference" ? "reference curve shaped by 2022 LA and 2026 Bay Area analogs" : fc.data?.model}.
          Attendance alone does not set aircraft demand; the uplift comes from past Super Bowl flight counts.
        </p>
      </Panel>

      <Fold className="mt-5" title="When we run out of parking, hour by hour"
        summary={occ.data ? `${occ.data.hours.filter((h) => h.p50 > occ.data!.capacity).length} hours this week when the typical case needs more space than the ramp has` : "…"}>
      <Panel className="mt-5" eyebrow="Ramp space · hour by hour, if nothing changes" title="When we run out of parking"
        actions={occ.data && <OverflowChip hours={occ.data.hours} capacity={occ.data.capacity} />}>
        {occ.data ? <RampDays hours={occ.data.hours} capacity={occ.data.capacity} runs={occ.data.runs} /> : (
          <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" />
            <p className="text-[12px] text-ink-2">Simulating the week thousands of times…</p></div>
        )}
      </Panel>
      </Fold>

      <div className="mb-3 mt-7 flex items-end justify-between">
        <div>
          <div className="label">Preparation plan</div>
          <h2 className="text-[20px] font-semibold tracking-[-0.015em]">Three strategies, side by side</h2>
        </div>
        <p className="max-w-[460px] text-right text-[12px] text-ink-2">
          Each option lists who must approve it. Nothing happens until a person approves; every decision is logged.
          Plans count total ramp space against the booking cap; Parking control places each jet on a real stand.
        </p>
      </div>
      {st.data ? <StrategyCards strategies={st.data.strategies} recommended={rec} approved={st.data.approved} overflowHours={hoursOver} /> : (
        <div className="grid gap-4 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[420px]" />)}</div>
      )}
    </div>
  );
}

function OverflowChip({ hours, capacity }: { hours: { t_local: string; p50: number }[]; capacity: number }) {
  const over = hours.filter((h) => h.p50 > capacity);
  const days = new Set(over.map((h) => h.t_local.slice(0, 10))).size;
  const total = Math.ceil(hours.length / 24);
  return over.length
    ? <Chip tone="alert"><CalendarRange size={12} /> Full on {days} of {total} days · {over.length} h</Chip>
    : <Chip tone="ok"><CalendarRange size={12} /> Fits every day</Chip>;
}
