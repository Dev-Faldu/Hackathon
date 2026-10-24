import { motion } from "framer-motion";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Ban, Car, CloudFog, CloudRain, Globe2, ListOrdered, Loader2, PlaneLanding, SquareParking, TrendingUp, Zap } from "lucide-react";
import { useState } from "react";
import { TopBar } from "../components/Shell";
import { ApproveBar, Chip, CitedText, ErrorNote, Fold, Glance, Panel } from "../components/ui";
import { api } from "../lib/api";
import { cx, fmt, hhmm, SIZE_LABEL } from "../lib/format";
import { useApp } from "../lib/store";
import type { WhatIf as WhatIfT } from "../lib/types";

interface Preset { id: string; title: string; detail: string; icon: React.ReactNode; modifiers: Record<string, unknown> }

const PRESETS: Preset[] = [
  { id: "runway", title: "Runway 16R/34L closed", detail: "Fri 10:05–10:55 · disabled aircraft on the only long runway", icon: <Ban size={18} />,
    modifiers: { runway_closed: { from: "2027-02-12T10:05:00-08:00", to: "2027-02-12T10:55:00-08:00" } } },
  { id: "demand", title: "Demand 20% higher", detail: "Every day of the week, all size classes", icon: <TrendingUp size={18} />,
    modifiers: { demand_multiplier: 1.2 } },
  { id: "delay", title: "Friday bank 3 h late", detail: "Weather at origin: Fri 09:00–13:00 arrivals land 180 min late", icon: <CloudRain size={18} />,
    modifiers: { arrival_delay: { from: "2027-02-12T09:00:00-08:00", to: "2027-02-12T13:00:00-08:00", minutes: 180 } } },
  { id: "customs", title: "Customs closes early", detail: "Thu: VNY customs 09:00–13:00 instead of 20:30", icon: <Globe2 size={18} />,
    modifiers: { customs_hours: { thu: ["09:00", "13:00"] }, at: "2027-02-11T09:00:00-08:00" } },
  { id: "worst", title: "Worst Friday", detail: "Runway closure plus 20% more demand", icon: <CloudFog size={18} />,
    modifiers: { runway_closed: { from: "2027-02-12T10:05:00-08:00", to: "2027-02-12T10:55:00-08:00" }, demand_multiplier: 1.2 } },
];

const DIFF_ROWS: { key: string; label: string; unit?: string; digits?: number }[] = [
  { key: "overflow_aircraft", label: "Overflow aircraft" },
  { key: "hours_over_capacity", label: "Hours over capacity", unit: "h" },
  { key: "empty_legs", label: "Empty legs" },
  { key: "co2_t", label: "CO₂", unit: "t", digits: 1 },
  { key: "peak_line_staff", label: "Line techs at peak" },
  { key: "peak_movements_per_hour", label: "Movements in peak hour" },
];

