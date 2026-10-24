import { AnimatePresence, motion } from "framer-motion";
import { ArrowRightLeft, CheckCircle2, CircleDollarSign, Clock, MousePointerClick, PlaneLanding, PlaneTakeoff, Shuffle, SquareParking, Truck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApronMap, StandGantt } from "../components/apron";
import { ReplayBar, TopBar } from "../components/Shell";
import { ApproveBar, Chip, ErrorNote, Kpi, Panel, Segmented, Skeleton } from "../components/ui";
import { api, useApi } from "../lib/api";
import { cx, dayLabel, dayShort, fmt, hhmm, SIZE_COLOR, SIZE_LABEL } from "../lib/format";
import { useApp, useReplayTick } from "../lib/store";
import type { AssignResult, Occupant, ParkingMethod, ParkingPlan, Reservation } from "../lib/types";

export default function Parking() {
  const { tMs, tIso, toast, bumpDecisions } = useApp();
  const [method, setMethod] = useState<ParkingMethod>("optimized");
  const [temp, setTemp] = useState(false);
  const [pinsV, setPinsV] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const tick = useReplayTick(10);
  const day = tIso.slice(0, 10);
  const [boardDay, setBoardDay] = useState(day);
  useEffect(() => setBoardDay(day), [day]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const plan = useApi(() => api.parkingPlan(method, temp), [method, temp, pinsV]);
  const st = useApi(() => api.parkingState(tick.bucketIso, method, temp), [tick.bucketMs, method, temp, pinsV]);
  const res = useApi(() => api.reservations(boardDay, method, temp), [boardDay, method, temp, pinsV]);
  const m = plan.data?.metrics, cmp = plan.data?.compare;
  const opt = method === "optimized" ? m : cmp, base = method === "optimized" ? cmp : m;
  const towCut = opt && base && base.tows ? Math.round((1 - opt.tows / base.tows) * 100) : 0;
  const towSoon = useMemo(() => new Set((st.data?.tows_next_3h ?? []).map((t) => t.flight_id)), [st.data]);
  const selOcc = st.data?.occupants.find((o) => o.flight_id === selected) ?? null;

  return (
    <div>
      <TopBar title="Parking control" subtitle="Where every jet parks, what must be towed, and how full the ramp gets. The line supervisor approves every move.">
        <button onClick={() => setTemp(!temp)}
          className={cx("btn-ghost", temp && "border-tfr/40 bg-tfr/10 text-tfr")} title="Open 12 temporary taxiway stands (strategy C)">
          <span className={cx("inline-block h-2 w-2 rounded-full", temp ? "bg-tfr" : "bg-ink-3")} /> Temp zone {temp ? "open" : "closed"}
        </button>
        <Segmented value={method} onChange={setMethod}
          options={[{ value: "optimized", label: <span className="flex items-center gap-1.5"><Shuffle size={13} /> RAMPCAST arrangement</span> },
            { value: "first_come", label: "Whiteboard (first free)" }]} />
      </TopBar>
      <ReplayBar />
      {plan.error && <div className="mt-4"><ErrorNote error={plan.error} onRetry={plan.reload} /></div>}

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        <Kpi label="Stands in use now" value={st.data?.stands_used ?? 0} unit={`/ ${m?.stands ?? 48}`}
          tone={st.data && st.data.stands_used >= (m?.stands ?? 48) ? "alert" : "runway"}
          sub={st.data ? `${st.data.hot_used} on hot spots · ${st.data.temp_used} temp · ${st.data.overflow_now} without a position` : "…"} />
        <Kpi label="Tows this week" value={m?.tows ?? 0} tone={method === "optimized" ? "ok" : "alert"}
          sub={opt && base ? <span>RAMPCAST <b className="num">{opt.tows}</b> vs whiteboard <b className="num">{base.tows}</b> · <span className="font-semibold text-ok">−{towCut}%</span></span> : "…"} />
        <Kpi label="Boxed-in events" value={m?.boxed_in_events ?? 0} tone={method === "optimized" ? "ok" : "watch"}
          sub={method === "optimized" && m?.solver?.startsWith("cp-sat")
            ? "CP-SAT plan: nobody boxed in is a hard rule (only your manual moves can break it)"
            : "A jet stuck behind one leaving later"} />
        <Kpi label="Overflow aircraft" value={m?.overflow_aircraft ?? 0} tone={(m?.overflow_aircraft ?? 0) > 0 ? "alert" : "ok"}
          sub={`Live week: no stand fits without boxing a jet in${temp ? " · temp zone open" : ". Open the temp zone to absorb more"}`} />
        <Kpi label="Hot-spot turns" value={m?.hot_spot_uses ?? 0} sub="Drop-and-go kept off the stands" />
        <Kpi label="Parking revenue (est.)" value={(m?.revenue_est_usd ?? 0) / 1000} digits={1} unit="k USD" sub={`${m?.utilization_pct ?? 0}% stand utilization · fees in assumptions`} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel eyebrow={<span className="flex items-center gap-1.5"><SquareParking size={12} /> Apron · {dayLabel(tIso)} {hhmm(tIso)}</span>}
          title={method === "optimized" ? "RAMPCAST arrangement: long stays deep, quick turns up front" : "Whiteboard: first free stand that fits"}
          actions={<Chip><MousePointerClick size={12} /> Click a jet to inspect or move it</Chip>}>
          {plan.data && st.data ? (
            <ApronMap positions={plan.data.positions} occupants={st.data.occupants} towSoon={towSoon} nowMs={tMs}
              selected={selected} onSelect={(f) => setSelected(f)} tempZone={temp} overflowNow={st.data.overflow_now} />
          ) : <Skeleton className="aspect-[1000/770] w-full" />}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
            {(["light", "mid", "super_mid", "large"] as const).map((k) => (
              <span key={k} className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: SIZE_COLOR[k] }} />{SIZE_LABEL[k]}</span>
            ))}
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-4 rounded-[3px] border-2 border-dashed border-watch" />Tow in next 3 h</span>
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-4 rounded-[3px] border-2 border-ok" />Departing within 1 h</span>
            <span>Jets drawn to wingspan scale</span>
          </div>
        </Panel>

        <NextMoves st={st.data} loading={st.loading && !st.data} onSelect={setSelected} />
      </div>

      <AnimatePresence>
        {selected && (
          <motion.div key="inspector" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="fixed bottom-5 right-5 top-5 z-40 w-[400px] max-w-[calc(100vw-2.5rem)] overflow-auto rounded-panel shadow-lift">
            <Inspector flightId={selected} occ={selOcc} plan={plan.data} onClose={() => setSelected(null)}
              onMoved={() => { setPinsV((v) => v + 1); bumpDecisions(); }} tIso={tIso} toast={toast} />
          </motion.div>
        )}
      </AnimatePresence>

      <Panel className="mt-5" eyebrow="Stand allocation chart · whole week" title="Every stand, every stay"
        actions={<>{plan.data && Object.keys(plan.data.pins).length > 0 && <Chip tone="runway">{Object.keys(plan.data.pins).length} manual placements</Chip>}
          <Chip tone="watch">Amber outline: tow involved</Chip></>}>
        <div className="max-h-[540px] overflow-auto pr-1">
          {plan.data ? <StandGantt rows={plan.data.gantt} windowDays={plan.data.window} nowMs={tMs} selected={selected} onSelect={setSelected} tempZone={temp} />
            : <Skeleton className="h-[400px]" />}
        </div>
      </Panel>

      <ReservationBoard day={boardDay} setDay={setBoardDay} days={plan.data?.window ?? []} items={res.data?.items ?? []}
        loading={res.loading && !res.data} onSelect={setSelected} />
    </div>
  );
}

