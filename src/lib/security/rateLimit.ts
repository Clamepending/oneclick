const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

export function applyMemoryRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const current = memoryBuckets.get(key);

  if (!current || current.resetAt <= now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  if (current.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  current.count += 1;
  memoryBuckets.set(key, current);
  return { allowed: true, remaining: limit - current.count };
}
