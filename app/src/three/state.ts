// Shared mutable state between the render loop and the DOM overlays (kept out of React state on purpose).
import type { Phase } from "./layout";

export const sim = { ms: 0, night: 0 };
export const focus = { active: false, x: 0, y: 0, z: 0, heading: 0 };
export const trafficStats: Record<Phase | "visible", number> = {
  visible: 0, approach: 0, rollout: 0, taxi_in: 0, parked: 0, tow: 0, pushback: 0, taxi_out: 0, lineup: 0, takeoff: 0, climb: 0,
};

export type CameraMode = "overview" | "tower" | "ramp" | "runway" | "bird";
export const CAMERAS: Record<CameraMode, { pos: [number, number, number]; target: [number, number, number]; label: string }> = {
  overview: { pos: [-600, 255, 650], target: [40, 0, -10], label: "Overview" },
  tower: { pos: [302, 54, -134], target: [-70, 0, 90], label: "Tower cab" },
  ramp: { pos: [-236, 9, 18], target: [-40, 5, 110], label: "Ramp level" },
  runway: { pos: [-860, 16, -392], target: [-1760, 62, -330], label: "Final approach" },
  bird: { pos: [0, 1050, 230], target: [0, 0, 160], label: "Bird's eye" },
};

// Game-day TFR window (tfr_game_day.window_local in contracts/assumptions.yaml), as epoch ms.
export const TFR_WINDOW = [Date.parse("2027-02-14T14:30:00-08:00"), Date.parse("2027-02-14T20:30:00-08:00")] as const;