function Inspector({ flightId, occ, plan, onClose, onMoved, tIso, toast }: {
  flightId: string; occ: Occupant | null; plan: ParkingPlan | null; onClose: () => void; onMoved: () => void; tIso: string;
  toast: (t: { title: string; body?: string; tone?: "ok" | "info" | "alert" }) => void;
}) {
  const bar = useMemo(() => {
    for (const r of plan?.gantt ?? []) {
      const b = r.bars.find((x) => x.flight_id === flightId);
      if (b) return { ...b, position: r.position };
    }
    return null;
  }, [plan, flightId]);
  const [target, setTarget] = useState("");
  const [check, setCheck] = useState<AssignResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTarget(""); setCheck(null); }, [flightId]);
  if (!bar) return null;
  const pinned = plan?.pins[flightId];
  const run = async (confirm: boolean) => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api.assign(flightId, target, confirm, tIso);
      setCheck(r);
      if (confirm && r.confirmed) {
        toast({ title: `${flightId} moved to ${target}`, body: `Tows this week ${r.tows_before} → ${r.tows_after} · logged`, tone: "ok" });
        onMoved();
      }
    } finally { setBusy(false); }
  };
  return (
    <Panel strong className="min-h-full" eyebrow="Selected aircraft" title={`${bar.flight_id} · ${bar.booking_code ?? "no booking"}`}
      actions={<button onClick={onClose} className="rounded-full p-1 text-ink-2 hover:bg-white" aria-label="Close"><X size={16} /></button>}>
      <div className="flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-[14px]" style={{ background: SIZE_COLOR[bar.size_class] + "22" }}>
          <svg viewBox="0 0 100 100" className="h-9 w-9 -rotate-90"><path d="M96,50 C96,47 93,45.6 88,45.6 L22,45.6 L9,44 L5,47 L5,53 L9,56 L22,54.4 L88,54.4 C93,54.4 96,53 96,50 Z M60,45.6 L43,5 L35,5 L42,45.6 Z M60,54.4 L43,95 L35,95 L42,54.4 Z M19,45.6 L10,31 L6,31 L10,45.6 Z M19,54.4 L10,69 L6,69 L10,54.4 Z" fill={SIZE_COLOR[bar.size_class]} /></svg>
        </div>
        <div className="min-w-0 text-[12.5px]">
          <div className="font-semibold">{SIZE_LABEL[bar.size_class]} from {bar.origin}</div>
          <div className="text-ink-2">{bar.stay_type.replace(/_/g, " ")} · {occ ? `${occ.wingspan_ft} ft span` : ""}</div>
        </div>
        <Chip tone={bar.position === "OVERFLOW" ? "alert" : "runway"} className="ml-auto">{bar.position === "OVERFLOW" ? "No position" : bar.position}</Chip>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
        <div className="rounded-control border border-hairline bg-white/60 px-3 py-2"><div className="label">Arrives</div><div className="num mt-0.5 font-semibold">{dayShort(bar.start)} {hhmm(bar.start)}</div></div>
        <div className="rounded-control border border-hairline bg-white/60 px-3 py-2"><div className="label">Departs</div><div className="num mt-0.5 font-semibold">{dayShort(bar.end)} {hhmm(bar.end)}</div></div>
      </div>
      {occ && occ.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12.5px]">
          {occ.reasons.map((r) => <li key={r} className="flex gap-2"><CheckCircle2 size={14} className="mt-0.5 shrink-0 text-runway" />{r}</li>)}
        </ul>
      )}
      <div className="mt-4 border-t border-hairline pt-3">
        <div className="label mb-2 flex items-center gap-1.5"><ArrowRightLeft size={12} /> Move to another position</div>
        <div className="flex gap-2">
          <select id="move-target" value={target} onChange={(e) => { setTarget(e.target.value); setCheck(null); }}
            className="min-w-0 flex-1 rounded-control border border-hairline bg-white/80 px-2.5 py-2 text-[13px]">
            <option value="">Choose a stand…</option>
            {["A", "B", "C", "D"].map((row) => (
              <optgroup key={row} label={`Row ${row}`}>
                {plan?.positions.filter((p) => p.kind === "stand" && p.row === row).map((p) => (
                  <option key={p.id} value={p.id}>{p.id} · depth {p.depth} · ≤{p.max_wingspan_ft} ft</option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Hot spots (≤3 h)">{plan?.positions.filter((p) => p.kind === "hot").map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</optgroup>
          </select>
          <button className="btn-ghost" disabled={!target || busy} onClick={() => run(false)}>Check</button>
        </div>
        {check && (
          <div className={cx("mt-2 rounded-control border px-3 py-2 text-[12px]", check.ok ? "border-ok/25 bg-ok/5" : "border-alert/25 bg-alert/5")}>
            {check.ok ? (
              <div className="flex items-center justify-between gap-2">
                <span>Fits. Week tows <b className="num">{check.tows_before}</b> → <b className={cx("num", (check.tows_after ?? 0) > (check.tows_before ?? 0) ? "text-alert" : "text-ok")}>{check.tows_after}</b></span>
                {!check.confirmed && <button className="btn-primary px-2.5 py-1.5 text-[12px]" disabled={busy} onClick={() => run(true)}>Confirm move</button>}
                {check.confirmed && <span className="font-medium text-ok">Moved · logged</span>}
              </div>
            ) : (
              <ul className="list-disc pl-4 text-alert">{check.issues.map((i) => <li key={i}>{i}</li>)}</ul>
            )}
          </div>
        )}
        {pinned && <p className="mt-2 text-[11.5px] text-ink-2">Manually placed at {pinned}. Everyone else is re-arranged around it.</p>}
      </div>
    </Panel>
  );
}

function NextMoves({ st, loading, onSelect }: { st: import("../lib/types").ParkingState | null; loading: boolean; onSelect: (f: string) => void }) {
  return (
    <Panel eyebrow={<span className="flex items-center gap-1.5"><Clock size={12} /> Next 3 hours</span>} title="Tow sheet and movements" bodyClass="max-h-[860px] overflow-auto">
      {loading && <Skeleton className="h-40" />}
      {st && (
        <div className="space-y-4">
          <section>
            <div className="label mb-2 flex items-center gap-1.5"><Truck size={12} /> Tows ({st.tows_next_3h.length})</div>
            {st.tows_next_3h.length === 0 && <p className="text-[12.5px] text-ink-2">No tows needed. Every jet can get in and out on its own.</p>}
            <ul className="space-y-2">
              {st.tows_next_3h.slice(0, 6).map((t, i) => (
                <li key={i} className="rounded-control border border-watch/25 bg-watch/[0.05] p-2.5 text-[12px]">
                  <div className="flex items-center justify-between">
                    <button className="num font-semibold hover:underline" onClick={() => onSelect(t.flight_id)}>{hhmm(t.t_local)} · {t.flight_id}</button>
                    <Chip tone="watch">{t.from} out and back</Chip>
                  </div>
                  <div className="mt-1 text-ink-2">{t.reason}</div>
                  <div className="mt-2"><ApproveBar target={`tow:${t.flight_id}:${t.t_local}`} approverRole="Line supervisor" compact /></div>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <div className="label mb-2 flex items-center gap-1.5"><PlaneLanding size={12} /> Arrivals ({st.arrivals_next_3h.length})</div>
            <ul className="divide-y divide-hairline">
              {st.arrivals_next_3h.slice(0, 8).map((a) => (
                <li key={a.flight_id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                  <span className="num w-11 text-ink-2">{hhmm(a.arrive_local)}</span>
                  <button className="num font-medium hover:underline" onClick={() => onSelect(a.flight_id)}>{a.flight_id}</button>
                  <span className="text-ink-2">{SIZE_LABEL[a.size_class]} · {a.origin}</span>
                  <Chip tone={a.position ? (a.position.startsWith("H") ? "runway" : "ok") : "alert"} className="ml-auto">{a.position ?? "Overflow"}</Chip>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <div className="label mb-2 flex items-center gap-1.5"><PlaneTakeoff size={12} /> Departures ({st.departures_next_3h.length})</div>
            <ul className="divide-y divide-hairline">
              {st.departures_next_3h.slice(0, 8).map((d) => (
                <li key={d.flight_id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                  <span className="num w-11 text-ink-2">{hhmm(d.depart_local)}</span>
                  <button className="num font-medium hover:underline" onClick={() => onSelect(d.flight_id)}>{d.flight_id}</button>
                  <span className="text-ink-2">{SIZE_LABEL[d.size_class]}</span>
                  <Chip className="ml-auto">{d.position ?? "—"}</Chip>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Panel>
  );
}

function ReservationBoard({ day, setDay, days, items, loading, onSelect }: {
  day: string; setDay: (d: string) => void; days: string[]; items: Reservation[]; loading: boolean; onSelect: (f: string) => void;
}) {
  const counts = { stand: 0, hot_spot: 0, temp: 0, overflow: 0 } as Record<Reservation["action"], number>;
  items.forEach((i) => { counts[i.action] += 1; });
  const tone = { stand: "ok", hot_spot: "runway", temp: "tfr", overflow: "alert" } as const;
  return (
    <Panel className="mt-5" eyebrow={<span className="flex items-center gap-1.5"><CircleDollarSign size={12} /> Reservation board</span>}
      title={`Where each arrival should park · ${dayLabel(day)}`}
      actions={<div className="flex flex-wrap gap-1">{days.map((d) => (
        <button key={d} onClick={() => setDay(d)}
          className={cx("rounded-full px-2.5 py-1 text-[11.5px] font-medium transition", d === day ? "bg-runway text-white" : "bg-white/70 text-ink-2 hover:text-ink",
            d === "2027-02-14" && d !== day && "text-tfr")}>{dayShort(d)} {d.slice(8)}</button>))}</div>}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Chip tone="ok">{counts.stand} stands</Chip><Chip tone="runway">{counts.hot_spot} hot spots</Chip>
        <Chip tone="tfr">{counts.temp} temporary</Chip><Chip tone="alert">{counts.overflow} overflow</Chip>
        <span className="text-[12px] text-ink-2">{items.length} arrivals · each placement explained</span>
      </div>
      {loading && <Skeleton className="h-40" />}
      <div className="max-h-[460px] overflow-auto">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-white/90 backdrop-blur">
            <tr className="text-left">{["Arrives", "Aircraft", "Stay", "Recommendation", "Why", "Tows", ""].map((h) => <th key={h} className="label py-2 pr-3 font-normal">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {items.map((r) => (
              <tr key={r.flight_id} className="align-top">
                <td className="num py-2 pr-3">{hhmm(r.arrive_local)}</td>
                <td className="py-2 pr-3">
                  <button className="num font-semibold hover:underline" onClick={() => onSelect(r.flight_id)}>{r.flight_id}</button>
                  <div className="text-[11.5px] text-ink-2">{SIZE_LABEL[r.size_class]} · {r.origin_name}</div>
                </td>
                <td className="num py-2 pr-3">{fmt(r.stay_h, 1)} h<div className="text-[11px] text-ink-2">out {dayShort(r.depart_local)} {hhmm(r.depart_local)}</div></td>
                <td className="py-2 pr-3"><Chip tone={tone[r.action]}>{r.label}</Chip></td>
                <td className="max-w-[360px] py-2 pr-3 text-ink-2">{r.reasons.join(" · ")}</td>
                <td className={cx("num py-2 pr-3", r.tows ? "font-semibold text-watch" : "text-ok")}>{r.tows}</td>
                <td className="py-2"><ApproveBar target={`parking:${r.flight_id}:${r.position ?? "overflow"}`} approverRole="FBO general manager" compact /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
