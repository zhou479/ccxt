"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { readMarketResponse } from "@/lib/market-response";
import type { ScanParams, SignalScan, SignalSnapshot, SignalSource } from "@/lib/signal-types";

const RUNNING_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

/** Loads signal samples of one source; polls faster while a historical scan is running. */
export function useSignals(source: SignalSource) {
  const [mode, setMode] = useState<"loading" | "local" | "unavailable">("loading");
  const [data, setData] = useState<SignalSnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (mode === "unavailable") return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let running = false;
      try {
        const response = await fetch(apiUrl(`/api/signals?source=${source}`), {
          cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
        });
        if (request.signal.aborted) return;
        if (response.status === 403) {
          setMode("unavailable");
          return;
        }
        const snapshot = await readMarketResponse<SignalSnapshot>(response, "无法读取信号统计。");
        if (request.signal.aborted) return;
        setMode("local");
        setData(snapshot);
        setError("");
        running = snapshot.scan.status === "running";
      } catch (caught) {
        if (!request.signal.aborted) setError(caught instanceof Error ? caught.message : "无法读取信号统计。");
      }
      if (!request.signal.aborted) timer = setTimeout(poll, running ? RUNNING_POLL_MS : IDLE_POLL_MS);
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [mode, source, refreshKey]);

  const startScan = useCallback(async (params: ScanParams) => {
    const response = await fetch(apiUrl("/api/signals/scan"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await readMarketResponse<{ scan: SignalScan }>(response, "无法开始历史扫描。");
    setRefreshKey((key) => key + 1);
    return result.scan;
  }, []);

  return { mode, data, error, startScan };
}
