// A simulated Van Nuys radio picture built from the same plans the 3D flies: tower, ground and the FBO's
// ramp frequency, plus the ATIS. Standard US phraseology; callsigns are made up (tails are hashed in the data).
// Nothing here talks to real ATC: it narrates what the simulation is doing.
import { type FlightPlan3D, TOW_ASIDE_MS } from "./layout";

export type Station = "TWR" | "GND" | "RAMP";
export interface Call { t: number; station: Station; flight: string; text: string; pilot?: boolean }

const MIN = 60_000;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const WIND = "160 at 8";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Made-up N-number for a hashed tail; a booking that came with a real-looking tail keeps it. */
export function callsign(id: string): string {
  if (/^N\d[0-9A-Z]{1,4}$/.test(id)) return id;
  const h = hash(id);
  return `N${100 + (h % 900)}${LETTERS[(h >>> 10) % LETTERS.length]}${LETTERS[(h >>> 15) % LETTERS.length]}`;
}

export function atisLetter(t: number): string {
  return String.fromCharCode(65 + (Math.floor(t / 3_600_000) % 26));
}

/** The ATIS for the hour: wind matches the windsock, temperatures follow a February day in the Valley. */
export function atis(t: number, tfr: boolean): string {
  const local = new Date(t).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false });
  const h = Number(local) % 24;
  const temp = Math.round(14 + 7 * Math.sin(((h - 9) / 24) * 2 * Math.PI));
  const z = new Date(Math.floor(t / 3_600_000) * 3_600_000 - 7 * MIN).toISOString().slice(11, 13);
  const L = atisLetter(t);
  return `Van Nuys information ${L}, ${z}53 Zulu. Wind ${WIND}. Visibility 10. Few clouds 4,000. Temperature ${temp}, dewpoint 4. ` +
    `Altimeter 30.02. Landing and departing runway 16R.${tfr ? " Stadium TFR in effect, see NOTAM." : ""} Advise you have ${L}.`;
}

/** Every transmission of the week, in time order. */
export function buildRadio(plans: FlightPlan3D[]): Call[] {
  const calls: Call[] = [];
  const csOf = new Map(plans.map((f) => [f.id, callsign(f.id)]));
  const push = (t: number, station: Station, f: FlightPlan3D, text: string, pilot = false) => calls.push({ t, station, flight: f.id, text, pilot });
  for (const f of plans) {
    const cs = csOf.get(f.id)!, R = f.R ?? f.D, ours = !f.other;
    const where = ours ? "Sepulveda Jet Center" : f.ghost ? "the east ramps" : "the east ramp";
    // Arrival
    push(f.L - 160_000, "TWR", f, `Van Nuys Tower, ${cs}, seven mile final runway 16R, with ${atisLetter(f.L)}.`, true);
    push(f.L - 150_000, "TWR", f, `${cs}, Van Nuys Tower, runway 16R, wind ${WIND}, cleared to land.`);
    push(f.L + 50_000, "TWR", f, `${cs}, turn right Bravo, contact Ground.`);
    push(f.L + 75_000, "GND", f, `Van Nuys Ground, ${cs}, clear of 16R at Bravo, taxi to ${where}.`, true);
    push(f.L + 82_000, "GND", f, `${cs}, taxi to ${where} via Alpha.`);
    if (ours) {
      push(f.taxiInEnd - 100_000, "RAMP", f, `Sepulveda Ramp, ${cs}, inbound on Alpha.`, true);
      push(f.taxiInEnd - 92_000, "RAMP", f, `${cs}, follow the marshaller to ${f.position}, wing walkers on both tips. Chocks and cones on arrival.`);
      for (const mv of f.towMoves ?? []) {
        push(mv.t, "RAMP", f, `Tug crew, pull ${cs} out of ${f.position} and hold it on the lane. Walkers on both wings.`);
        push(mv.t + (mv.dur ?? TOW_ASIDE_MS) * 0.8, "RAMP", f, `Tug crew, ${cs} back into ${f.position}.`);
      }
    }
    // Departure
    if (ours) push(f.pushStart - 40_000, "RAMP", f, `${cs}, cleared to push from ${f.position}, tail toward the lane, walkers on both tips.`);
    push(f.taxiOutStart - 20_000, "GND", f, `Van Nuys Ground, ${cs}, at ${where}, ready to taxi with ${atisLetter(f.taxiOutStart)}.`, true);
    push(f.taxiOutStart - 12_000, "GND", f, `${cs}, runway 16R, taxi via Alpha, hold short runway 16R at Alpha One.`);
    const atHold = R - 75_000;
    const waiting = (f.ahead ?? []).filter((lv) => lv > f.D - 75_000).length;
    if (waiting > 0) push(Math.min(atHold - 30_000, f.D - 60_000), "TWR", f, `${cs}, hold short runway 16R, number ${waiting + 1} for departure.`);
    push(atHold, "TWR", f, `${cs}, runway 16R, line up and wait.`);
    push(R - 45_000, "TWR", f, `${cs}, wind ${WIND}, runway 16R, cleared for takeoff.`);
    push(R - 40_000, "TWR", f, `Cleared for takeoff 16R, ${cs}.`, true);
    push(R + 55_000, "TWR", f, `${cs}, contact SoCal Departure. Good day.`);
  }
  return calls.sort((a, b) => a.t - b.t);
}

/** The last `n` calls up to time t (binary search into the sorted list). */
export function recentCalls(calls: Call[], t: number, n: number, only?: string | null): Call[] {
  let lo = 0, hi = calls.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (calls[mid].t <= t) lo = mid + 1; else hi = mid; }
  const out: Call[] = [];
  for (let i = lo - 1; i >= 0 && out.length < n && t - calls[i].t < 20 * MIN; i--) if (!only || calls[i].flight === only) out.push(calls[i]);
  return out.reverse();
}
