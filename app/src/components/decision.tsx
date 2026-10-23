import { motion } from "framer-motion";
import { ArrowRight, BadgeCheck, MessageSquareText, Send, Sparkles, Users } from "lucide-react";
import { useState } from "react";
import { api, useApi } from "../lib/api";
import { cx, fmt } from "../lib/format";
import { useApp } from "../lib/store";
import type { Strategy } from "../lib/types";
import { MiniBar } from "./charts";
import { ApproveBar, Chip, CitedText, Panel, Skeleton } from "./ui";

const KPI_ROWS: { key: keyof Strategy["kpis"]; label: string; unit?: string; lowerIsBetter: boolean; digits?: number }[] = [
  { key: "overflow_aircraft", label: "Overflow aircraft", lowerIsBetter: true },
  { key: "hours_over_capacity", label: "Hours over capacity", unit: "h", lowerIsBetter: true },
  { key: "empty_legs", label: "Empty repositioning legs", lowerIsBetter: true },
  { key: "co2_t", label: "CO₂ from those legs", unit: "t", lowerIsBetter: true, digits: 1 },
  { key: "peak_line_staff", label: "Line techs at peak", lowerIsBetter: true },
];

export function StrategyCards({ strategies, recommended, approved }: {
  strategies: Strategy[]; recommended?: string; approved?: string | null;
}) {
  const max = (k: keyof Strategy["kpis"]) => Math.max(...strategies.map((s) => Number(s.kpis[k]) || 0));
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      {strategies.map((s, i) => (
        <motion.article key={s.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
          className={cx("glass-strong relative flex flex-col p-5", recommended === s.id && "ring-2 ring-runway/40")}>
          {recommended === s.id && (
            <span className="absolute -top-2.5 left-5 rounded-full bg-runway px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-[0_4px_12px_rgba(37,99,235,0.35)]">
              Suggested
            </span>
          )}
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-ink text-[15px] font-semibold text-white">{s.id}</div>
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold leading-tight">{s.name}</h3>
              <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{s.summary}</p>
            </div>
          </div>
          <div className="mt-4 space-y-2.5">
            {KPI_ROWS.map((r) => {
              const v = Number(s.kpis[r.key]);
              const best = Math.min(...strategies.map((x) => Number(x.kpis[r.key])));
              return (
                <div key={r.key}>
                  <div className="mb-1 flex items-baseline justify-between text-[12px]">
                    <span className="text-ink-2">{r.label}</span>
                    <span className={cx("num font-semibold", v === best && "text-ok")}>{fmt(v, r.digits ?? 0)}{r.unit ? ` ${r.unit}` : ""}</span>
                  </div>
                  <MiniBar value={v} max={max(r.key)} tone={v === best ? "#16A34A" : "#2563EB"} />
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <Chip tone={s.kpis.risk === "high" ? "alert" : s.kpis.risk === "medium" ? "watch" : "ok"}>Risk: {s.kpis.risk}</Chip>
            <Chip>{fmt(s.kpis.fuel_gal_week)} gal Jet A / week</Chip>
            {s.kpis.co2_saved_vs_adhoc_t > 0 && <Chip tone="ok">−{fmt(s.kpis.co2_saved_vs_adhoc_t, 1)} t CO₂ vs ad hoc</Chip>}
          </div>
          <div className="mt-3 border-t border-hairline pt-3">
            <div className="label mb-1.5 flex items-center gap-1"><Users size={12} /> Approvers</div>
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
      ))}
    </div>
  );
}

export function BriefingPanel({ t }: { t?: string }) {
  const { scenario, meta } = useApp();
  const tHour = t ? t.slice(0, 13) : undefined;
  const { data, loading } = useApi(() => api.briefing(scenario, t), [scenario, tHour]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ q: string; text: string; model: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const ask = async () => {
    if (!question.trim()) return;
    setAsking(true);
    try {
      const r = await api.explain(question, scenario, t);
      setAnswer({ q: question, text: r.text, model: r.model });
      setQuestion("");
    } finally {
      setAsking(false);
    }
  };
  return (
    <Panel strong eyebrow={<span className="flex items-center gap-1.5"><Sparkles size={12} className="text-runway" /> Morning briefing</span>}
      title="What the numbers say" actions={<Chip tone={data?.fallback ? "neutral" : "runway"}>{data ? (data.fallback ? "Template" : "Claude") : "…"}</Chip>}>
      {loading && !data ? (
        <div className="space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-4/5" /></div>
      ) : data ? (
        <CitedText text={data.text} />
      ) : null}
      {answer && (
        <div className="mt-4 rounded-control border border-hairline bg-white/60 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-ink-2"><MessageSquareText size={13} /> {answer.q}</div>
          <CitedText text={answer.text} />
        </div>
      )}
      <form className="mt-4 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input id="briefing-question" value={question} onChange={(e) => setQuestion(e.target.value)}
          placeholder={meta?.claude_enabled ? "Ask: why is B suggested over C?" : "Ask a question (Claude needs an API key)"}
          className="min-w-0 flex-1 rounded-control border border-hairline bg-white/80 px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-runway/30" />
        <button className="btn-primary" disabled={asking}>{asking ? "…" : <Send size={14} />}</button>
      </form>
      <p className="mt-2 flex items-center gap-1 text-[11px] text-ink-2">
        Every number links to the engine fact it came from <ArrowRight size={11} /> Claude writes words, never numbers.
      </p>
    </Panel>
  );
}
