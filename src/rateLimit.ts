// ponytail: 全域 in-memory Map、per-key 固定窗口，單機夠用。多實例或要跨重啟保留就換 Redis。
//   entry 每次讀寫順便清過期，另有 maxKeys 硬上限擋「大量不同 key 灌爆記憶體」。
// now 參數可注入，讓測試不依賴真實時鐘。
export interface RateLimiter {
  check(key: string, now?: number): boolean; // true = 還在額度內
  fail(key: string, now?: number): void; // 記一次失敗
  reset(key: string): void; // 成功後清零
  getSize?(): number; // 測試用：返回目前 Map size
}

export function createRateLimiter(windowMs: number, max: number, maxKeys = 10000): RateLimiter {
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
      // 新 key 且已達上限：cleanup 已先清過期，仍滿就淘汰最舊的一筆（Map 保插入序）。
      // ponytail: 淘汰的是最早「第一次出現」的 key，不是最久沒用的；要真 LRU 再說。
      if (!rec && hits.size >= maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
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
