import { CircleSlash, FileCheck2, Leaf, Target } from "lucide-react";
import { ForecastChart } from "../components/charts";
import { TopBar } from "../components/Shell";
import { Chip, ErrorNote, Fold, g, Glance, Kpi, KpiRow, Panel, Skeleton } from "../components/ui";
import { api, useApi } from "../lib/api";
import { fmt, sourceOf } from "../lib/format";
import { useApp } from "../lib/store";

const NEVER = [
  "Decide whether a specific aircraft may land, park or depart",
  "Sequence landings, hold aircraft, or contact ATC or a cockpit",
  "Choose a diversion airport (it only shows options to the operator)",
  "Decide who gets the last stand or rank people by who they are",
  "Contact CBP or change a manifest (it only drafts requests)",
];

export default function AfterAction() {
  const { scenario, decisionsVersion } = useApp();
  const aa = useApi(() => api.afteraction(scenario), [scenario, decisionsVersion]);
  const d = aa.data;
  const real = d?.source && d.source !== "sample";
  return (
    <div>
      <TopBar title="After-action" subtitle="Did the forecast hold up, what did the plan change, and who approved what." />
      {aa.error && <ErrorNote error={aa.error} onRetry={aa.reload} />}
      <Glance>
        {d ? <>{d.real_backtest ? <>Tested blind on real FAA counts from <b className="num">{d.real_backtest.events}</b> Super Bowls, the low-to-high range held on
          {" "}<b className="num">{Math.round(d.real_backtest.range_coverage_pct)}%</b> of days (target 80%); the medium line alone is no better than “same as an ordinary week”, so plan on the range. </> : null}
          The plan cut hours over capacity from <b className="num">{d.hours_over_capacity_no_plan}</b> to <b className="num">{d.hours_over_capacity_with_plan}</b>, and every decision is in the audit trail.</> : "Loading the backtest…"}
      </Glance>
      <KpiRow keep={3}>
        <Kpi label="Range held on real data" value={d?.real_backtest?.range_coverage_pct ?? 0} digits={0} unit="%" tone="runway"
          sub={d?.real_backtest ? <>of <span className="num">{d.real_backtest.days}</span> real days inside low–high (target 80%) · medium line <span className="num">{Math.round(d.real_backtest.medium_mape_pct)}%</span> error vs <span className="num">{Math.round(d.real_backtest.naive_mape_pct)}%</span> naive</> : "…"} info={g("out_of_sample")} />
        <Kpi label="Hours over capacity" value={d?.hours_over_capacity_with_plan ?? 0} unit="h" tone="ok"
          sub={<>with Strategy {d?.strategy ?? "–"} · <span className="num">{d?.hours_over_capacity_no_plan ?? "–"}</span> h without a plan</>} info={g("hours_with_plan")} />
        <Kpi label="CO₂ avoided" value={d?.strategy_kpis.co2_saved_vs_adhoc_t ?? 0} digits={1} unit="t" tone="ok"
          sub="Nearest-partner overflow vs ad-hoc repositioning (estimate)" info={g("co2")} />
        <Kpi label="Replay gap (MAPE)" value={d?.mape_pct ?? 0} digits={1} unit="%" sub="Forecast vs the replayed week; not an accuracy claim" info={g("mape")} />
        <Kpi label="P10–P90 coverage" value={d?.interval_coverage_pct ?? 0} unit="%" sub="Replayed days inside the band" info={g("coverage")} />
        <Kpi label="Decisions logged" value={d?.audit.length ?? 0} sub="Approve · edit · reject" info={g("decisions")} />
      </KpiRow>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Panel eyebrow="Replay check · a consistency check, not accuracy" title="Forecast vs the replayed week" actions={<Chip tone={real ? "ok" : "watch"}>{sourceOf(d?.source).chip}</Chip>}>
          {d ? <ForecastChart days={d.days} showActual /> : <Skeleton className="h-[260px]" />}
          <div className="mt-1 flex flex-wrap items-center gap-4 text-[11.5px] text-ink-2">
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rotate-45 rounded-[2px] bg-ink" /> Actual arrivals</span>
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full border-2 border-runway bg-white" /> Forecast P50</span>
            <span>{d?.notes?.[0]}</span>
          </div>
        </Panel>
        <Panel strong eyebrow={<span className="flex items-center gap-1.5"><CircleSlash size={12} className="text-alert" /> Responsible AI</span>}
          title="What RAMPCAST never decides">
          <ul className="space-y-2.5">
            {NEVER.map((n) => (
              <li key={n} className="flex gap-2.5 text-[13px]"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-alert" />{n}</li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="rounded-control border border-hairline bg-white/60 p-3">
              <Target size={15} className="text-runway" />
              <div className="mt-1.5 text-[12.5px] font-medium">Uncertainty shown</div>
              <div className="text-[11.5px] text-ink-2">P10–P90 on every forecast and ETA</div>
            </div>
            <div className="rounded-control border border-hairline bg-white/60 p-3">
              <Leaf size={15} className="text-ok" />
              <div className="mt-1.5 text-[12.5px] font-medium">Privacy by design</div>
              <div className="text-[11.5px] text-ink-2">Hashed tails, booking codes, no names</div>
            </div>
          </div>
        </Panel>
      </div>

      <Fold className="mt-5" title="Audit trail" summary={d ? `${d.audit.length} decisions logged, each with the role and time` : "…"}>
      <Panel className="mt-5" eyebrow={<span className="flex items-center gap-1.5"><FileCheck2 size={12} /> Audit trail</span>}
        title="Every proposal a person approved, edited or rejected">
        {d && d.audit.length === 0 && <p className="text-[13px] text-ink-2">No decisions yet. Approve a strategy on the Plan board or an alert in Live ops.</p>}
        {d && d.audit.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left">{["Logged (UTC)", "Replay time", "Role", "Decision", "Target", "Note"].map((h) => <th key={h} className="label pb-2 pr-4 font-normal">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {[...d.audit].reverse().map((r, i) => (
                  <tr key={i}>
                    <td className="num py-2 pr-4 text-ink-2">{r.t_utc.replace("T", " ").replace("Z", "")}</td>
                    <td className="num py-2 pr-4 text-ink-2">{r.replay_t_local ? r.replay_t_local.slice(5, 16).replace("T", " ") : "—"}</td>
                    <td className="py-2 pr-4">{r.actor_role}</td>
                    <td className="py-2 pr-4"><Chip tone={r.action === "reject" ? "alert" : r.action === "edit" ? "watch" : "ok"}>{r.action}</Chip></td>
                    <td className="num py-2 pr-4">{r.target}</td>
                    <td className="py-2 text-ink-2">{r.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d && <p className="mt-3 text-[11.5px] text-ink-2">Peak occupancy {fmt(d.peak_occupancy, 1)} of {d.capacity} · {d.stand_conflicts_week} departure-order conflicts in the draft stand plan.</p>}
      </Panel>
      </Fold>
    </div>
  );
}
