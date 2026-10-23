import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AfterAction, Alert, AuditRow, Briefing, Explanation, Forecast, Meta, Occupancy, Queue, ReplayState, Scenario,
  Settings, StrategiesResponse, WhatIf,
} from "./types";

const BASE = "/api";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const q = (t?: string) => (t ? `t=${encodeURIComponent(t)}` : "");

export const api = {
  meta: () => http<Meta>("/meta"),
  forecast: (s: Scenario) => http<Forecast>(`/forecast?scenario=${s}`),
  occupancy: (s: Scenario) => http<Occupancy>(`/ramp/occupancy?scenario=${s}`),
  strategies: (s: Scenario) =>
    http<StrategiesResponse>("/plan/strategies", { method: "POST", body: JSON.stringify({ scenario: s }) }),
  queue: (t?: string) => http<Queue>(`/priority/queue?${q(t)}`),
  alerts: (t?: string) => http<{ t_local: string; alerts: Alert[] }>(`/alerts?${q(t)}`),
  replay: (t?: string) => http<ReplayState>(`/replay/state?${q(t)}`),
  whatif: (s: Scenario, modifiers: Record<string, unknown>) =>
    http<WhatIf>("/whatif", { method: "POST", body: JSON.stringify({ scenario: s, modifiers }) }),
  briefing: (s: Scenario, t?: string) => http<Briefing>(`/briefing?scenario=${s}&${q(t)}`),
  explain: (question: string, s: Scenario, t?: string) =>
    http<Explanation>("/explain", { method: "POST", body: JSON.stringify({ question, scenario: s, t }) }),
  afteraction: (s: Scenario) => http<AfterAction>(`/afteraction?scenario=${s}`),
  settings: () => http<Settings>("/settings"),
  putSettings: (patch: Partial<Settings>) => http<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  audit: () => http<{ entries: AuditRow[] }>("/audit"),
  decide: (action: "approve" | "edit" | "reject", target: string, note = "", replay_t_local?: string) =>
    http<AuditRow>("/audit", { method: "POST", body: JSON.stringify({ action, target, note, replay_t_local }) }),
};

/** Fetch on mount and whenever deps change; keeps the last good value while reloading. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => { if (id === seq.current) { setData(d); setError(null); } })
      .catch((e: Error) => { if (id === seq.current) setError(e.message); })
      .finally(() => { if (id === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run };
}
