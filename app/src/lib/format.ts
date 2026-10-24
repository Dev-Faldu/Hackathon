import type { SizeClass } from "./types";

const TZ = "America/Los_Angeles";

export const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

export const dayShort = (iso: string) =>
  new Date(iso.length === 10 ? iso + "T12:00:00-08:00" : iso).toLocaleDateString("en-US", { weekday: "short", timeZone: TZ });

export const dayLabel = (iso: string) =>
  new Date(iso.length === 10 ? iso + "T12:00:00-08:00" : iso).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: TZ,
  });

export const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const SIZE_LABEL: Record<SizeClass, string> = {
  light: "Light", mid: "Midsize", super_mid: "Super-mid", large: "Large cabin", other: "Other",
};

export const SIZE_COLOR: Record<SizeClass, string> = {
  light: "#7DD3FC", mid: "#60A5FA", super_mid: "#818CF8", large: "#2563EB", other: "#94A3B8",
};

/** Local wall-clock ISO with the -08:00 offset (February in LA). */
export const toLocalIso = (ms: number) => {
  const d = new Date(ms - 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16) + "-08:00";
};

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** How each data source is named on screen: a real pull, the published-count rebuild, or the seeded week. */
export const SOURCE: Record<string, { label: string; replay: string; chip: string; sentence: string }> = {
  opensky_2022_shifted: { label: "Real 2022 replay (OpenSky)", replay: "Real 2022 replay", chip: "Real 2022 week",
    sentence: "the real Super Bowl LVI week (2022, same stadium) from OpenSky, shifted to 2027 dates" },
  reconstructed_2022: { label: "2022 week, from published counts", replay: "2022 replay", chip: "2022 week rebuilt",
    sentence: "the Super Bowl LVI week (2022, same stadium) rebuilt from published counts (501 Friday arrivals, 548 Monday departures) and shifted to 2027 dates" },
  sample: { label: "Sample week (seeded)", replay: "Sample replay", chip: "Sample week",
    sentence: "a seeded week shaped by public Super Bowl analogs" },
};
export const sourceOf = (s?: string) => SOURCE[s ?? "sample"] ?? SOURCE.sample;
