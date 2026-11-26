import { isLocalSettingsRequest } from "@/lib/local-settings-request";
import { proxyMarketRequest } from "@/lib/market-service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  if (!isLocalSettingsRequest(request)) {
    return Response.json({ error: "策略检验仅在本地设置模式下可用。" }, { status: 403 });
  }
  return proxyMarketRequest("/api/study", request);
}
