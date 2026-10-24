import { motion } from "framer-motion";
import {
  ArrowRight, Bot, CalendarCheck, Cpu, Dices, Hand, LineChart, ListOrdered, MessageSquareText, Route,
  ShieldAlert, Sparkles, Timer, Trophy, Workflow,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { TopBar, ReplayBar } from "../components/Shell";
import { Chip, Disclosure, ErrorNote, Fold, Glance, Panel, Segmented, Skeleton } from "../components/ui";
import { api, useApi } from "../lib/api";
import { cx, dayLabel, fmt, hhmm } from "../lib/format";
import { useApp, useReplayTick, type Screen } from "../lib/store";
import type { AiBenchmark, AiModel, AiRec, Layout, Urgency } from "../lib/types";

const URGENCY: Record<Urgency, { label: string; tone: "alert" | "watch" | "runway"; bar: string }> = {
  now: { label: "Now", tone: "alert", bar: "bg-alert" },
  today: { label: "Today", tone: "watch", bar: "bg-watch" },
  "this week": { label: "This week", tone: "runway", bar: "bg-runway" },
};

const FAMILY_ICON: Record<string, ReactNode> = {
  Forecasting: <LineChart size={14} />, Simulation: <Dices size={14} />, Optimization: <Cpu size={14} />,
  "Rules + search": <CalendarCheck size={14} />, Ranking: <ListOrdered size={14} />, Rules: <ShieldAlert size={14} />,
  Language: <MessageSquareText size={14} />,
};

const LABEL_TONE = { published: "ok", reconstructed: "watch", assumption: "neutral", live: "runway" } as const;
const LABEL_TEXT = { published: "Published", reconstructed: "Reconstructed", assumption: "Assumption", live: "Live" } as const;
const AUTOMATION = {
  automatic: { text: "Runs by itself", icon: <Bot size={12} /> },
  suggests: { text: "Suggests", icon: <Sparkles size={12} /> },
  "human approves": { text: "A person approves", icon: <Hand size={12} /> },
} as const;

// The order data flows through the product, left to right.
const PIPELINE: { id: string; short: string }[] = [
  { id: "forecast", short: "Forecast" }, { id: "ramp_mc", short: "Monte Carlo" }, { id: "strategies", short: "Strategy optimizer" },
  { id: "drift", short: "Departure drift" }, { id: "stand_default", short: "Stand planner" }, { id: "stand_cpsat", short: "CP-SAT solver" },
  { id: "booking", short: "Booking desk" }, { id: "alerts", short: "Rules" }, { id: "priority", short: "Priority queue" },
  { id: "runway", short: "Runway + 3D" }, { id: "explain", short: "Explanations" },
];

const scrollTo = (id: string) => document.getElementById(`model-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });

export default function Copilot() {
  const { scenario, layout, go, simple } = useApp();
  const tick = useReplayTick(15);
  const recs = useApi(() => api.aiRecommendations(scenario, layout, tick.bucketIso), [scenario, layout, tick.bucketMs]);
  const models = useApi(() => api.aiModels(scenario, layout), [scenario, layout]);
  const [benchLayout, setBenchLayout] = useState<Layout>(layout);
  const [benchTemp, setBenchTemp] = useState(false);
  const bench = useApi(() => api.aiBenchmark(benchLayout, benchTemp), [benchLayout, benchTemp]);
  const [lit, setLit] = useState<string | null>(null);
  const byId = Object.fromEntries((models.data?.models ?? []).map((m) => [m.id, m]));
  const r = recs.data;
  const pick = (id: string) => { setLit(id); scrollTo(id); window.setTimeout(() => setLit(null), 2200); };

  return (
    <div>
      <TopBar title="AI co-pilot" subtitle="Every model in one place: what needs doing, why, and who approves. Nothing happens until a person does." />
      <ReplayBar />
      {(recs.error || models.error) && <div className="mt-4"><ErrorNote error={(recs.error || models.error)!} onRetry={() => { recs.reload(); models.reload(); }} /></div>}

      <div className="mt-4">
        <Glance steps={["Read what needs doing", "Open the screen it points to", "Approve or change it"]}>
          {r ? <>At {dayLabel(r.t_local)} {hhmm(r.t_local)}, <b className="num">{r.counts.now}</b> thing{r.counts.now === 1 ? "" : "s"} need doing now,
            {" "}<b className="num">{r.counts.today}</b> today and <b className="num">{r.counts["this week"]}</b> this week.
            {" "}<b className="num">{r.models_consulted}</b> models were asked; each suggestion shows its numbers.</> : "Asking every model what needs doing…"}
        </Glance>
      </div>

      <Pipeline models={byId} onPick={pick} />

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <div className="label">Suggestions · {r ? `${dayLabel(r.t_local)} ${hhmm(r.t_local)}` : "…"}</div>
              <h2 className="text-[20px] font-semibold tracking-[-0.015em]">What needs doing</h2>
            </div>
            <p className="max-w-[320px] text-right text-[12px] text-ink-2">Ranked: act now, then today, then this week. They change as the replay clock moves.</p>
          </div>
          {r ? (
            r.items.length ? (
              <div className="space-y-3">
                {r.items.map((it, i) => <RecCard key={it.id} rec={it} i={i} models={byId} onModel={pick} onGo={() => go(it.screen as Screen)} />)}
              </div>
            ) : <div className="glass p-5 text-[13px] text-ink-2">Nothing needs doing at this time. Move the replay clock to the busy afternoon.</div>
          ) : <div className="space-y-3">{[0, 1, 2, 3].map((k) => <Skeleton key={k} className="h-[120px] w-full" />)}</div>}
        </section>

        <Arena bench={bench.data} loading={bench.loading} error={bench.error} layout={benchLayout} temp={benchTemp}
          setLayout={setBenchLayout} setTemp={setBenchTemp} onModel={pick} />
      </div>

      <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="label">Models and algorithms</div>
          <h2 className="text-[20px] font-semibold tracking-[-0.015em]">How every suggestion is made</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
          {(Object.keys(LABEL_TEXT) as (keyof typeof LABEL_TEXT)[]).map((k) => <Chip key={k} tone={LABEL_TONE[k]}>{LABEL_TEXT[k]}</Chip>)}
          <span className="text-ink-2">where each input comes from</span>
        </div>
      </div>
      {models.data ? (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {models.data.models.map((m) => <ModelCard key={m.id} m={m} lit={lit === m.id} simple={simple} />)}
        </div>
      ) : <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((k) => <Skeleton key={k} className="h-[260px]" />)}</div>}

      {models.data && models.data.validation.length > 0 && (
        <Fold className="mt-5" title="How the forecast was checked" summary="Leave-one-event-out on the published Super Bowl ratios, and plausibility against FBO reports">
          <Panel className="mt-5" eyebrow="Forecast validation · reports/validation_summary.csv" title="How the forecast was checked">
            <Validation rows={models.data.validation} />
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-2">{models.data.note} A daily backtest is not reported: the 2022 week in the data is
              reconstructed from published counts, so scoring the model on it would test its own assumptions.</p>
          </Panel>
        </Fold>
      )}
    </div>
  );
}

function Pipeline({ models, onPick }: { models: Record<string, AiModel>; onPick: (id: string) => void }) {
  return (
    <div className="glass mt-4 px-4 py-3">
      <div className="label mb-2 flex items-center gap-1.5"><Workflow size={12} /> How data flows: 2022 week → forecast → plans → the ramp</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full border border-watch/30 bg-watch/10 px-2.5 py-1 text-[12px] text-[#B45309]">2022 week, rebuilt from published counts</span>
        {PIPELINE.map((p) => {
          const m = models[p.id];
          return (
            <span key={p.id} className="flex items-center gap-1.5">
              <ArrowRight size={13} className="text-ink-3" />
              <button onClick={() => onPick(p.id)} title={m?.question}
                className={cx("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition hover:-translate-y-px hover:shadow-sm",
                  m?.status === "fallback" ? "border-watch/40 bg-watch/10 text-[#B45309]" : "border-hairline bg-white/80 text-ink")}>
                <span className="text-runway">{m ? FAMILY_ICON[m.family] : null}</span>{p.short}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function RecCard({ rec, i, models, onModel, onGo }: {
  rec: AiRec; i: number; models: Record<string, AiModel>; onModel: (id: string) => void; onGo: () => void;
}) {
  const u = URGENCY[rec.urgency];
  return (
    <motion.article initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.04 }}
      className="glass-strong relative overflow-hidden p-4 pl-5">
      <span className={cx("absolute inset-y-0 left-0 w-1", u.bar)} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Chip tone={u.tone}>{u.label}</Chip>
            {rec.numbers.map((n) => n.value != null && (
              <Chip key={n.label}><span className="text-ink-2">{n.label}</span> <b className="num text-ink">{typeof n.value === "number" ? fmt(n.value) : n.value}{n.unit ?? ""}</b></Chip>
            ))}
          </div>
          <h3 className="text-[15px] font-semibold leading-snug">{rec.title}</h3>
        </div>
        <button onClick={onGo} className="btn-ghost shrink-0 !py-1.5 text-[12.5px]">{rec.action} <ArrowRight size={13} /></button>
      </div>
      <ul className="mt-2 space-y-1 text-[12.5px] leading-snug text-ink-2">
        {rec.why.map((w, k) => <li key={k} className="flex gap-1.5"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{w}</li>)}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-hairline pt-2.5 text-[11.5px]">
        <span className="text-ink-2">From</span>
        {rec.models.map((id) => (
          <button key={id} onClick={() => onModel(id)}
            className="flex items-center gap-1 rounded-full border border-runway/20 bg-runway/[0.06] px-2 py-0.5 font-medium text-runway hover:bg-runway/10">
            {models[id] ? FAMILY_ICON[models[id].family] : null}{models[id]?.name ?? id}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-ink-2"><Hand size={12} /> Approves: <b className="text-ink">{rec.approver}</b></span>
      </div>
    </motion.article>
  );
}

function Arena({ bench, loading, error, layout, temp, setLayout, setTemp, onModel }: {
  bench: AiBenchmark | null; loading: boolean; error: string | null; layout: Layout; temp: boolean;
  setLayout: (l: Layout) => void; setTemp: (t: boolean) => void; onModel: (id: string) => void;
}) {
  const rows = bench?.rows ?? [];
  const maxTows = Math.max(1, ...rows.map((r) => r.tows));
  const MODEL = { first_come: null, optimized: "stand_default", cpsat: "stand_cpsat" } as const;
  return (
    <Panel eyebrow={<span className="flex items-center gap-1.5"><Trophy size={12} /> Algorithm arena · parking</span>}
      title="Three ways to park one week"
      actions={<Segmented size="sm" value={layout} onChange={setLayout} options={[{ value: "tandem", label: "Game day" }, { value: "stands", label: "Stands" }]} />}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <button onClick={() => setTemp(!temp)} className={cx("btn-ghost !py-1 text-[12px]", temp && "border-tfr/40 bg-tfr/10 text-tfr")}>
          <span className={cx("inline-block h-2 w-2 rounded-full", temp ? "bg-tfr" : "bg-ink-3")} /> Temp zone {temp ? "open" : "closed"}
        </button>
        {bench?.cut_vs_whiteboard_pct != null && <Chip tone="ok">Best cuts tows {bench.cut_vs_whiteboard_pct}% vs whiteboard</Chip>}
      </div>
      {error ? <ErrorNote error={error} /> : loading && !bench ? (
        <div className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" />
          <p className="flex items-center gap-1.5 text-[12px] text-ink-2"><Timer size={13} /> Running the exact solver on the whole week: a few seconds…</p></div>
      ) : (
        <div className={cx("space-y-2.5 transition-opacity", loading && "opacity-50")}>
          {rows.map((r) => {
            const best = bench?.best === r.method;
            const model = MODEL[r.method];
            return (
              <div key={r.method} className={cx("rounded-[14px] border p-3", best ? "border-ok/40 bg-ok/[0.06]" : "border-hairline bg-white/60")}>
                <div className="flex items-baseline justify-between gap-2">
                  <button disabled={!model} onClick={() => model && onModel(model)} className={cx("text-left text-[13px] font-semibold", model && "hover:text-runway")}>
                    {r.name}
                  </button>
                  {best && <Chip tone="ok"><Trophy size={11} /> Best here</Chip>}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/[0.06]">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (r.tows / maxTows) * 100)}%`, background: r.method === "first_come" ? "#D97706" : best ? "#16A34A" : "#2563EB" }} />
                  </div>
                  <span className="num w-[70px] text-right text-[13px] font-semibold">{fmt(r.tows)} tows</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-ink-2">
                  <span><b className={cx("num", r.overflow ? "text-alert" : "text-ink")}>{r.overflow}</b> turned away</span>
                  {r.pad > 0 && <span><b className="num text-ink">{r.pad}</b> on the pad</span>}
                  {r.temp > 0 && <span><b className="num text-ink">{r.temp}</b> temp stands</span>}
                  <span><b className="num text-ink">{r.hot}</b> hot-spot turns</span>
                  <span className="ml-auto">{r.solve_s ? `${r.solve_s} s` : "< 0.2 s"} · {r.solver}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-2">
        {bench?.how ?? "Every method sees only the departure times owners gave; tows are counted from when jets really left."}{" "}
        A plan that is perfect on paper breaks when owners leave late; deciding at each arrival from who is really parked holds up better on most layouts.
      </p>
    </Panel>
  );
}

