import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AfterAction, Alert, AssignResult, AuditRow, Briefing, Explanation, Forecast, Meta, Occupancy, ParkingMethod,
  ParkingPlan, ParkingState, Queue, ReplayState, Reservation, Scenario, Settings, StrategiesResponse, WhatIf, La28Report,
  BookingMeta, BookingQuote, Inbox, Layout, TripRequest, AiRecs, AiModels, AiBenchmark } from "./types";
import type { Movement } from "../three/layout";

const BASE = "/api";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const q = (t?: string) => (t ? `t=${encodeURIComponent(t)}` : "");

export const api = {
  aiRecommendations: (s: Scenario, layout: Layout, t?: string) => http<AiRecs>(`/ai/recommendations?scenario=${s}&layout=${layout}&${q(t)}`),
  aiModels: (s: Scenario, layout: Layout) => http<AiModels>(`/ai/models?scenario=${s}&layout=${layout}`),
  aiBenchmark: (layout: Layout, temp: boolean) => http<AiBenchmark>(`/ai/benchmark?layout=${layout}&temp=${temp}`),
  meta: () => http<Meta>("/meta"),
  forecast: (s: Scenario) => http<Forecast>(`/forecast?scenario=${s}`),
  occupancy: (s: Scenario) => http<Occupancy>(`/ramp/occupancy?scenario=${s}`),
  strategies: (s: Scenario) =>
    http<StrategiesResponse>("/plan/strategies", { method: "POST", body: JSON.stringify({ scenario: s }) }),
  queue: (t?: string) => http<Queue>(`/priority/queue?${q(t)}`),
  alerts: (t?: string) => http<{ t_local: string; alerts: Alert[] }>(`/alerts?${q(t)}`),
  replay: (t?: string) => http<ReplayState>(`/replay/state?${q(t)}`),
  whatif: (s: Scenario, modifiers: Record<string, unknown>, layout: Layout = "stands") =>
    http<WhatIf>("/whatif", { method: "POST", body: JSON.stringify({ scenario: s, modifiers, layout }) }),
  briefing: (s: Scenario, t?: string) => http<Briefing>(`/briefing?scenario=${s}&${q(t)}`),
  explain: (question: string, s: Scenario, t?: string) =>
    http<Explanation>("/explain", { method: "POST", body: JSON.stringify({ question, scenario: s, t }) }),
  afteraction: (s: Scenario) => http<AfterAction>(`/afteraction?scenario=${s}`),
  la28: (s: Scenario) => http<La28Report>(`/la28?scenario=${s}`),
  bookingQuote: (r: TripRequest) => http<BookingQuote>("/bookings/quote", { method: "POST", body: JSON.stringify(r) }),
  bookingAccept: (trip_sheet: Record<string, unknown>, layout: Layout, channel: string, replay_t_local?: string) =>
    http<{ ok: boolean; flight_id: string; position: string; trip_sheet: Record<string, unknown> }>("/bookings/accept",
      { method: "POST", body: JSON.stringify({ trip_sheet, layout, channel, replay_t_local }) }),
  bookingCancel: (flightId: string) => http<{ ok: boolean }>(`/bookings/accepted/${encodeURIComponent(flightId)}`, { method: "DELETE" }),
  bookingInbox: (t: string | undefined, layout: Layout) => http<Inbox>(`/bookings/inbox?${q(t)}&layout=${layout}`),
  bookingMeta: () => http<BookingMeta>("/bookings/connections"),
  airfieldMovements: () => http<{ source: string; movements: Movement[] }>("/airfield/movements"),
  settings: () => http<Settings>("/settings"),
  putSettings: (patch: Partial<Settings>) => http<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  audit: () => http<{ entries: AuditRow[] }>("/audit"),
  parkingPlan: (m: ParkingMethod, temp: boolean, layout: Layout) => http<ParkingPlan>(`/parking/plan?method=${m}&temp=${temp}&layout=${layout}`),
  parkingState: (t: string, m: ParkingMethod, temp: boolean, layout: Layout) =>
    http<ParkingState>(`/parking/state?${q(t)}&method=${m}&temp=${temp}&layout=${layout}`),
  reservations: (day: string, m: ParkingMethod, temp: boolean, layout: Layout) =>
    http<{ day: string; items: Reservation[] }>(`/parking/reservations?day=${day}&method=${m}&temp=${temp}&layout=${layout}`),
  assign: (flight_id: string, position_id: string | null, confirm: boolean, layout: Layout, replay_t_local?: string) =>
    http<AssignResult>("/parking/assign", { method: "POST", body: JSON.stringify({ flight_id, position_id, confirm, layout, replay_t_local }) }),
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
