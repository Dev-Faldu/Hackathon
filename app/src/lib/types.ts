// Shapes returned by the RAMPCAST API (see contracts/README.md).

export type Scenario = "low" | "medium" | "high";
export type SizeClass = "light" | "mid" | "super_mid" | "large" | "other";

export interface Stand { stand_id: string; row: string; column: number; depth: number; max_wingspan_ft: number }

export interface Settings {
  event: string; game_date: string; airport: string; fbo_name: string;
  capacity: number; staff_on_shift: number; fuel_trucks: number;
  weights: { fixed_time: number; medical_access: number; hard_deadline: number; wait: number };
}

export interface Meta {
  product: string;
  event: { name: string; game_date: string; kickoff_local: string; window: string[] };
  settings: Settings;
  window: string[];
  live_source: "sample" | "opensky_2022_shifted";
  notes: string[];
  claude_enabled: boolean;
  modules: Record<string, boolean>;
  stands: Stand[];
  demo_t: string;
  privacy: string;
}

export interface ForecastDay { date: string; baseline_p50: number; p10: number; p50: number; p90: number; actual?: number }
export interface Forecast {
  scenario: Scenario; model: string; days: ForecastDay[]; notes?: string[];
  validation: { event_held_out: string | null; mape_pct: number | null; interval_coverage_pct: number | null };
}

export interface OccupancyHour { t_local: string; p50: number; p90: number; p_over_capacity: number }
export interface Occupancy { scenario: Scenario; capacity: number; runs: number; hours: OccupancyHour[] }

export interface Kpis {
  aircraft_accommodated: number; parked_at_vny: number; overflow_aircraft: number; hours_over_capacity: number;
  empty_legs: number; co2_t: number; co2_saved_vs_adhoc_t: number; peak_line_staff: number;
  peak_movements_per_hour: number; fuel_gal_week: number; risk: "low" | "medium" | "high";
}
export interface Strategy {
  id: "A" | "B" | "C"; name: string; summary: string; kpis: Kpis; approvers: string[];
  assumptions: string[]; explanation_facts: { id: string; text: string }[];
}
export interface StrategiesResponse {
  scenario: Scenario; source: string; capacity: number; approved: string | null;
  status_quo: { hours_over_capacity: number; peak_demand: number }; strategies: Strategy[];
}

export interface QueueItem {
  booking_code: string; flight_id: string; status: "inbound" | "on_ground"; eta_local: string; eta_p90_local: string;
  size_class: SizeClass; origin: string; is_international: boolean; party_size: number; hotel_zone: string;
  score: number; components: Record<string, number>; slack_min: number | null; reasons: string[]; rank: number;
  synthetic: boolean;
}
export interface Queue { t_local: string; weights: Settings["weights"]; items: QueueItem[]; policy: string }

export interface Alert {
  id: string; severity: "high" | "watch" | "info"; kind: string; message: string; recommended_action: string;
  owner_role: string; t_local: string; flight_id?: string;
}

export interface Airborne {
  flight_id: string; booking_code: string | null; size_class: SizeClass; origin: string; origin_name: string;
  origin_lat: number; origin_lon: number; lat: number; lon: number; progress: number; eta_local: string;
  eta_p90_local: string; minutes_to_go: number; is_international: boolean;
}
export interface Ground {
  flight_id: string; booking_code: string | null; size_class: SizeClass; stand_id: string | null; conflicts: number;
  landed_local: string; departs_local: string; stay_type: string; footprint: number;
}
export interface ReplayState {
  t_local: string; source: string; notes: string[]; capacity: number; occupancy: number; occupancy_pct: number;
  aircraft_on_ground: number; overflow_now: number; airborne_count: number; arrivals_today: number;
  departures_today: number; stand_conflicts_week: number; airborne: Airborne[]; ground: Ground[];
  recent: { t_local: string; event: string; flight_id: string; origin: string; size_class: SizeClass }[];
  upcoming: { flight_id: string; booking_code: string | null; eta_local: string; eta_p90_local: string; origin: string;
    origin_name: string; size_class: SizeClass; is_international: boolean }[];
  stands: Stand[];
}

export interface AltOption {
  airport: string; name: string; expected_delay_min: number; extra_drive_min: number; customs: string;
  parking: string; score: number; notes: string[];
}
export interface AffectedFlight {
  flight_id: string; booking_code: string | null; size_class: SizeClass; origin: string; origin_name: string;
  is_international: boolean; eta_local: string; new_eta_local: string; delay_min: number; hotel_zone: string;
  options: AltOption[]; decided_by: string;
}
export interface Explanation { text: string; cited_ids: string[]; model: string; fallback: boolean }
export interface WhatIf {
  scenario: Scenario; modifiers: Record<string, unknown>;
  kpi_diff: Record<string, Record<string, [number, number]>>;
  status_quo: { before: { hours_over_capacity: number; peak_demand: number }; after: { hours_over_capacity: number; peak_demand: number } };
  new_alerts: Alert[]; affected_flights: AffectedFlight[]; strategies: Strategy[]; explanation: Explanation;
}
export interface Briefing extends Explanation { recommended: string; facts: { id: string; value: number | string; text: string }[] }

export interface AuditRow { t_utc: string; actor_role: string; action: string; target: string; note: string; replay_t_local?: string | null }
export interface AfterAction {
  scenario: Scenario; source: string; notes: string[]; days: ForecastDay[]; mape_pct: number | null;
  naive_mape_pct: number | null; interval_coverage_pct: number; hours_over_capacity_no_plan: number;
  hours_over_capacity_with_plan: number; strategy: string; strategy_kpis: Kpis; peak_occupancy: number;
  capacity: number; stand_conflicts_week: number; audit: AuditRow[];
}
