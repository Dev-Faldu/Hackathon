import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { toLocalIso } from "./format";
import type { Meta, Scenario } from "./types";

export type Screen = "setup" | "bookings" | "parking" | "world" | "plan" | "live" | "whatif" | "after" | "la28";
export interface Toast { id: number; title: string; body?: string; tone?: "ok" | "info" | "alert" }

interface Ctx {
  meta: Meta | null;
  refreshMeta: () => void;
  screen: Screen;
  go: (s: Screen) => void;
  scenario: Scenario;
  setScenario: (s: Scenario) => void;
  tMs: number;
  tIso: string;
  setT: (ms: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  speed: number;
  setSpeed: (s: number) => void;
  windowMs: [number, number];
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  decisionsVersion: number;
  bumpDecisions: () => void;
}

const AppCtx = createContext<Ctx | null>(null);
const SCREENS: Screen[] = ["setup", "bookings", "parking", "world", "plan", "live", "whatif", "after", "la28"];

const fromHash = (): Screen => {
  const h = window.location.hash.replace("#", "") as Screen;
  return SCREENS.includes(h) ? h : "parking";
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [screen, setScreen] = useState<Screen>(fromHash);
  const [scenario, setScenario] = useState<Scenario>("medium");
  const [tMs, setTMs] = useState(() => Date.parse("2027-02-12T13:00:00-08:00"));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(600);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [decisionsVersion, setDV] = useState(0);
  const seeded = useRef(false);

  const refreshMeta = useCallback(() => {
    api.meta().then((m) => {
      setMeta(m);
      if (!seeded.current) {
        seeded.current = true;
        const fromUrl = new URLSearchParams(window.location.search).get("t");
        setTMs(Date.parse(fromUrl && !Number.isNaN(Date.parse(fromUrl)) ? fromUrl : m.demo_t));
      }
    }).catch(() => setTimeout(refreshMeta, 1500));
  }, []);
  useEffect(refreshMeta, [refreshMeta]);

  useEffect(() => {
    const onHash = () => setScreen(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const windowMs = useMemo<[number, number]>(() => {
    const w = meta?.window ?? ["2027-02-09", "2027-02-15"];
    return [Date.parse(`${w[0]}T00:00:00-08:00`), Date.parse(`${w[w.length - 1]}T23:59:00-08:00`)];
  }, [meta]);

  const setT = useCallback((ms: number) => setTMs(Math.min(windowMs[1], Math.max(windowMs[0], ms))), [windowMs]);

  // Replay clock: advances simulated time at `speed`x while playing; ticks 4 times a second.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setTMs((t) => {
      const next = t + speed * 250;
      if (next >= windowMs[1]) { setPlaying(false); return windowMs[1]; }
      return next;
    }), 250);
    return () => clearInterval(id);
  }, [playing, speed, windowMs]);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4200);
  }, []);

  const go = useCallback((s: Screen) => { window.location.hash = s; setScreen(s); }, []);

  const value: Ctx = {
    meta, refreshMeta, screen, go, scenario, setScenario, tMs, tIso: toLocalIso(tMs), setT, playing, setPlaying,
    speed, setSpeed, windowMs, toasts, toast, decisionsVersion, bumpDecisions: () => setDV((v) => v + 1),
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
};

/** A slower-moving copy of the replay time, so live panels refetch about every 5 simulated minutes. */
export function useReplayTick(stepMin = 5) {
  const { tMs } = useApp();
  const step = stepMin * 60 * 1000;
  const bucket = Math.floor(tMs / step) * step;
  return { bucketMs: bucket, bucketIso: toLocalIso(bucket) };
}
