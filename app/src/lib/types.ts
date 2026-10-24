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
  peak_movements_per_hour: number; fuel_gal_week: number; risk: "low" | "medium" | "high"; reposition_fuel_gal?: number;
}
export interface Strategy {
  id: "A" | "B" | "C"; name: string; summary: string; kpis: Kpis; approvers: string[];
  assumptions: string[]; explanation_facts: { id: string; text: string }[];
  overflow_split?: Record<string, number>; solver?: string;
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
  options: AltOption[]; decided_by: string; cause?: "runway_closure" | "arrival_delay"; customs_missed?: boolean;
}
export interface Explanation { text: string; cited_ids: string[]; model: string; fallback: boolean }
export interface WhatIf {
  scenario: Scenario; modifiers: Record<string, unknown>;
  kpi_diff: Record<string, Record<string, [number, number]>>;
  status_quo: { before: { hours_over_capacity: number; peak_demand: number }; after: { hours_over_capacity: number; peak_demand: number } };
  new_alerts: Alert[]; affected_flights: AffectedFlight[]; strategies: Strategy[]; explanation: Explanation;
  queue_changes?: { booking_code: string; flight_id: string; rank_before: number | null; rank_after: number; reasons: string[] }[];
  stand_plan?: { changed_times: number; re_planned: number; overflow_before: number; overflow_after: number; boxed_in: number; solver: string;
    moves: { flight_id: string; from: string | null; to: string | null; time_changed: boolean }[] };
}
export interface Briefing extends Explanation { recommended: string; facts: { id: string; value: number | string; text: string }[] }

export interface AuditRow { t_utc: string; actor_role: string; action: string; target: string; note: string; replay_t_local?: string | null }
export interface AfterAction {
  scenario: Scenario; source: string; notes: string[]; days: ForecastDay[]; mape_pct: number | null;
  naive_mape_pct: number | null; interval_coverage_pct: number; hours_over_capacity_no_plan: number;
  hours_over_capacity_with_plan: number; strategy: string; strategy_kpis: Kpis; peak_occupancy: number;
  capacity: number; stand_conflicts_week: number; audit: AuditRow[];
}

// ---------- parking control ----------
export type ParkingMethod = "optimized" | "first_come";
export interface ParkingPosition { id: string; kind: "stand" | "hot" | "temp"; row: string; column: number; depth: number; max_wingspan_ft: number }
export interface ParkingMetrics {
  method: ParkingMethod; temp_zone: boolean; tows: number; boxed_in_events: number; overflow_aircraft: number;
  hot_spot_uses: number; temp_zone_uses: number; peak_stands_used: number; stands: number; utilization_pct: number;
  revenue_est_usd: number; aircraft_parked: number; solver?: string;
}
export interface GanttBar {
  flight_id: string; booking_code: string | null; size_class: SizeClass; start: string; end: string; stay_type: string;
  origin: string; tow_involved: boolean;
}
export interface Tow { t_local: string; flight_id: string; size_class: SizeClass; from: string; to: string; reason: string; for_flight: string }
export interface ParkingPlan {
  method: ParkingMethod; temp_zone: boolean; source: string; positions: ParkingPosition[]; metrics: ParkingMetrics;
  compare: ParkingMetrics; gantt: { position: string; kind: string; bars: GanttBar[] }[]; tows: Tow[];
  pins: Record<string, string>; window: string[];
}
export interface Occupant {
  flight_id: string; booking_code: string | null; size_class: SizeClass; wingspan_ft: number; position: string | null;
  kind: string; arrive_local: string; depart_local: string; origin: string; origin_name: string; stay_type: string; reasons: string[];
}
export interface ParkingState {
  t_local: string; occupants: Occupant[]; tows_next_3h: Tow[];
  arrivals_next_3h: { flight_id: string; booking_code: string | null; size_class: SizeClass; arrive_local: string; position: string | null; origin: string }[];
  departures_next_3h: { flight_id: string; size_class: SizeClass; depart_local: string; position: string | null }[];
  stands_used: number; hot_used: number; temp_used: number; overflow_now: number;
}
export interface Reservation {
  flight_id: string; booking_code: string | null; size_class: SizeClass; origin: string; origin_name: string;
  arrive_local: string; depart_local: string; stay_h: number; stay_type: string; position: string | null;
  action: "stand" | "hot_spot" | "temp" | "overflow"; label: string; reasons: string[]; tows: number;
}
export interface AssignResult { ok: boolean; issues: string[]; confirmed?: boolean; tows_before?: number; tows_after?: number; pins: Record<string, string> }

export interface La28Profile {
  arrivals: number; median_stay_h: number; parked_at_week_end: number; international_pct: number;
  intl_after_customs_close: number; large_pct: number; peak_demand: number; hours_over_capacity: number;
  tows_whiteboard: number; tows_rampcast: number; overflow_rampcast: number;
  strategies: { id: "A" | "B" | "C"; name: string; kpis: Kpis; approvers: string[] }[];
}
export interface La28Report {
  event: { name: string; ceremony_date: string; window: [string, string]; games: [string, string] };
  scenario: Scenario; capacity: number; source: string; notes: string[]; assumptions: string[];
  days: ForecastDay[]; week_by_scenario: Record<Scenario, number>;
  hours: { t_local: string; la28_p50: number; la28_p90: number; sb_p50: number }[];
  first_hour_over_capacity: string | null; hours_over_capacity_p50: number;
  la28: La28Profile; super_bowl: La28Profile;
  recommendations: { title: string; detail: string; approver: string }[]; never: string;
}