export default function WhatIf() {
  const { scenario, layout } = useApp();
  const [active, setActive] = useState<string | null>(null);
  const [result, setResult] = useState<WhatIfT | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("10:05");
  const [to, setTo] = useState("10:55");
  const [day, setDay] = useState("12");
  const [mult, setMult] = useState(100);
  const [mods, setMods] = useState<Record<string, unknown>>({});

  const run = async (id: string, modifiers: Record<string, unknown>) => {
    setActive(id); setLoading(true); setError(null); setMods(modifiers);
    try { setResult(await api.whatif(scenario, modifiers, layout)); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  };
  // The operator's dispatcher reports where a disrupted jet will land; re-plan with that fact.
  const confirmDiversion = (flightId: string, airport: string) => {
    const diversions = { ...((mods.diversions as Record<string, string>) ?? {}), [flightId]: airport };
    run(active ?? "custom", { ...mods, diversions });
  };
  const diverted = (mods.diversions as Record<string, string> | undefined) ?? {};
  const runCustom = () => run("custom", {
    runway_closed: { from: `2027-02-${day}T${from}:00-08:00`, to: `2027-02-${day}T${to}:00-08:00` }, demand_multiplier: mult / 100,
  });

  return (
    <div>
      <TopBar title="What-if" subtitle="Inject a disruption. RAMPCAST re-plans in seconds and shows every ripple; people decide what to do." />
      <Glance steps={["Pick a disruption", "Read what changed", "Approve or reject"]}>
        {result ? <>{result.affected_flights.length > 0 ? <><b className="num">{result.affected_flights.length}</b> inbound jets are affected. </> : null}The table shows how each strategy holds up; the explanation says who decides.</>
          : "What happens if the runway closes, demand jumps or a bank of arrivals runs late? Pick one below and see every knock-on effect."}
      </Glance>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {PRESETS.map((p) => (
          <button key={p.id} onClick={() => run(p.id, p.modifiers)}
            className={cx("glass group flex flex-col items-start gap-2 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-lift",
              active === p.id && "ring-2 ring-runway/50")}>
            <span className={cx("grid h-9 w-9 place-items-center rounded-[11px]", active === p.id ? "bg-runway text-white" : "bg-runway/10 text-runway")}>{p.icon}</span>
            <span className="text-[14px] font-semibold">{p.title}</span>
            <span className="text-[12px] leading-snug text-ink-2">{p.detail}</span>
            <span className="mt-auto flex items-center gap-1 text-[12px] font-medium text-runway opacity-0 transition group-hover:opacity-100">Run <ArrowRight size={13} /></span>
          </button>
        ))}
        <div className={cx("glass flex flex-col gap-2.5 p-4", active === "custom" && "ring-2 ring-runway/50")}>
          <span className="flex items-center gap-2 text-[14px] font-semibold"><Zap size={16} className="text-runway" /> Custom closure</span>
          <div className="grid grid-cols-2 gap-1.5 text-[12px]">
            <select id="wi-day" value={day} onChange={(e) => setDay(e.target.value)} className="col-span-2 rounded-[9px] border border-hairline bg-white/80 px-2 py-1.5">
              {[["09", "Tue Feb 9"], ["10", "Wed Feb 10"], ["11", "Thu Feb 11"], ["12", "Fri Feb 12"], ["13", "Sat Feb 13"], ["14", "Sun Feb 14"], ["15", "Mon Feb 15"]].map(([v, l]) => <option key={v} value={v}>Runway closed · {l}</option>)}
            </select>
            <input id="wi-from" type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="num rounded-[9px] border border-hairline bg-white/80 px-1.5 py-1.5" />
            <input id="wi-to" type="time" value={to} onChange={(e) => setTo(e.target.value)} className="num rounded-[9px] border border-hairline bg-white/80 px-1.5 py-1.5" />
          </div>
          <label className="text-[12px] text-ink-2">Demand <span className="num font-semibold text-ink">{mult}%</span>
            <input id="wi-mult" type="range" min={70} max={150} step={5} value={mult} onChange={(e) => setMult(Number(e.target.value))} className="mt-1 w-full accent-[#2563EB]" />
          </label>
          <button className="btn-primary mt-auto" onClick={runCustom}>Run scenario</button>
        </div>
      </div>

      {error && <div className="mt-4"><ErrorNote error={error} /></div>}
      {!result && !loading && (
        <div className="glass mt-5 grid place-items-center px-6 py-16 text-center">
          <PlaneLanding size={28} className="text-runway" />
          <h3 className="mt-3 text-[17px] font-semibold">Pick a disruption to see its ripple</h3>
          <p className="mt-1 max-w-[520px] text-[13px] text-ink-2">
            Delays, customs windows, overflow, staffing and CO₂ re-compute together. Alternate airports go to each operator's dispatcher as options; the pilot in command decides.
          </p>
        </div>
      )}
      {loading && <div className="glass mt-5 flex items-center justify-center gap-2 py-16 text-[13px] text-ink-2"><Loader2 size={16} className="animate-spin" /> Re-planning…</div>}

      {result && !loading && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-5 space-y-5">
          <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
            <Panel eyebrow="Before → after" title="How each strategy holds up">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left">
                      <th className="label pb-2 font-normal">Metric</th>
                      {Object.keys(result.kpi_diff).map((id) => <th key={id} className="label pb-2 text-right font-normal">Strategy {id}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {DIFF_ROWS.map((r) => (
                      <tr key={r.key}>
                        <td className="py-2.5 text-ink-2">{r.label}</td>
                        {Object.entries(result.kpi_diff).map(([id, d]) => {
                          const [b, a] = d[r.key] ?? [0, 0];
                          const up = a > b, same = a === b;
                          return (
                            <td key={id} className="num py-2.5 text-right">
                              <span className="text-ink-2">{fmt(b, r.digits ?? 0)}</span>
                              <ArrowRight size={11} className="mx-1 inline text-ink-3" />
                              <span className={cx("font-semibold", same ? "text-ink" : up ? "text-alert" : "text-ok")}>{fmt(a, r.digits ?? 0)}</span>
                              {!same && (up ? <ArrowUpRight size={12} className="ml-0.5 inline text-alert" /> : <ArrowDownRight size={12} className="ml-0.5 inline text-ok" />)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Chip>No plan: {result.status_quo.before.hours_over_capacity} → {result.status_quo.after.hours_over_capacity} h over capacity</Chip>
                <Chip>Peak demand {result.status_quo.before.peak_demand} → {result.status_quo.after.peak_demand}</Chip>
              </div>
            </Panel>
            <Panel strong eyebrow="Explanation" title="What changed and who decides"
              actions={<Chip tone="runway">{result.explanation.fallback ? "Built-in" : "Claude"}</Chip>}>
              <CitedText text={result.explanation.text} />
              {result.new_alerts.length > 0 && (
                <div className="mt-4 space-y-2">
                  <div className="label">New alerts</div>
                  {[...result.new_alerts].sort((x, y) => Number(y.kind === "car_wrong_airport") - Number(x.kind === "car_wrong_airport")).slice(0, 6).map((a) => (
                    <div key={a.id} className={cx("rounded-control border px-3 py-2 text-[12.5px]", a.kind === "car_wrong_airport" ? "border-watch/40 bg-watch/[0.07]" : "border-hairline bg-white/70")}>
                      <div className="flex items-start gap-1.5 font-medium">{a.kind === "car_wrong_airport" && <Car size={14} className="mt-[1px] shrink-0 text-watch" />}{a.message}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-2">{a.owner_role} · {a.recommended_action}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 border-t border-hairline pt-3">
                <div className="label mb-2">Hold affected stands for 90 min</div>
                <ApproveBar target={`whatif:${active}:hold-stands`} approverRole="FBO general manager" compact />
              </div>
            </Panel>
          </div>

          {result.stand_plan && (
            <Panel eyebrow={<span className="flex items-center gap-1.5"><SquareParking size={12} /> Stand plan · live week</span>}
              title={`Re-solved for ${result.stand_plan.changed_times} new arrival or departure times`}
              actions={<Chip tone={result.stand_plan.boxed_in ? "alert" : "ok"}>{result.stand_plan.boxed_in ? `${result.stand_plan.boxed_in} boxed in` : "Nobody boxed in"}</Chip>}>
              <div className="flex flex-wrap gap-2 text-[12.5px]">
                <Chip>{result.stand_plan.moves.length} stand {result.stand_plan.moves.length === 1 ? "change" : "changes"}</Chip>
                <Chip tone={result.stand_plan.overflow_after > result.stand_plan.overflow_before ? "alert" : "neutral"}>
                  Overflow {result.stand_plan.overflow_before} → {result.stand_plan.overflow_after}
                </Chip>
                <Chip>Every other jet keeps its stand</Chip>
              </div>
              {result.stand_plan.moves.length > 0 && (
                <div className="mt-3 grid gap-1.5 md:grid-cols-2 2xl:grid-cols-4">
                  {result.stand_plan.moves.slice(0, 8).map((m) => (
                    <div key={m.flight_id} className="num flex items-center gap-2 rounded-control border border-hairline bg-white/70 px-3 py-1.5 text-[12px]">
                      <span className="font-medium">{m.flight_id}</span>
                      <span className="text-ink-2">{m.from ?? "overflow"}</span><ArrowRight size={11} className="text-ink-3" />
                      <span className={cx("font-semibold", m.to ? "text-ink" : "text-alert")}>{m.to ?? "overflow"}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[11.5px] text-ink-2">Same week Parking control shows. Only jets whose times changed, and those they touch, may move. The line supervisor approves each move.</p>
            </Panel>
          )}

          {result.queue_changes && result.queue_changes.length > 0 && (
            <Panel eyebrow={<span className="flex items-center gap-1.5"><ListOrdered size={12} /> Ground-handling queue</span>}
              title={`${result.queue_changes.length} positions changed in the priority queue`}
              actions={<Chip>Strict order: slack, medical, deadlines, wait</Chip>}>
              <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
                {result.queue_changes.slice(0, 9).map((q) => {
                  const up = q.rank_before !== null && q.rank_after < q.rank_before;
                  return (
                    <div key={q.booking_code} className="flex items-start gap-3 rounded-control border border-hairline bg-white/70 px-3 py-2 text-[12.5px]">
                      <div className="num shrink-0 text-[13px]">
                        <span className="text-ink-2">{q.rank_before ?? "new"}</span>
                        <ArrowRight size={11} className="mx-1 inline text-ink-3" />
                        <span className={cx("font-semibold", up ? "text-ok" : "text-watch")}>#{q.rank_after}</span>
                      </div>
                      <div className="min-w-0">
                        <div className="num font-medium">{q.booking_code}</div>
                        <div className="text-[11.5px] leading-snug text-ink-2">{q.reasons[0]}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          {result.affected_flights.length > 0 && (
            <Fold title={`Option cards for the ${result.affected_flights.length} affected jets`} summary="Alternate airports and drive times, sent to each operator's dispatcher; the pilot in command decides">
            <Panel eyebrow="Option cards for operators' dispatchers" title={`${result.affected_flights.length} inbound jets affected`}
              actions={<Chip tone="tfr">Pilot in command decides</Chip>}>
              <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {result.affected_flights.map((f) => (
                  <div key={f.flight_id} className="rounded-[16px] border border-hairline bg-white/70 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="num text-[13px] font-semibold">{f.flight_id} · {f.booking_code}</div>
                        <div className="text-[12px] text-ink-2">{f.origin_name} · {SIZE_LABEL[f.size_class]} · to {f.hotel_zone}</div>
                      </div>
                      {f.is_international && <Chip tone="tfr">Customs</Chip>}
                    </div>
                    <div className="num mt-2 flex items-center gap-2 text-[12.5px]">
                      <span className="text-ink-2 line-through">{hhmm(f.eta_local)}</span>
                      <ArrowRight size={12} className="text-ink-3" />
                      <span className="font-semibold">{hhmm(f.new_eta_local)}</span>
                      <Chip tone="watch">{f.cause === "arrival_delay" ? `+${f.delay_min} min late` : `+${f.delay_min} min if holding`}</Chip>
                      {f.customs_missed && <Chip tone="alert">After customs close</Chip>}
                    </div>
                    <ol className="mt-3 space-y-1.5">
                      {f.options.map((o, idx) => (
                        <li key={o.airport} className={cx("rounded-[10px] border px-2.5 py-2 text-[12px]", idx === 0 ? "border-runway/30 bg-runway/[0.05]" : "border-hairline bg-white/60")}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium"><span className="num mr-1 text-ink-2">{idx + 1}</span>{o.name} <span className="num text-ink-2">({o.airport})</span></span>
                            <span className="num text-ink-2">{o.airport === "KVNY" ? `+${o.expected_delay_min} min` : `${o.extra_drive_min >= 0 ? "+" : ""}${o.extra_drive_min} min drive`}</span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-ink-2">{o.notes.join(" · ")}</div>
                          {o.airport !== "KVNY" && (diverted[f.flight_id] === o.airport ? (
                            <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-watch"><Car size={12} /> Operator confirmed: lands here. Check the car alert.</div>
                          ) : (
                            <button onClick={() => confirmDiversion(f.flight_id, o.airport)} className="mt-1.5 text-[11px] font-medium text-runway hover:underline">
                              Operator confirms it lands here
                            </button>
                          ))}
                        </li>
                      ))}
                    </ol>
                    <div className="mt-3"><ApproveBar target={`options:${f.flight_id}`} approverRole="Customer service" compact /></div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11.5px] text-ink-2">
                Approving sends the option card to the operator's dispatcher. RAMPCAST never contacts ATC or the cockpit, and never chooses the airport.
              </p>
            </Panel>
            </Fold>
          )}
        </motion.div>
      )}
    </div>
  );
}
