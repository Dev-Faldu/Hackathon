import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight, CalendarCheck, CheckCircle2, CircleAlert, Clock3, FileJson, Inbox as InboxIcon, Link2, Loader2, PlaneLanding, Send, Sparkles, Timer, XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TopBar } from "../components/Shell";
import { Chip, Disclosure, ErrorNote, InfoTip, Kpi, KpiRow, Panel, Segmented, Skeleton } from "../components/ui";
import { api, useApi } from "../lib/api";
import { cx, dayShort, fmt, hhmm, SIZE_COLOR, SIZE_LABEL } from "../lib/format";
import { useApp } from "../lib/store";
import type { BookingQuote, InboxItem, TripRequest } from "../lib/types";

const CHANNELS = ["FlightBridge", "Scheduler export", "Email", "Phone", "FBO portal"];

// Ready-made requests for a quick walkthrough; each one shows a different answer.
const PRESETS: { label: string; req: TripRequest }[] = [
  { label: "Quiet Wednesday night", req: { aircraft_type: "CL35", tail: "N350RC", origin: "KTEB", arrive_local: "2027-02-10T16:00", depart_local: "2027-02-11T10:00", services: ["Fuel", "GPU"], channel: "FlightBridge" } },
  { label: "Game weekend, large cabin", req: { aircraft_type: "GLF6", tail: "N650SB", origin: "KHPN", arrive_local: "2027-02-12T15:00", depart_local: "2027-02-15T11:00", services: ["Fuel", "Lav", "Catering", "Car to the aircraft"], channel: "FlightBridge" } },
  { label: "Drop-and-go on game day", req: { aircraft_type: "E55P", tail: "N300LV", origin: "KLAS", arrive_local: "2027-02-14T11:00", depart_local: "2027-02-14T12:30", services: ["Car to the aircraft"], channel: "Scheduler export" } },
  { label: "International, Wednesday morning", req: { aircraft_type: "GLEX", tail: "C-GLBX", origin: "CYYZ", international: true, arrive_local: "2027-02-10T10:00", depart_local: "2027-02-11T09:00", services: ["Customs", "Fuel"], channel: "Email" } },
];

const DECISION = {
  confirmed: { label: "Confirmed", tone: "ok" as const, icon: <CheckCircle2 size={18} /> },
  approval: { label: "Needs a supervisor's OK", tone: "watch" as const, icon: <CircleAlert size={18} /> },
  full: { label: "No space for this stay", tone: "alert" as const, icon: <XCircle size={18} /> },
  invalid: { label: "Check the times", tone: "alert" as const, icon: <XCircle size={18} /> },
};

