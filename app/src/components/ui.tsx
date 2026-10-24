import { motion, AnimatePresence, animate, useMotionValue, useTransform } from "framer-motion";
import { Check, CheckCircle2, ChevronDown, Info, Pencil, X, AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { cx } from "../lib/format";
import { useApp } from "../lib/store";

export function Panel({ title, eyebrow, actions, children, className, strong, bodyClass }: {
  title?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
  strong?: boolean; bodyClass?: string;
}) {
  return (
    <section className={cx(strong ? "glass-strong" : "glass", "relative flex min-w-0 flex-col", className)}>
      {(title || eyebrow || actions) && (
        <header className="flex items-start justify-between gap-3 px-5 pt-4">
          <div className="min-w-0">
            {eyebrow && <div className="label mb-1">{eyebrow}</div>}
            {title && <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("min-w-0 flex-1 px-5 pb-5 pt-3", bodyClass)}>{children}</div>
    </section>
  );
}

export function CountUp({ value, digits = 0, className }: { value: number; digits?: number; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.6, ease: "easeOut" });
    return c.stop;
  }, [value, mv]);
  return <motion.span className={cx("num", className)}>{text}</motion.span>;
}

export function Kpi({ label, value, digits = 0, unit, sub, tone, children, info }: {
  label: string; value: number; digits?: number; unit?: string; sub?: ReactNode;
  tone?: "ok" | "watch" | "alert" | "runway"; children?: ReactNode; info?: { what: ReactNode; source?: ReactNode };
}) {
  const toneCls = { ok: "text-ok", watch: "text-watch", alert: "text-alert", runway: "text-runway" };
  return (
    <div className="glass flex min-w-0 flex-col gap-1 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-1"><div className="label truncate">{label}</div>{info && <InfoTip what={info.what} source={info.source} />}</div>
      <div className={cx("flex items-baseline gap-1.5 text-[28px] font-semibold leading-none tracking-[-0.02em]", tone && toneCls[tone])}>
        <CountUp value={value} digits={digits} />
        {unit && <span className="text-[13px] font-medium text-ink-2">{unit}</span>}
      </div>
      {sub && <div className="text-[12px] leading-snug text-ink-2">{sub}</div>}
      {children}
    </div>
  );
}

