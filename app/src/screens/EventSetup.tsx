import { ArrowRight, CalendarClock, Radio, ShieldCheck, Ticket, Truck, Users, Warehouse } from "lucide-react";
import { useEffect, useState } from "react";
import { TopBar } from "../components/Shell";
import { Chip, Panel } from "../components/ui";
import { api } from "../lib/api";
import { cx, sourceOf } from "../lib/format";
import { useApp } from "../lib/store";
import type { Settings } from "../lib/types";

const WEIGHTS: { key: keyof Settings["weights"]; label: string; hint: string }[] = [
  { key: "fixed_time", label: "Fixed-time commitments", hint: "Must be somewhere at a set time: broadcast crew, team staff, halftime" },
  { key: "medical_access", label: "Medical or accessibility", hint: "Wheelchair, medical equipment, assistance requested" },
  { key: "hard_deadline", label: "Hard deadlines", hint: "Customs closing time, night curfew" },
  { key: "wait", label: "Time already waited", hint: "Minutes since landing" },
];

const LADDER = [
  { when: "30 days out", what: "Forecast only, from past Super Bowls", certainty: 1 },
  { when: "7 days → 1 day", what: "Parking reservations: who is booked", certainty: 2 },
  { when: "22 → 6 hours", what: "Filed flight plans", certainty: 3 },
  { when: "2 hours", what: "Aircraft airborne, live position and ETA", certainty: 4 },
];

export default function EventSetup() {
  const { meta, refreshMeta, go, toast } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (meta && !s) setS(meta.settings); }, [meta, s]);
  if (!s) return <TopBar title="Event setup" subtitle="Loading settings…" />;
  const total = Object.values(s.weights).reduce((a, b) => a + b, 0) || 1;
  const save = async () => {
    setSaving(true);
    await api.putSettings({ capacity: s.capacity, staff_on_shift: s.staff_on_shift, fuel_trucks: s.fuel_trucks, weights: s.weights });
    refreshMeta();
    setSaving(false);
    toast({ title: "Settings saved", body: "Plans and priorities now use these values", tone: "ok" });
  };
  return (
    <div>
      <TopBar title="Event setup" subtitle="Tell RAMPCAST about the event and your FBO. Every number here is editable and logged.">
        <button className="btn-primary" onClick={async () => { await save(); go("plan"); }}>
          Generate plan <ArrowRight size={15} />
        </button>
      </TopBar>
      <div className="grid gap-5 xl:grid-cols-3">
        <Panel eyebrow="Event" title="Super Bowl LXI">
          <dl className="space-y-3 text-[13px]">
            {[
              [<Ticket size={15} />, "Venue", "SoFi Stadium, Inglewood"],
              [<CalendarClock size={15} />, "Game", "Sun Feb 14 2027 · kickoff ≈15:30 (2022 precedent)"],
              [<CalendarClock size={15} />, "Planning window", "Tue Feb 9 → Mon Feb 15 (Presidents' Day)"],
              [<Radio size={15} />, "Game-day TFR", "10 nm core / 30 nm ring · 14:30–20:30 (2022 precedent)"],
              [<ShieldCheck size={15} />, "Reservations", "FBO parking program expected, as in 2022 and 2026"],
            ].map(([icon, k, v], i) => (
              <div key={i} className="flex gap-3">
                <span className="mt-0.5 text-runway">{icon}</span>
                <div><dt className="label">{k}</dt><dd className="mt-0.5 text-ink">{v}</dd></div>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[11.5px] text-ink-2">The LXI NOTAM is not published yet; precedents come from the 2022 and 2026 FAA notices.</p>
        </Panel>

        <Panel eyebrow="Our FBO" title={s.fbo_name}>
          <div className="space-y-4">
            {[
              { k: "capacity" as const, label: "Ramp capacity", unit: "large-cabin equivalents", icon: <Warehouse size={15} />, min: 20, max: 120 },
              { k: "staff_on_shift" as const, label: "Line techs on shift (ordinary week)", unit: "people", icon: <Users size={15} />, min: 2, max: 40 },
              { k: "fuel_trucks" as const, label: "Fuel trucks", unit: "5,000 gal each", icon: <Truck size={15} />, min: 1, max: 10 },
            ].map((f) => (
              <label key={f.k} className="block">
                <span className="mb-1.5 flex items-center gap-2 text-[13px] font-medium"><span className="text-runway">{f.icon}</span>{f.label}</span>
                <div className="flex items-center gap-3">
                  <input id={`setup-${f.k}`} type="range" min={f.min} max={f.max} value={s[f.k]}
                    onChange={(e) => setS({ ...s, [f.k]: Number(e.target.value) })} className="flex-1 accent-[#2563EB]" />
                  <input type="number" value={s[f.k]} min={f.min} max={f.max} aria-label={f.label}
                    onChange={(e) => setS({ ...s, [f.k]: Number(e.target.value) })}
                    className="num w-[72px] rounded-control border border-hairline bg-white/80 px-2 py-1.5 text-right text-[14px] font-semibold" />
                </div>
                <span className="mt-1 block text-[11px] text-ink-2">{f.unit}</span>
              </label>
            ))}
          </div>
          <button className="btn-ghost mt-5 w-full" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save FBO settings"}</button>
        </Panel>

        <Panel eyebrow="Ground-handling priority" title="Need-based rules">
          <p className="mb-4 text-[12.5px] leading-snug text-ink-2">
            Who gets the first car and the curb when everyone lands at once. You set the weights; RAMPCAST explains every ranking.
          </p>
          <div className="space-y-4">
            {WEIGHTS.map((w, i) => (
              <div key={w.key}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-medium"><span className="num mr-1.5 text-ink-2">{i + 1}</span>{w.label}</span>
                  <span className="num text-[13px] font-semibold text-runway">{Math.round((s.weights[w.key] / total) * 100)}%</span>
                </div>
                <input id={`weight-${w.key}`} type="range" min={0} max={100} value={Math.round(s.weights[w.key] * 100)}
                  onChange={(e) => setS({ ...s, weights: { ...s.weights, [w.key]: Number(e.target.value) / 100 } })}
                  className="mt-1 w-full accent-[#2563EB]" />
                <div className="text-[11px] text-ink-2">{w.hint}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-control border border-alert/15 bg-alert/[0.04] p-3">
            <div className="label mb-1.5 text-alert">Never an input</div>
            <div className="flex flex-wrap gap-1.5">
              {["Name or fame", "Status or tier", "What they pay", "Nationality"].map((x) => <Chip key={x} tone="alert">{x}</Chip>)}
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="mt-5" eyebrow="How live data arrives" title="Certainty grows as the date gets closer">
        <div className="grid gap-3 md:grid-cols-4">
          {LADDER.map((l) => (
            <div key={l.when} className="rounded-control border border-hairline bg-white/60 p-4">
              <div className="flex gap-1">
                {[1, 2, 3, 4].map((b) => (
                  <span key={b} className={cx("h-1.5 flex-1 rounded-full", b <= l.certainty ? "bg-runway" : "bg-ink/10")} />
                ))}
              </div>
              <div className="mt-3 text-[15px] font-semibold">{l.when}</div>
              <div className="mt-1 text-[12.5px] text-ink-2">{l.what}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-ink-2">
          In this demo, Live ops replays {sourceOf(meta?.live_source).sentence}.
        </p>
      </Panel>
    </div>
  );
}
