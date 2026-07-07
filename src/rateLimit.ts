// ponytail: 全域 in-memory Map、per-key 固定窗口，單機夠用。
//   多實例或要跨重啟保留就換 Redis；entry 不主動 GC（數量級 = 活躍 key），量大再加定期清或 LRU。
// now 參數可注入，讓測試不依賴真實時鐘。
export interface RateLimiter {
  check(key: string, now?: number): boolean; // true = 還在額度內
  fail(key: string, now?: number): void; // 記一次失敗
  reset(key: string): void; // 成功後清零
  getSize?(): number; // 測試用：返回目前 Map size
}

export function createRateLimiter(windowMs: number, max: number): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  function cleanup(now: number) {
    // ponytail: 每次讀寫時順便清過期 key，避免 Map 只增不減
    for (const [key, rec] of hits) {
      if (now > rec.resetAt) hits.delete(key);
    }
  }
  function slot(key: string, now: number) {
    let rec = hits.get(key);
    if (!rec || now > rec.resetAt) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(key, rec);
    }
    return rec;
  }
  return {
    check: (key, now = Date.now()) => {
      cleanup(now);
      return slot(key, now).count < max;
    },
    fail: (key, now = Date.now()) => {
      cleanup(now);
      slot(key, now).count++;
    },
    reset: (key) => {
      hits.delete(key);
    },
    getSize: () => hits.size,
  };
}