function ModelCard({ m, lit, simple }: { m: AiModel; lit: boolean; simple: boolean }) {
  const a = AUTOMATION[m.automation];
  return (
    <article id={`model-${m.id}`}
      className={cx("glass-strong flex scroll-mt-24 flex-col p-4 transition-shadow duration-500", lit && "ring-2 ring-runway/50 shadow-lift")}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-runway/10 text-runway">{FAMILY_ICON[m.family] ?? <Route size={14} />}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-tight">{m.name}</h3>
          <div className="mt-1 flex flex-wrap gap-1">
            <Chip>{m.family}</Chip>
            <Chip tone={m.automation === "automatic" ? "runway" : m.automation === "human approves" ? "tfr" : "neutral"}>{a.icon}{a.text}</Chip>
            {m.status !== "live" && <Chip tone="watch">{m.status === "fallback" ? "Reference fallback" : "Not installed"}</Chip>}
          </div>
        </div>
      </div>
      <p className="mt-2.5 text-[13px] leading-snug text-ink">{m.question}</p>
      {m.evidence.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {m.evidence.slice(0, simple ? 2 : 4).map((e) => (
            <div key={e.label} className="rounded-[12px] border border-hairline bg-white/60 px-2.5 py-2">
              <div className="truncate text-[10.5px] font-medium uppercase tracking-[0.04em] text-ink-3">{e.label}</div>
              <div className={cx("num font-semibold leading-tight", typeof e.value === "number" ? "text-[19px]" : "text-[13px]")}>
                {typeof e.value === "number" ? fmt(e.value, Number.isInteger(e.value) ? 0 : 1) : e.value}{e.unit ? <span className="text-[12px] text-ink-2">{e.unit === "%" ? "%" : ` ${e.unit}`}</span> : null}
              </div>
              {e.detail && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-2">{e.detail}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-2">
        <Disclosure summary={<span className="text-[12.5px] font-medium">How it works</span>}>
          <ol className="space-y-1.5">
            {m.method.map((s, k) => (
              <li key={k} className="flex gap-2"><span className="num grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-runway/10 text-[10.5px] font-semibold text-runway">{k + 1}</span><span>{s}</span></li>
            ))}
          </ol>
          <div className="mt-2 text-[11px] text-ink-3">Code: <code className="rounded bg-ink/[0.05] px-1 py-0.5">{m.code}</code>{m.card && <> · model card <code className="rounded bg-ink/[0.05] px-1 py-0.5">{m.card}</code></>}</div>
        </Disclosure>
        <Disclosure summary={<span className="text-[12.5px] font-medium">Inputs, outputs and limits</span>}>
          <div className="label mb-1">Inputs</div>
          <ul className="mb-2 space-y-1">
            {m.inputs.map((x) => <li key={x.name} className="flex items-start justify-between gap-2"><span>{x.name}</span><Chip tone={LABEL_TONE[x.label]} className="shrink-0">{LABEL_TEXT[x.label]}</Chip></li>)}
          </ul>
          <div className="label mb-1">Outputs</div>
          <ul className="mb-2 list-disc pl-4">{m.outputs.map((x) => <li key={x}>{x}</li>)}</ul>
          <div className="label mb-1 text-alert">Never use it to</div>
          <ul className="list-disc pl-4">{m.limits.map((x) => <li key={x}>{x}</li>)}</ul>
        </Disclosure>
      </div>
      <div className="mt-auto pt-3 text-[11px] text-ink-3">{m.owner}</div>
    </article>
  );
}

function Validation({ rows }: { rows: { check: string; metric: string; subject: string; method: string; predicted: string; reference: string; abs_pct_error: string; note: string; status: string }[] }) {
  const METHOD: Record<string, string> = {
    analog_mean_leave_one_out: "RAMPCAST (other events' mean)", naive_ordinary_week: "Same as an ordinary week",
    naive_previous_host: "Same as the last host", "rampcast.forecast v1": "RAMPCAST forecast",
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-left text-[12.5px]">
        <thead className="text-[11px] uppercase tracking-[0.04em] text-ink-3">
          <tr><th className="py-1.5 pr-3 font-medium">Check</th><th className="pr-3 font-medium">Event</th><th className="pr-3 font-medium">Method</th>
            <th className="pr-3 text-right font-medium">Predicted</th><th className="pr-3 text-right font-medium">Published</th><th className="text-right font-medium">Error</th></tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k} className={cx("border-t border-hairline", r.method.startsWith("analog") || r.method.startsWith("rampcast") ? "font-medium text-ink" : "text-ink-2")}>
              <td className="py-1.5 pr-3">{r.check === "leave_one_event_out" ? `Leave one out · ${r.metric.replace(/_/g, " ")}` : r.metric.replace(/_/g, " ")}</td>
              <td className="pr-3">{r.subject}</td>
              <td className="pr-3">{METHOD[r.method] ?? r.method}</td>
              <td className="num pr-3 text-right">{r.predicted}</td>
              <td className="num pr-3 text-right">{r.reference}</td>
              <td className="num text-right">{r.abs_pct_error ? `${r.abs_pct_error}%` : r.status === "above" ? <span className="text-watch">above range</span> : r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

