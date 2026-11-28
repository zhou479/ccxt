"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { readMarketResponse } from "@/lib/market-response";
import type { DataKind, DatasetSnapshot, StudyJob } from "@/lib/study-types";

const RUNNING_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

async function post<T>(path: string, body: unknown, failure: string): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return readMarketResponse<T>(response, failure);
}

/** 研究数据集和资金费率检验的状态；下载或检验进行中时更频繁地刷新。 */
export function useStudy() {
  const [mode, setMode] = useState<"loading" | "local" | "unavailable">("loading");
  const [dataset, setDataset] = useState<DatasetSnapshot | null>(null);
  const [study, setStudy] = useState<StudyJob | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (mode === "unavailable") return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let running = false;
      try {
        const options = { cache: "no-store" as const, signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) };
        const [datasetResponse, studyResponse] = await Promise.all([
          fetch(apiUrl("/api/dataset"), options), fetch(apiUrl("/api/study"), options),
        ]);
        if (request.signal.aborted) return;
        if (datasetResponse.status === 403 || studyResponse.status === 403) {
          setMode("unavailable");
          return;
        }
        const [nextDataset, nextStudy] = await Promise.all([
          readMarketResponse<DatasetSnapshot>(datasetResponse, "无法读取研究数据集。"),
          readMarketResponse<StudyJob>(studyResponse, "无法读取策略检验结果。"),
        ]);
        if (request.signal.aborted) return;
        setMode("local");
        setDataset(nextDataset);
        setStudy(nextStudy);
        setError("");
        running = nextDataset.job.status === "running" || nextStudy.status === "running";
      } catch (caught) {
        if (!request.signal.aborted) setError(caught instanceof Error ? caught.message : "无法读取策略检验。");
      }
      if (!request.signal.aborted) timer = setTimeout(poll, running ? RUNNING_POLL_MS : IDLE_POLL_MS);
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [mode, refreshKey]);

  /** 更新研究数据；不传 kind 时是一起下载合约列表、小时K线和资金费率。 */
  const prepare = useCallback(async (days: number, kind?: DataKind) => {
    await post("/api/dataset/prepare", kind ? { days, kind } : { days }, "无法开始更新研究数据。");
    setRefreshKey((key) => key + 1);
  }, []);

  /** 删除一类研究数据（连同已下载区间）。 */
  const remove = useCallback(async (kind: DataKind) => {
    await post("/api/dataset/delete", { kind }, "无法删除数据。");
    setRefreshKey((key) => key + 1);
  }, []);

  const cancel = useCallback(async () => {
    await post("/api/dataset/cancel", {}, "无法停止下载。");
    setRefreshKey((key) => key + 1);
  }, []);

  const run = useCallback(async (days: number, top: number) => {
    await post("/api/study/run", { days, top }, "无法开始策略检验。");
    setRefreshKey((key) => key + 1);
  }, []);

  return { mode, dataset, study, error, prepare, cancel, remove, run };
}
