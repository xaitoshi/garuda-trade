import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  /** Replace the cached value (e.g. with a fresher state returned by a POST). */
  set: (v: T) => void;
}

/** Run `fn` now and every `ms`; pauses while the tab is hidden. `key` restarts it. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, key: unknown, enabled = true): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(enabled);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  // Requests belong to one run of the effect (one `key`): a late answer from a previous key is dropped, and a tick is
  // skipped while this run's previous request is still open, so a slow API never piles requests up.
  const gen = useRef(0);
  const inFlight = useRef(false);

  const run = useCallback(async (g: number) => {
    inFlight.current = true;
    try {
      const v = await fnRef.current();
      if (alive.current && g === gen.current) {
        setData(v);
        setError(undefined);
      }
    } catch (e) {
      if (alive.current && g === gen.current) setError(e);
    } finally {
      if (g === gen.current) {
        inFlight.current = false;
        if (alive.current) setLoading(false);
      }
    }
  }, []);

  /** Fetch now, even if a poll is open (after an order the caller wants the fresh state). */
  const reload = useCallback(() => run(gen.current), [run]);

  useEffect(() => {
    alive.current = true;
    const g = ++gen.current;
    inFlight.current = false;
    if (!enabled) {
      setLoading(false);
      return () => void (alive.current = false);
    }
    setLoading(true);
    void run(g);
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden" && !inFlight.current) void run(g);
    }, ms);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [ms, key, enabled, run]);

  return { data, error, loading, reload, set: setData };
}

export function useNow(ms = 1000): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}