export default function Bookings() {
  const { tIso, toast, layout, setLayout, go, setFocusFlight } = useApp();
  const meta = useApi(() => api.bookingMeta(), []);
  const [placedV, setPlacedV] = useState(0);
  const inbox = useApi(() => api.bookingInbox(tIso, layout), [tIso.slice(0, 13), layout, placedV]);
  const [req, setReq] = useState<TripRequest>(PRESETS[0].req);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Record<string, unknown> | null>(null);
  const [placed, setPlaced] = useState<{ flightId: string; position: string; etaMs: number } | null>(null);
  const [filter, setFilter] = useState<"look" | "all">("look");

  const types = meta.data?.aircraft_types ?? [];
  const type = types.find((x) => x.code === req.aircraft_type);
  const ask = async (r: TripRequest = req) => {
    setBusy(true); setSent(null); setPlaced(null);
    try { setQuote(await api.bookingQuote({ ...r, t: tIso, layout })); } catch (e) { toast({ title: "Could not get an answer", body: String(e).slice(0, 120), tone: "alert" }); }
    setBusy(false);
  };
  useEffect(() => { void ask(req); }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async () => {
    if (!quote) return;
    try {
      const r = await api.bookingAccept(quote.trip_sheet, layout, req.channel ?? "FBO portal", tIso);
      setSent(r.trip_sheet);
      setPlaced({ flightId: r.flight_id, position: r.position, etaMs: Date.parse(String(quote.trip_sheet.eta_local)) });
      setPlacedV((v) => v + 1);
      toast({ title: `${r.flight_id} placed on ${r.position}`, body: `Sent back to ${req.channel ?? "the operator"} · in the ramp plan and the 3D airfield`, tone: "ok" });
    } catch (e) { toast({ title: "Could not place the jet", body: String(e).slice(0, 120), tone: "alert" }); }
  };
  const cancel = async () => {
    if (!placed) return;
    await api.bookingCancel(placed.flightId);
    toast({ title: `Booking for ${placed.flightId} cancelled`, body: `${placed.position} is free again`, tone: "info" });
    setPlaced(null); setSent(null); setPlacedV((v) => v + 1);
  };
  const watch = () => {
    if (!placed) return;
    setFocusFlight({ id: placed.flightId, tMs: placed.etaMs });
    go("world");
  };

  const box = inbox.data;
  const items = useMemo(() => (box?.items ?? []).filter((i) => filter === "all" || i.status === "look"), [box, filter]);

  return (
    <div>
      <TopBar title="Book event parking in minutes, not months"
        subtitle="A trip request from FlightBridge, a scheduler, email or the phone is checked against the live ramp plan in under a second. A person only sees the ones that need judgement." />

      {/* The gap, in one line; the detail on demand */}
      <Disclosure className="mb-5 bg-white/70" summary={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <Chip tone="tfr">Why operators book months ahead</Chip>
          <span className="text-ink">Nobody can check live ramp space when a request comes in, so FBOs sell event parking early and keep a buffer.</span>
        </div>}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Flow title="Today" tone="alert" steps={["Scheduler (FL3XX, Avianis…)", "FlightBridge trip request", "FBO email or portal", "Someone checks the ramp by hand", "Confirmation, often days later"]} />
          <Flow title="With RAMPCAST" tone="ok" steps={["Scheduler", "FlightBridge trip request", "RAMPCAST checks live ramp + forecast", "Answer in under a second", "Position and services back on the trip"]} />
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>FlightBridge already syncs service items (fuel, hangar, GPU, lav, water) into FBO systems such as Total FBO and FBO Director. Some syncs run in batch once a request is confirmed, and activation goes through FlightBridge support. None of them checks ramp space.</li>
          <li>For Super Bowl LIII, Atlanta-area FBOs opened parking reservations about two months ahead, charged about $1,500–1,700, and were close to sold out days before.</li>
          <li>RAMPCAST does not replace FlightBridge. It answers the one question the chain cannot: is there room for this jet, for this stay, right now?</li>
        </ul>
        <p className="mt-2 text-[11px] text-ink-3">Sources: FlightBridge help centre (software integration partners, Total FBO and FBO Director integration pages); AIN, “Super Bowl Kicks Off at Atlanta-area FBOs”, 31 Jan 2019.</p>
      </Disclosure>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Request form */}
        <Panel strong eyebrow="New trip request" title="What the operator sends"
          actions={<Chip tone="runway"><Link2 size={12} /> Same fields as a trip sheet</Chip>}>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.label} onClick={() => { setReq(p.req); void ask(p.req); }}
                className={cx("rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition",
                  req === p.req ? "border-runway/30 bg-runway/10 text-runway" : "border-hairline bg-white/70 text-ink-2 hover:text-ink")}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tail number"><input className="inp" value={req.tail ?? ""} onChange={(e) => setReq({ ...req, tail: e.target.value.toUpperCase() })} placeholder="N123AB" /></Field>
            <Field label="Aircraft">
              <select className="inp" value={req.aircraft_type ?? ""} onChange={(e) => setReq({ ...req, aircraft_type: e.target.value })}>
                {types.map((t) => <option key={t.code} value={t.code}>{t.name} · {SIZE_LABEL[t.size_class]}</option>)}
              </select>
            </Field>
            <Field label="Arrive (local)"><input type="datetime-local" className="inp" value={req.arrive_local} onChange={(e) => setReq({ ...req, arrive_local: e.target.value })} /></Field>
            <Field label="Depart (local)"><input type="datetime-local" className="inp" value={req.depart_local} onChange={(e) => setReq({ ...req, depart_local: e.target.value })} /></Field>
            <Field label="From"><input className="inp" value={req.origin ?? ""} onChange={(e) => setReq({ ...req, origin: e.target.value.toUpperCase() })} placeholder="KTEB" /></Field>
            <Field label="Came in through">
              <select className="inp" value={req.channel} onChange={(e) => setReq({ ...req, channel: e.target.value })}>
                {CHANNELS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-[12.5px] text-ink">
            <input type="checkbox" checked={!!req.international} onChange={(e) => setReq({ ...req, international: e.target.checked })} className="h-4 w-4 accent-[#2563EB]" />
            Arriving from outside the US (needs customs)
          </label>
          <div className="mt-3">
            <div className="label mb-1.5">Services</div>
            <div className="flex flex-wrap gap-1.5">
              {(meta.data?.services ?? []).map((s) => {
                const on = req.services?.includes(s);
                return (
                  <button key={s} onClick={() => setReq({ ...req, services: on ? req.services!.filter((x) => x !== s) : [...(req.services ?? []), s] })}
                    className={cx("rounded-full border px-2.5 py-1 text-[12px] transition", on ? "border-runway/30 bg-runway/10 text-runway" : "border-hairline bg-white/70 text-ink-2")}>
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-[12px] text-ink-2">{type ? <>Parks as <b style={{ color: SIZE_COLOR[type.size_class] }}>{SIZE_LABEL[type.size_class]}</b></> : "Pick an aircraft"}</span>
            <button onClick={() => ask()} disabled={busy} className="btn-primary">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Get the answer
            </button>
          </div>
        </Panel>

        {/* Answer */}
        <Panel eyebrow={<span>Answer · against the {layout === "tandem" ? "game-day tandem" : "marked-stand"} ramp</span>}
          title={quote ? `Request ${quote.request_id}` : "Waiting for a request"}
          actions={<>
            <Segmented size="sm" value={layout} onChange={setLayout} options={[{ value: "tandem", label: "Game day" }, { value: "stands", label: "Marked" }]} />
            {quote && <Chip><Timer size={12} /> Answered in <span className="num">{quote.answer_ms < 1 ? "<1" : fmt(quote.answer_ms)}</span> ms</Chip>}
          </>}>
          {!quote ? <Skeleton className="h-[360px] w-full" /> : (
            <AnimatePresence mode="wait">
              <motion.div key={quote.request_id + quote.decision} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                <div className={cx("flex items-start gap-3 rounded-[16px] border p-4",
                  quote.decision === "confirmed" ? "border-ok/25 bg-ok/10" : quote.decision === "approval" ? "border-watch/30 bg-watch/10" : "border-alert/25 bg-alert/5")}>
                  <span className={cx("mt-0.5", quote.decision === "confirmed" ? "text-ok" : quote.decision === "approval" ? "text-[#B45309]" : "text-alert")}>{DECISION[quote.decision].icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[16px] font-semibold text-ink">{DECISION[quote.decision].label}</div>
                    <div className="text-[13px] text-ink-2">{quote.headline}</div>
                  </div>
                  {quote.price_usd > 0 && (
                    <div className="text-right">
                      <div className="num text-[22px] font-semibold text-ink">${fmt(quote.price_usd)}</div>
                      <div className="text-[11px] text-ink-2">{quote.event_rates ? "event-week rate" : "standard rate"}</div>
                    </div>
                  )}
                </div>

                {quote.hold_expires_local && quote.decision !== "full" && (
                  <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-2"><Clock3 size={13} /> Held for the operator until {hhmm(quote.hold_expires_local)} {dayShort(quote.hold_expires_local)}. After that the space goes back on sale.</p>
                )}

                <div className="mt-3 space-y-1.5">
                  {quote.checks.map((c) => (
                    <div key={c.label} className="flex items-start gap-2 text-[12.5px]">
                      {c.ok ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" /> : <CircleAlert size={15} className="mt-0.5 shrink-0 text-[#B45309]" />}
                      <span><b className="font-medium text-ink">{c.label}.</b> <span className="text-ink-2">{c.detail}</span></span>
                    </div>
                  ))}
                </div>

                {quote.alternatives.length > 0 && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {quote.alternatives.map((a) => (
                      <div key={a.kind} className="rounded-[14px] border border-hairline bg-white/70 px-3 py-2">
                        <div className="text-[12.5px] font-medium text-ink">{a.label}</div>
                        <div className="text-[12px] leading-snug text-ink-2">{a.detail}</div>
                      </div>
                    ))}
                  </div>
                )}

                {quote.price_lines.length > 0 && (
                  <Disclosure className="mt-3" summary={<span className="text-[12.5px] text-ink">How the price is worked out</span>}>
                    {quote.price_lines.map((l) => <div key={l.label} className="flex justify-between"><span>{l.label}</span><span className="num">${fmt(l.usd)}</span></div>)}
                    <p className="mt-1.5 text-[11px] text-ink-3">Rates from parking_fees_usd in assumptions.yaml (fictional FBO). Services are billed at the FBO's posted prices.</p>
                  </Disclosure>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {placed ? (
                    <>
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-ok"><CheckCircle2 size={15} /> {placed.flightId} is on the ramp plan at {placed.position}</span>
                      <button onClick={watch} className="btn-primary"><PlaneLanding size={14} /> Watch it land in 3D</button>
                      <button onClick={cancel} className="btn-ghost">Cancel booking</button>
                    </>
                  ) : (
                    <>
                      {quote.decision === "confirmed" && <button onClick={accept} className="btn-primary"><Send size={14} /> Accept and send back</button>}
                      {quote.decision === "approval" && <button onClick={accept} className="btn-primary"><CheckCircle2 size={14} /> Supervisor approves and sends</button>}
                    </>
                  )}
                  {quote.decision === "full" && <span className="text-[12px] text-ink-2">Offer one of the options above. Nothing is booked until the operator picks one.</span>}
                </div>
                {sent && (
                  <Disclosure className="mt-3" defaultOpen summary={<span className="flex items-center gap-2 text-[12.5px] text-ink"><FileJson size={14} className="text-runway" /> Sent back on the trip sheet</span>}>
                    <pre className="num max-h-[220px] overflow-auto whitespace-pre-wrap text-[11px] leading-snug text-ink">{JSON.stringify(sent, null, 2)}</pre>
                  </Disclosure>
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </Panel>
      </div>

      {/* One inbox for every channel */}
      <KpiRow keep={3} className="mt-5">
        <Kpi label="Requests received" value={box?.total ?? 0} tone="runway" sub="By the replay time, all channels"
          info={{ what: "Every parking request received so far for this week, from FlightBridge, schedulers, email, phone and the FBO portal. Duplicates count separately.", source: "Rebuilt from the replay week's flights; channel mix and lead times are assumptions in assumptions.yaml (bookings)." }} />
        <Kpi label="Answered automatically" value={box ? Math.round((box.auto / Math.max(1, box.total)) * 100) : 0} unit="%" tone="ok"
          sub={box ? <><span className="num">{box.auto}</span> needed nobody</> : "…"}
          info={{ what: "Requests that fit the ramp plan with nothing to check: no duplicate, no aircraft change, no customs problem, space for the whole stay." }} />
        <Kpi label="Need a person" value={box?.look ?? 0} tone="watch" sub="Overbooked stays, duplicates, aircraft swaps"
          info={{ what: "Requests a person must decide on. Each one says why in plain words below." }} />
        <Kpi label="Booked ahead (median)" value={box?.median_lead_days ?? 0} digits={1} unit="days"
          sub="How early requests arrive today"
          info={{ what: "Half of this week's requests arrived more than this many days before landing. Event stays come in weeks ahead.", source: "Lead-time ranges in assumptions.yaml (bookings.lead_days)." }} />
      </KpiRow>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel eyebrow="One inbox for every channel" title="Incoming requests"
          actions={<Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: "look", label: "Need a person" }, { value: "all", label: "All" }]} />}>
          {inbox.error && <ErrorNote error={inbox.error} onRetry={inbox.reload} />}
          {!box ? <Skeleton className="h-[300px] w-full" /> : (
            <>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {Object.entries(box.by_channel).sort((a, b) => b[1] - a[1]).map(([c, n]) => <Chip key={c}>{c} <span className="num">{n}</span></Chip>)}
              </div>
              <div className="max-h-[520px] space-y-1.5 overflow-auto pr-1">
                {items.slice(0, 40).map((i) => <InboxRow key={i.request_id} item={i} />)}
                {items.length === 0 && <p className="py-6 text-center text-[13px] text-ink-2">Nothing needs a person right now.</p>}
              </div>
              <p className="mt-2 text-[11px] text-ink-3">{box.note}</p>
            </>
          )}
        </Panel>

        <Panel eyebrow="Connections" title="How it plugs into the tools FBOs already use"
          actions={<InfoTip what="No partner credentials are used in this build. Statuses say exactly what works today and what needs a partner agreement." />}>
          {!meta.data ? <Skeleton className="h-[300px] w-full" /> : (
            <div className="space-y-2">
              {meta.data.connections.map((c) => (
                <Disclosure key={c.name} summary={
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink">{c.name}</span>
                      <Chip tone={c.status.startsWith("Live") ? "ok" : c.status.startsWith("Needs") ? "watch" : "neutral"}>{c.status}</Chip>
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-2">{c.kind} · {c.flow}</div>
                  </div>}>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div><div className="label mb-0.5">Today</div>{c.today}</div>
                    <div><div className="label mb-0.5">With RAMPCAST</div>{c.with_rampcast}</div>
                  </div>
                </Disclosure>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const first = item.issues[0]?.text ?? item.notes[0] ?? (item.position ? `Confirmed on ${item.position}.` : "Confirmed.");
  return (
    <Disclosure tone={item.status === "look" ? "look" : undefined} summary={
      <div className="flex min-w-0 items-center gap-3">
        <span className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-full", item.status === "look" ? "bg-watch/15 text-[#B45309]" : "bg-ok/12 text-ok")}>
          {item.status === "look" ? <CircleAlert size={15} /> : <CalendarCheck size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-[12.5px]">
            <span className="num font-semibold text-ink">{item.flight}</span>
            <span className="text-ink-2">{SIZE_LABEL[item.size_class]}</span>
            <span className="flex items-center gap-1 text-ink-2"><PlaneLanding size={12} /> {dayShort(item.eta_local)} {hhmm(item.eta_local)}</span>
            <Chip className="ml-auto">{item.channel}</Chip>
          </div>
          <div className="truncate text-[12px] text-ink-2">{first}</div>
        </div>
      </div>}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <Fact label="Request" value={item.request_id} />
        <Fact label="Received" value={`${dayShort(item.received_local)} ${hhmm(item.received_local)}`} />
        <Fact label="Booked ahead" value={`${item.lead_days} days`} />
        <Fact label="From" value={item.origin || "—"} />
        <Fact label="Arrives" value={`${dayShort(item.eta_local)} ${hhmm(item.eta_local)}`} />
        <Fact label="Departs" value={`${dayShort(item.etd_local)} ${hhmm(item.etd_local)}`} />
        <Fact label="Position" value={item.position ?? "none in plan"} />
        <Fact label="Status" value={item.status === "look" ? "Needs a person" : "Answered automatically"} />
      </div>
      {[...item.issues.map((x) => x.text), ...item.notes].map((t) => (
        <p key={t} className="mt-1.5 flex items-start gap-1.5"><ArrowRight size={13} className="mt-0.5 shrink-0 text-runway" /> {t}</p>
      ))}
    </Disclosure>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><div className="label">{label}</div><div className="num text-[12px] text-ink">{value}</div></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1"><span className="label">{label}</span>{children}</label>;
}

function Flow({ title, steps, tone }: { title: string; steps: string[]; tone: "ok" | "alert" }) {
  return (
    <div className={cx("rounded-[14px] border p-3", tone === "ok" ? "border-ok/25 bg-ok/5" : "border-alert/20 bg-alert/5")}>
      <div className={cx("mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold", tone === "ok" ? "text-ok" : "text-alert")}>
        {tone === "ok" ? <CheckCircle2 size={14} /> : <InboxIcon size={14} />} {title}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {steps.map((s, i) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="rounded-full border border-hairline bg-white/80 px-2 py-0.5 text-[11.5px] text-ink">{s}</span>
            {i < steps.length - 1 && <ArrowRight size={12} className="text-ink-3" />}
          </span>
        ))}
      </div>
    </div>
  );
}
