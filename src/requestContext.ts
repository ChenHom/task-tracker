import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context：server 在每個 request 最外層 run 一次，command 內的 buildMetadata 從這裡讀
// ip / user_agent / request_id，不必把它們一路穿過每個 command 簽名。
export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

// event_store 就是 audit log：每個 append 的 metadata 記「誰(actor)、從哪(ip/ua)、哪次請求(request_id)」。
// 測試直接呼叫 command（無 HTTP context）時 ip/ua/request_id 為 null，只留 actor_id。
export function buildMetadata(actorId: string): Record<string, unknown> {
  const ctx = als.getStore() ?? {};
  return {
    actor_id: actorId,
    ip: ctx.ip ?? null,
    user_agent: ctx.userAgent ?? null,
    request_id: ctx.requestId ?? null,
  };
}
