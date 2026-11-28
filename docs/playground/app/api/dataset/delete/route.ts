import { isLocalSettingsRequest, isSameOrigin, readLocalJson } from "@/lib/local-settings-request";
import { proxyMarketRequest } from "@/lib/market-service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isLocalSettingsRequest(request) || !isSameOrigin(request)) {
    return Response.json({ error: "删除数据仅可在本机发起。" }, { status: 403 });
  }
  const body = await readLocalJson(request);
  if (body.status !== 200) {
    const error = body.status === 413 ? "请求体过大。" : body.status === 415 ? "需要 JSON 格式的参数。" : "参数无效。";
    return Response.json({ error }, { status: body.status });
  }
  return proxyMarketRequest("/api/dataset/delete", request, body.text);
}
