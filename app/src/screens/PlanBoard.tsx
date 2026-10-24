import { CalendarRange } from "lucide-react";
import { RampHeatmap, ForecastChart } from "../components/charts";
import { BriefingPanel, StrategyCards } from "../components/decision";
import { TopBar } from "../components/Shell";
import { Chip, ErrorNote, Kpi, Panel, Skeleton } from "../components/ui";
import { api, useApi } from "../lib/api";
import { fmt } from "../lib/format";
import { useApp } from "../lib/store";

export default function PlanBoard() {
  const { scenario, decisionsVersion } = useApp();
  const fc = useApi(() => api.forecast(scenario), [scenario]);
  const occ = useApi(() => api.occupancy(scenario), [scenario]);
  const st = useApi(() => api.strategies(scenario), [scenario, decisionsVersion]);
  const brief = useApi(() => api.briefing(scenario), [scenario]);

  const week = fc.data?.days.reduce((a, d) => a + d.p50, 0) ?? 0;
  const ordinary = fc.data?.days.reduce((a, d) => a + d.baseline_p50, 0) ?? 0;
  const peakDay = fc.data?.days.reduce((a, d) => (d.p50 > a.p50 ? d : a), fc.data.days[0]);
  const rec = brief.data?.recommended;
  const recCard = st.data?.strategies.find((s) => s.id === rec);

  return (
    <div>
      <TopBar title="Plan board" subtitle="Ordinary week vs Super Bowl week, the hours the ramp overflows, and three ways to handle it." />
      {(fc.error || st.error) && <div className="mb-4"><ErrorNote error={(fc.error || st.error)!} onRetry={() => { fc.reload(); st.reload(); }} /></div>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        <Kpi label="Arrivals this week" value={week} sub={<>vs <span className="num">{ordinary}</span> in an ordinary week (×{ordinary ? (week / ordinary).toFixed(1) : "–"})</>} tone="runway" />
        <Kpi label="Peak day" value={peakDay?.p50 ?? 0} unit="arrivals" sub={peakDay ? `${new Date(peakDay.date + "T12:00:00-08:00").toLocaleDateString("en-US", { weekday: "long" })} · P90 ${peakDay.p90}` : ""} />
        <Kpi label="Peak ramp demand" value={st.data?.status_quo.peak_demand ?? 0} digits={1} unit={`/ ${st.data?.capacity ?? "–"}`}
          tone={st.data && st.data.status_quo.peak_demand > st.data.capacity ? "alert" : "ok"} sub="Large-cabin equivalents, unconstrained" />
        <Kpi label="Hours over capacity" value={st.data?.status_quo.hours_over_capacity ?? 0} unit="h" tone="alert" sub="If nothing changes" />
        <Kpi label="With suggested plan" value={recCard?.kpis.hours_over_capacity ?? 0} unit="h" tone="ok" sub={recCard ? `Strategy ${recCard.id}: ${recCard.name}` : "…"} />
        <Kpi label="Fuel this week" value={recCard ? recCard.kpis.fuel_gal_week / 1000 : 0} digits={0} unit="k gal" sub="Jet A, blended uplift per departure" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Panel eyebrow="Forecast · daily arrivals at our FBO" title="Ordinary week vs Super Bowl week"
          actions={<><Chip><span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-ink-3" /> Ordinary</Chip><Chip tone="runway">P50 + P10–P90</Chip></>}>
          {fc.data ? <ForecastChart days={fc.data.days} /> : <Skeleton className="h-[260px] w-full" />}
          <p className="mt-1 text-[11.5px] text-ink-2">
            Model: {fc.data?.model === "reference" ? "reference curve shaped by 2022 LA and 2026 Bay Area analogs" : fc.data?.model}.
            Attendance alone does not set aircraft demand; the uplift comes from past Super Bowl flight counts.
          </p>
        </Panel>
        <BriefingPanel />
      </div>

      <Panel className="mt-5" eyebrow="Ramp occupancy · P50 by hour" title="When the ramp overflows"
        actions={<Chip tone="alert"><CalendarRange size={12} /> {occ.data ? `${occ.data.hours.filter((h) => h.p_over_capacity >= 0.5).length} h with ≥50% chance of overflow` : "…"}</Chip>}>
        {occ.data ? <RampHeatmap hours={occ.data.hours} capacity={occ.data.capacity} /> : (
          <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" />
            <p className="text-[12px] text-ink-2">Running {fmt(120)} simulated weeks…</p></div>
        )}
      </Panel>

      <div className="mb-3 mt-7 flex items-end justify-between">
        <div>
          <div className="label">Preparation plan</div>
          <h2 className="text-[20px] font-semibold tracking-[-0.015em]">Three strategies, side by side</h2>
        </div>
        <p className="max-w-[460px] text-right text-[12px] text-ink-2">
          Each option lists who must approve it. Nothing happens until a person approves; every decision is logged.
        </p>
      </div>
      {st.data ? <StrategyCards strategies={st.data.strategies} recommended={rec} approved={st.data.approved} /> : (
        <div className="grid gap-4 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[420px]" />)}</div>
      )}
    </div>
  );
}
