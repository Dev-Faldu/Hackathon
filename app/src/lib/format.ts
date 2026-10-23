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