export function Chip({ children, tone = "neutral", className }: {
  children: ReactNode; tone?: "neutral" | "ok" | "watch" | "alert" | "runway" | "tfr"; className?: string;
}) {
  const t = {
    neutral: "border-hairline bg-white/70 text-ink-2",
    ok: "border-ok/25 bg-ok/10 text-ok",
    watch: "border-watch/25 bg-watch/10 text-[#B45309]",
    alert: "border-alert/25 bg-alert/10 text-alert",
    runway: "border-runway/25 bg-runway/10 text-runway",
    tfr: "border-tfr/25 bg-tfr/10 text-tfr",
  }[tone];
  return <span className={cx("chip", t, className)}>{children}</span>;
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: "sm" | "md";
}) {
  return (
    <div className="relative inline-flex rounded-control border border-hairline bg-white/60 p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cx("relative z-10 rounded-[10px] font-medium transition-colors",
            size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3.5 py-1.5 text-[13px]",
            value === o.value ? "text-white" : "text-ink-2 hover:text-ink")}>
          {value === o.value && (
            <motion.span layoutId={`seg-${options.map((x) => x.value).join("")}`}
              className="absolute inset-0 -z-10 rounded-[10px] bg-runway shadow-[0_4px_14px_rgba(37,99,235,0.3)]"
              transition={{ type: "spring", stiffness: 500, damping: 38 }} />
          )}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ApproveBar({ target, approverRole, compact, onDecided }: {
  target: string; approverRole: string; compact?: boolean; onDecided?: (a: string) => void;
}) {
  const { toast, tIso, bumpDecisions } = useApp();
  const [state, setState] = useState<string | null>(null);
  const decide = async (action: "approve" | "edit" | "reject") => {
    const note = action === "edit" ? "Edited by manager before approval" : "";
    await api.decide(action, target, note, tIso);
    setState(action);
    bumpDecisions();
    onDecided?.(action);
    const verb = { approve: "Approved", edit: "Edited and approved", reject: "Rejected" }[action];
    toast({ title: `${verb} by ${approverRole}`, body: `${target} · logged to audit trail`, tone: action === "reject" ? "info" : "ok" });
  };
  if (state) {
    return (
      <div className="flex items-center gap-2 text-[12px] font-medium text-ok">
        <CheckCircle2 size={15} /> {state === "reject" ? "Rejected" : state === "edit" ? "Edited + approved" : "Approved"} · logged
        <button className="ml-1 text-ink-2 underline-offset-2 hover:underline" onClick={() => setState(null)}>Undo view</button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <button className={cx("btn-primary", compact && "px-2.5 py-1.5 text-[12px]")} onClick={() => decide("approve")}>
        <Check size={14} /> Approve
      </button>
      <button className={cx("btn-ghost", compact && "px-2.5 py-1.5 text-[12px]")} onClick={() => decide("edit")} title="Edit, then approve">
        <Pencil size={13} /> Edit
      </button>
      <button className={cx("btn-ghost", compact && "px-2.5 py-1.5 text-[12px]")} onClick={() => decide("reject")}>
        <X size={14} /> Reject
      </button>
    </div>
  );
}

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[340px] flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.2 }}
            className="glass-strong pointer-events-auto flex gap-3 px-4 py-3">
            <div className={cx("mt-0.5", t.tone === "alert" ? "text-alert" : t.tone === "info" ? "text-runway" : "text-ok")}>
              {t.tone === "alert" ? <AlertTriangle size={17} /> : t.tone === "info" ? <Info size={17} /> : <CheckCircle2 size={17} />}
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">{t.title}</div>
              {t.body && <div className="text-[12px] text-ink-2">{t.body}</div>}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-control bg-white/60", className)} />;
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-control border border-alert/20 bg-alert/5 px-3 py-2 text-[12px] text-alert">
      <span>Could not load this panel. Is the API running on port 8000? ({error.slice(0, 80)})</span>
      {onRetry && <button className="btn-ghost px-2 py-1 text-[12px]" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/** Renders Claude/template text and turns [fact.id] citations into small chips. */
export function CitedText({ text }: { text: string }) {
  const parts = text.split(/(\[[A-Za-z0-9_.\-]+\])/g);
  return (
    <p className="text-[14px] leading-[1.6] text-ink">
      {parts.map((p, i) =>
        /^\[[A-Za-z0-9_.\-]+\]$/.test(p) ? (
          <span key={i} title={p.slice(1, -1)}
            className="mx-0.5 inline-flex -translate-y-px items-center rounded-md bg-runway/10 px-1 py-px align-middle font-mono text-[10px] text-runway">
            {p.slice(1, -1).replace(".kpis.", " · ").replace("status_quo.", "")}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

/** A summary line that opens to the full detail. First-time users read the summary; experts open it. */
export function Disclosure({ summary, children, defaultOpen = false, className, tone }: {
  summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string; tone?: "look";
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cx("rounded-[14px] border bg-white/60", tone === "look" ? "border-watch/30" : "border-hairline", className)}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-[14px] px-3.5 py-2.5 text-left transition hover:bg-white/60">
        <div className="min-w-0 flex-1">{summary}</div>
        <ChevronDown size={16} className={cx("shrink-0 text-ink-2 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="border-t border-hairline px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** An (i) next to a number: what it means in plain words, and where it comes from. */
export function InfoTip({ what, source, label = "What this number means" }: { what: ReactNode; source?: ReactNode; label?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(window.innerWidth - 300, Math.max(12, r.left - 140)), y: r.bottom + 8 });
  };
  return (
    <>
      <button ref={btn} type="button" aria-label={label} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}
        onClick={(e) => { e.stopPropagation(); if (pos) setPos(null); else show(); }}
        className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-ink-3 transition hover:bg-runway/10 hover:text-runway focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-runway/40">
        <Info size={12} />
      </button>
      {pos && createPortal(
        <div role="tooltip" style={{ left: pos.x, top: pos.y }}
          className="glass-strong pointer-events-none fixed z-[100] w-[288px] px-3.5 py-2.5 text-[12px] normal-case leading-snug tracking-normal text-ink">
          <div>{what}</div>
          {source && <div className="mt-1.5 border-t border-hairline pt-1.5 text-[11px] text-ink-2"><span className="font-medium">Source:</span> {source}</div>}
        </div>, document.body)}
    </>
  );
}
