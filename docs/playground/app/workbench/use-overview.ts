"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { readMarketResponse } from "@/lib/market-response";
import type { TradingOverview } from "@/lib/trading-types";

const POLL_MS = 5_000;

/** 每 5 秒读取一次账户资金、持仓和盈亏曲线；只在本机设置模式下可用。 */
export function useOverview(active: boolean) {
  const [mode, setMode] = useState<"loading" | "local" | "unavailable">("loading");
  const [data, setData] = useState<TradingOverview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active || mode === "unavailable") return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(apiUrl("/api/trading/overview"), {
          cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
        });
        if (request.signal.aborted) return;
        if (response.status === 403) {
          setMode("unavailable");
          return;
        }
        const overview = await readMarketResponse<TradingOverview>(response, "无法读取账户总览。");
        if (request.signal.aborted) return;
        setMode("local");
        setData(overview);
        setError("");
      } catch (caught) {
        if (!request.signal.aborted) setError(caught instanceof Error ? caught.message : "无法读取账户总览。");
      }
      if (!request.signal.aborted) timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [active, mode]);

  return { mode, data, error };
}
