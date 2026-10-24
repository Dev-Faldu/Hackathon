import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, BellRing, Car, Clock, Globe2, PlaneLanding, PlaneTakeoff } from "lucide-react";
import { useState } from "react";
import { FlightMap, PulseDot, RampMap } from "../components/maps";
import { ReplayBar, TopBar } from "../components/Shell";
import { ApproveBar, Chip, Kpi, Panel, Skeleton } from "../components/ui";
import { api, useApi } from "../lib/api";
import { cx, hhmm, SIZE_LABEL, sourceOf } from "../lib/format";
import { useApp, useReplayTick } from "../lib/store";
import type { Alert } from "../lib/types";

export default function LiveOps() {
  const { speed, decisionsVersion } = useApp();
  const fast = useReplayTick(speed >= 3600 ? 20 : 5);
  const slow = useReplayTick(15);
  const rs = useApi(() => api.replay(fast.bucketIso), [fast.bucketMs]);
  const al = useApi(() => api.alerts(slow.bucketIso), [slow.bucketMs]);
  const qu = useApi(() => api.queue(slow.bucketIso), [slow.bucketMs, decisionsVersion]);
  const s = rs.data;

  return (
    <div>
      <TopBar title="Live ops" subtitle="Every inbound jet, the ramp, and who needs a car first. Suggestions only; people approve.">
        <Chip tone="runway" className="py-1"><PulseDot /> {sourceOf(s?.source).replay}</Chip>
      </TopBar>
      <ReplayBar />

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Ramp occupancy" value={s?.occupancy_pct ?? 0} unit="%" tone={s && s.occupancy_pct > 100 ? "alert" : s && s.occupancy_pct > 90 ? "watch" : "ok"}
          sub={s ? <><span className="num">{s.occupancy}</span> of <span className="num">{s.capacity}</span> large-cabin equivalents</> : "…"} />
        <Kpi label="Inbound now" value={s?.airborne_count ?? 0} sub="Airborne to KVNY, our FBO" tone="runway" />
        <Kpi label="Aircraft on ground" value={s?.aircraft_on_ground ?? 0} sub={`${s?.arrivals_today ?? 0} arrivals · ${s?.departures_today ?? 0} departures today`} />
        <Kpi label="Need overflow" value={s?.overflow_now ?? 0} tone={s && s.overflow_now > 0 ? "alert" : "ok"} sub="No stand fits right now" />
        <Kpi label="Departure-order conflicts" value={s?.stand_conflicts_week ?? 0} sub="Whole week, in the draft stand plan" />
      </div>

      <div className="mt-5 grid gap-5 2xl:grid-cols-[1.75fr_1fr]">
        <Panel eyebrow="Inbound · worldwide" title={`${s?.airborne_count ?? "–"} jets converging on Van Nuys`} bodyClass="pt-2">
          {s ? <FlightMap airborne={s.airborne} /> : <Skeleton className="aspect-[980/520] w-full" />}
        </Panel>
        <div className="flex min-w-0 flex-col gap-5">
          <AlertsPanel alerts={al.data?.alerts ?? []} loading={al.loading && !al.data} />
          <Panel eyebrow="Next 2 hours" title="Arrivals at our FBO" bodyClass="max-h-[224px] overflow-auto">
            {s && s.upcoming.length === 0 && <p className="text-[13px] text-ink-2">No arrivals in the next two hours.</p>}
            <ul className="divide-y divide-hairline">
              {s?.upcoming.map((u) => (
                <li key={u.flight_id} className="flex items-center gap-3 py-2 text-[12.5px]">
                  <PlaneLanding size={15} className={u.is_international ? "text-tfr" : "text-runway"} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{u.origin_name} <span className="text-ink-2">({u.origin})</span></div>
                    <div className="text-[11.5px] text-ink-2">{SIZE_LABEL[u.size_class]} · {u.booking_code}</div>
                  </div>
                  <div className="text-right">
                    <div className="num font-semibold">{hhmm(u.eta_local)}</div>
                    <div className="num text-[11px] text-ink-2">P90 {hhmm(u.eta_p90_local)}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      <div className="mt-5 grid gap-5 2xl:grid-cols-[1.2fr_1fr]">
        <Panel eyebrow="Ramp · draft stand plan" title="Who is parked where"
          actions={<Chip>{s?.ground.filter((g) => g.stand_id).length ?? 0} / {s?.stands.length ?? 48} stands</Chip>}>
          {s ? <RampMap stands={s.stands} ground={s.ground} overflow={s.overflow_now} /> : <Skeleton className="h-[420px]" />}
          <p className="mt-2 text-[11.5px] text-ink-2">
            Jets that leave later park deeper, so no one is boxed in. The line supervisor approves every tow and marshals every aircraft.
          </p>
        </Panel>
        <QueuePanel items={qu.data?.items ?? []} policy={qu.data?.policy} loading={qu.loading && !qu.data} />
      </div>

      {s && s.recent.length > 0 && (
        <div className="glass mt-5 flex items-center gap-4 overflow-hidden px-4 py-2.5 text-[12px]">
          <span className="label shrink-0">Last 45 min</span>
          <div className="flex min-w-0 gap-5 overflow-x-auto">
            {s.recent.map((r) => (
              <span key={r.flight_id + r.event} className="flex shrink-0 items-center gap-1.5 text-ink-2">
                {r.event === "landed" ? <PlaneLanding size={13} className="text-runway" /> : <PlaneTakeoff size={13} className="text-ink-3" />}
                <span className="num text-ink">{hhmm(r.t_local)}</span> {r.flight_id} {r.event === "landed" ? `from ${r.origin}` : "departed"}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function alertTitle(alerts: Alert[]) {
  const high = alerts.filter((a) => a.severity === "high").length;
  const watch = alerts.filter((a) => a.severity === "watch").length;
  const parts = [high && `${high} high`, watch && `${watch} watch`, alerts.length - high - watch && `${alerts.length - high - watch} info`].filter(Boolean);
  return `${alerts.length} open · ${parts.join(", ")}`;
}

function AlertsPanel({ alerts, loading }: { alerts: Alert[]; loading: boolean }) {
  const tone = { high: "alert", watch: "watch", info: "runway" } as const;
  return (
    <Panel eyebrow={<span className="flex items-center gap-1.5"><BellRing size={12} /> Alerts</span>}
      title={alerts.length ? alertTitle(alerts) : "All clear"} bodyClass="max-h-[268px] overflow-auto">
      {loading && <Skeleton className="h-20" />}
      {!loading && alerts.length === 0 && <p className="text-[13px] text-ink-2">No ramp, customs or curfew risks in the look-ahead window.</p>}
      <div className="space-y-2.5">
        <AnimatePresence initial={false}>
          {alerts.slice(0, 6).map((a) => (
            <motion.div key={a.id} layout initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
              className={cx("rounded-control border bg-white/70 p-3", a.severity === "high" ? "border-alert/25" : "border-hairline")}>
              <div className="flex items-start gap-2">
                {a.kind === "customs_window" ? <Globe2 size={15} className="mt-0.5 shrink-0 text-tfr" /> :
                  a.kind === "curfew" ? <Clock size={15} className="mt-0.5 shrink-0 text-runway" /> :
                    <AlertTriangle size={15} className={cx("mt-0.5 shrink-0", a.severity === "high" ? "text-alert" : "text-watch")} />}
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium leading-snug">{a.message}</div>
                  <div className="mt-1 text-[11.5px] text-ink-2">Suggested: {a.recommended_action}</div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <Chip tone={tone[a.severity]}>{a.owner_role}</Chip>
                    <ApproveBar target={`alert:${a.id}`} approverRole={a.owner_role} compact />
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Panel>
  );
}

function QueuePanel({ items, policy, loading }: { items: import("../lib/types").QueueItem[]; policy?: string; loading: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel eyebrow={<span className="flex items-center gap-1.5"><Car size={12} /> Ground-handling priority</span>}
      title="Who needs a car and the curb first" bodyClass="max-h-[520px] overflow-auto"
      actions={<Chip tone="ok">Need-based</Chip>}>
      {policy && <p className="mb-3 text-[11.5px] leading-snug text-ink-2">{policy}</p>}
      {loading && <Skeleton className="h-40" />}
      {!loading && items.length === 0 && <p className="text-[13px] text-ink-2">No parties arriving in the next three hours.</p>}
      <ol className="space-y-2">
        {items.slice(0, 10).map((i) => (
          <li key={i.booking_code} className={cx("rounded-control border bg-white/70 p-3 transition", open === i.booking_code ? "border-runway/30" : "border-hairline")}>
            <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(open === i.booking_code ? null : i.booking_code)}>
              <span className={cx("num grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold",
                i.rank <= 3 ? "bg-runway text-white" : "bg-ink/[0.06] text-ink")}>{i.rank}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="num text-[13px] font-semibold">{i.booking_code}</span>
                  <Chip tone={i.status === "on_ground" ? "ok" : "neutral"}>{i.status === "on_ground" ? "On ground" : `ETA ${hhmm(i.eta_local)}`}</Chip>
                  {i.is_international && <Chip tone="tfr">Customs</Chip>}
                </div>
                <div className="mt-0.5 truncate text-[11.5px] text-ink-2">{i.reasons[0]}</div>
              </div>
              <div className="text-right">
                <div className="num text-[13px] font-semibold">{i.score.toFixed(2)}</div>
                <div className="text-[10.5px] text-ink-2">{i.party_size} pax · {i.hotel_zone}</div>
              </div>
            </button>
            {open === i.booking_code && (
              <div className="mt-3 border-t border-hairline pt-3">
                <ul className="mb-3 list-disc space-y-1 pl-5 text-[12px] text-ink">
                  {i.reasons.map((r) => <li key={r}>{r}</li>)}
                </ul>
                <div className="mb-3 grid grid-cols-4 gap-2">
                  {Object.entries(i.components).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-[10px] text-ink-2">{k.replace("_", " ")}</div>
                      <div className="mt-1 h-1.5 rounded-full bg-ink/[0.06]"><div className="h-full rounded-full bg-runway" style={{ width: `${v * 100}%` }} /></div>
                    </div>
                  ))}
                </div>
                <ApproveBar target={`ground:${i.booking_code}`} approverRole="Ground dispatcher" compact />
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-ink-2">Booking codes only. Bookings in this demo are synthetic.</p>
    </Panel>
  );
}
