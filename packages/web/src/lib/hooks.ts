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

  const reload = useCallback(async () => {
    try {
      const v = await fnRef.current();
      if (alive.current) {
        setData(v);
        setError(undefined);
      }
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setLoading(false);
      return () => void (alive.current = false);
    }
    setLoading(true);
    void reload();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void reload();
    }, ms);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [ms, key, enabled, reload]);

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
