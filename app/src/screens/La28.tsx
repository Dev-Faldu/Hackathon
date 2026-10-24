import { motion } from "framer-motion";
import { CalendarClock, Globe2, Hourglass, Medal, ShieldAlert } from "lucide-react";
import { ForecastChart } from "../components/charts";
import { TopBar } from "../components/Shell";
import { ApproveBar, Chip, ErrorNote, g, Glance, Kpi, KpiRow, Panel, Skeleton } from "../components/ui";
import { api, useApi } from "../lib/api";
import { cx, fmt } from "../lib/format";
import { useApp } from "../lib/store";
import type { La28Report } from "../lib/types";

const DAY = (iso: string) => new Date(iso + "T12:00:00-07:00").toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });

export default function La28() {
  const { scenario } = useApp();
  const r = useApi(() => api.la28(scenario), [scenario]);
  const d = r.data;
  const la = d?.la28, sb = d?.super_bowl;

  return (
    <div>
      <TopBar event="LA28 Olympics · Opening Ceremony Fri Jul 14 2028" title="LA28 stretch: Olympic opening week"
        subtitle="The same forecast and parking engine on a different event. What changes for the FBO, and what to do differently." />
      {r.error && <div className="mb-4"><ErrorNote error={r.error} onRetry={r.reload} /></div>}

      <Glance>
        {la && sb ? <>The Super Bowl spikes and clears on Monday. The Olympics fill the ramp and stay: <b className="num">{la.parked_at_week_end}</b> jets are still parked when opening week ends, against <b className="num">{sb.parked_at_week_end}</b> after the Super Bowl.
          Plan for long stays from day one.</> : "Loading the LA28 estimate…"}
      </Glance>
      <KpiRow keep={3}>
        <Kpi label="Arrivals this week" value={d ? d.days.reduce((a, x) => a + x.p50, 0) : 0} tone="runway"
          sub={d ? <>vs <span className="num">{d.days.reduce((a, x) => a + x.baseline_p50, 0)}</span> in an ordinary July week</> : "…"}
          info={{ what: "Business jets expected at our FBO in the Olympic opening week (middle estimate).", source: "No Olympic precedent at VNY: an estimate from stated assumptions (la28.py), not a backtested forecast." }} />
        <Kpi label="Hours over capacity" value={la?.hours_over_capacity ?? 0} unit="h" tone="alert"
          sub={sb ? <>If nothing changes. Super Bowl: <span className="num">{sb.hours_over_capacity}</span> h</> : "…"} info={g("hours_over")} />
        <Kpi label="Parked at week end" value={la?.parked_at_week_end ?? 0} unit="jets" tone="watch"
          sub={sb ? <>Super Bowl: <span className="num">{sb.parked_at_week_end}</span>. The ramp does not clear on Monday</> : "…"} info={{ what: "Jets still on our ramp at the end of opening week. Olympic delegations stay for the Games, so the ramp does not clear.", source: "LA28 profile in la28.py: 62% long stays, stated assumptions." }} />
        <Kpi label="Peak ramp demand" value={la?.peak_demand ?? 0} digits={1} unit={`/ ${d?.capacity ?? "–"}`} tone="alert"
          sub={sb ? <>Super Bowl peak <span className="num">{sb.peak_demand}</span></> : "…"} info={g("ramp_demand")} />
        <Kpi label="Median stay" value={la ? la.median_stay_h / 24 : 0} digits={1} unit="days"
          sub={sb ? <>Super Bowl: <span className="num">{(sb.median_stay_h / 24).toFixed(1)}</span> days</> : "…"} />
        <Kpi label="International" value={la?.international_pct ?? 0} unit="%"
          sub={sb ? <>Super Bowl: <span className="num">{sb.international_pct}</span>%. More customs demand</> : "…"} />
      </KpiRow>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <Panel eyebrow="Forecast · daily arrivals at our FBO" title="Ordinary July week vs LA28 opening week"
          actions={<><Chip><span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-ink-3" /> Ordinary</Chip><Chip tone="runway">P50 + P10–P90</Chip></>}>
          {d ? <ForecastChart days={d.days} eventDate={d.event.ceremony_date} /> : <Skeleton className="h-[260px] w-full" />}
          {d && (
            <div className="mt-2 flex flex-wrap gap-2">
              {(["low", "medium", "high"] as const).map((s) => (
                <Chip key={s} tone={s === scenario ? "runway" : "neutral"}>{s[0].toUpperCase() + s.slice(1)}: <span className="num">{d.week_by_scenario[s]}</span> arrivals</Chip>
              ))}
            </div>
          )}
        </Panel>
        <Panel strong eyebrow="Same engine, different event" title="Super Bowl LXI vs LA28">
          {la && sb ? <Compare la={la} sb={sb} /> : <Skeleton className="h-[300px] w-full" />}
        </Panel>
      </div>

      <Panel className="mt-5" eyebrow="Ramp occupancy · P50 by hour, large-cabin equivalents" title="The Super Bowl spikes and clears. The Olympics fill the ramp and stay."
        actions={d?.first_hour_over_capacity ? <Chip tone="alert"><CalendarClock size={12} /> Full from {DAY(d.first_hour_over_capacity.slice(0, 10))} {d.first_hour_over_capacity.slice(11, 16)}</Chip> : undefined}>
        {d ? <OccupancyCompare report={d} /> : <Skeleton className="h-[240px] w-full" />}
      </Panel>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Panel eyebrow="Recommended preparation" title="What the FBO does differently for LA28" actions={<Chip tone="tfr">People approve</Chip>}>
          <div className="grid gap-3 md:grid-cols-2">
            {d?.recommendations.map((x, i) => (
              <motion.div key={x.title} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                className="rounded-[16px] border border-hairline bg-white/70 p-4">
                <div className="flex items-start gap-2">
                  <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-runway/10 text-[12px] font-semibold text-runway">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-semibold">{x.title}</div>
                    <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{x.detail}</p>
                  </div>
                </div>
                <div className="mt-3"><ApproveBar target={`la28:${x.title}`} approverRole={x.approver} compact /></div>
              </motion.div>
            )) ?? <Skeleton className="h-[260px] w-full md:col-span-2" />}
          </div>
        </Panel>
        <div className="flex flex-col gap-5">
          <Panel eyebrow="Overflow strategies on the LA28 week" title="The same three options">
            {la ? (
              <table className="w-full text-[12.5px]">
                <thead><tr className="text-left"><th className="label pb-2 font-normal">Strategy</th><th className="label pb-2 text-right font-normal">Overflow</th><th className="label pb-2 text-right font-normal">CO₂ t</th><th className="label pb-2 text-right font-normal">Techs</th></tr></thead>
                <tbody className="divide-y divide-hairline">
                  {la.strategies.map((s) => (
                    <tr key={s.id}>
                      <td className="py-2"><span className="font-semibold">{s.id}</span> <span className="text-ink-2">{s.name}</span></td>
                      <td className="num py-2 text-right">{s.kpis.overflow_aircraft}</td>
                      <td className="num py-2 text-right">{fmt(s.kpis.co2_t, 1)}</td>
                      <td className="num py-2 text-right">{s.kpis.peak_line_staff}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Skeleton className="h-[140px] w-full" />}
          </Panel>
          <Panel eyebrow="Assumptions" title="What this estimate rests on" actions={<Chip tone="watch">No Olympic analog at VNY</Chip>}>
            <ul className="space-y-1.5 text-[12.5px] leading-snug text-ink-2">
              {d?.assumptions.map((a) => <li key={a} className="flex gap-2"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{a}</li>)}
            </ul>
            {d && <p className="mt-3 flex items-start gap-2 rounded-control border border-tfr/20 bg-tfr/[0.05] px-3 py-2 text-[12px] text-ink"><ShieldAlert size={14} className="mt-0.5 shrink-0 text-tfr" />{d.never}</p>}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Compare({ la, sb }: { la: La28Report["la28"]; sb: La28Report["super_bowl"] }) {
  const rows: { k: string; a: string | number; b: string | number; icon?: React.ReactNode; worse?: boolean }[] = [
    { k: "Arrivals in the week", a: sb.arrivals, b: la.arrivals },
    { k: "Peak ramp demand", a: sb.peak_demand, b: la.peak_demand, worse: la.peak_demand > sb.peak_demand },
    { k: "Hours over capacity, no plan", a: sb.hours_over_capacity, b: la.hours_over_capacity, worse: true },
    { k: "Median stay", a: `${(sb.median_stay_h / 24).toFixed(1)} d`, b: `${(la.median_stay_h / 24).toFixed(1)} d`, icon: <Hourglass size={12} />, worse: true },
    { k: "Still parked at week end", a: sb.parked_at_week_end, b: la.parked_at_week_end, worse: true },
    { k: "International arrivals", a: `${sb.international_pct}%`, b: `${la.international_pct}%`, icon: <Globe2 size={12} />, worse: true },
    { k: "Large cabins", a: `${sb.large_pct}%`, b: `${la.large_pct}%` },
    { k: "Tows · whiteboard → RAMPCAST", a: `${sb.tows_whiteboard} → ${sb.tows_rampcast}`, b: `${la.tows_whiteboard} → ${la.tows_rampcast}` },
  ];
  return (
    <div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-hairline pb-2 text-[11px]">
        <span className="label">Metric</span><span className="label text-right">Super Bowl</span><span className="label flex items-center justify-end gap-1 text-right text-tfr"><Medal size={11} /> LA28</span>
      </div>
      <div className="divide-y divide-hairline">
        {rows.map((r) => (
          <div key={r.k} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 py-2 text-[12.5px]">
            <span className="flex items-center gap-1.5 text-ink-2">{r.icon}{r.k}</span>
            <span className="num text-right">{r.a}</span>
            <span className={cx("num text-right font-semibold", r.worse ? "text-alert" : "text-ink")}>{r.b}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] leading-snug text-ink-2">
        Long Olympic stays mean fewer shuffles but far more nights over capacity: the plan shifts from tow sequencing to long-term overflow parking.
      </p>
    </div>
  );
}

function OccupancyCompare({ report }: { report: La28Report }) {
  const W = 1100, H = 250, L = 40, R = 14, T = 14, B = 30;
  const hrs = report.hours, cap = report.capacity;
  const max = Math.max(cap, ...hrs.map((h) => Math.max(h.la28_p90, h.sb_p50))) * 1.1;
  const x = (i: number) => L + ((W - L - R) * i) / (hrs.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const path = (k: "la28_p50" | "sb_p50" | "la28_p90") => hrs.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h[k]).toFixed(1)}`).join("");
  const area = `${path("la28_p90")}L${x(hrs.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const ticks = [0, 20, 40, 60, 80, 100].filter((v) => v < max);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Ramp occupancy, LA28 vs Super Bowl">
        <defs>
          <linearGradient id="la28Fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#C026D3" stopOpacity="0.16" /><stop offset="1" stopColor="#C026D3" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgba(15,30,60,0.07)" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#4A5B73" className="num">{v}</text></g>
        ))}
        {Array.from({ length: 7 }, (_, d) => (
          <g key={d}>
            {d > 0 && <line x1={x(d * 24)} x2={x(d * 24)} y1={T} y2={H - B} stroke="rgba(15,30,60,0.06)" />}
            <text x={x(d * 24 + 12)} y={H - 10} textAnchor="middle" fontSize="11.5"
              fill={hrs[d * 24].t_local.startsWith(report.event.ceremony_date) ? "#C026D3" : "#4A5B73"}
              fontWeight={hrs[d * 24].t_local.startsWith(report.event.ceremony_date) ? 600 : 400}>{DAY(hrs[d * 24].t_local.slice(0, 10))}</text>
          </g>
        ))}
        <path d={area} fill="url(#la28Fill)" />
        <line x1={L} x2={W - R} y1={y(cap)} y2={y(cap)} stroke="#DC2626" strokeWidth="1.4" strokeDasharray="6 5" />
        <text x={W - R - 4} y={y(cap) - 6} textAnchor="end" fontSize="11" fill="#DC2626" fontWeight={600}>Capacity {cap}</text>
        <path d={path("sb_p50")} fill="none" stroke="#2563EB" strokeWidth="2" strokeDasharray="5 4" opacity={0.85} />
        <motion.path d={path("la28_p50")} fill="none" stroke="#C026D3" strokeWidth="2.6" strokeLinejoin="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1, ease: "easeOut" }} />
      </svg>
      <div className="mt-1 flex flex-wrap gap-2">
        <Chip tone="tfr">LA28 P50 (band to P90)</Chip>
        <Chip tone="runway">Super Bowl week P50, same weekdays</Chip>

      </div>
    </div>
  );
}
