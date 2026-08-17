// Fixed-window rate limiter, shared by the edge functions.
//
// Backed by the `rate_limits` table via the `rate_limit_hit` SQL function
// (db/004_rate_limits.sql), which increments the current window's counter and
// reports the verdict atomically. Keeping the state in the database means the
// limit holds across function instances and cold starts, which an in-memory
// counter cannot.

// Structural type: just the `.rpc` we use, so this module needs no dependency
// on the supabase-js type exports.
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;   // remaining allowance in this window
  retryAfter: number;  // seconds until the window resets (0 while allowed)
}

// Record a hit against `key` and return whether it is within `limit` for the
// current `windowSeconds` window. Returns null if the limiter itself errors, so
// callers can decide to fail open (a limiter outage shouldn't block real users).
export async function rateLimit(
  supabase: RpcClient,
  key: string,
  opts: { limit: number; windowSeconds: number },
): Promise<RateLimitResult | null> {
  const { data, error } = await supabase.rpc('rate_limit_hit', {
    p_key: key,
    p_limit: opts.limit,
    p_window_seconds: opts.windowSeconds,
  });
  if (error) {
    console.error('[rate-limit]', error.message);
    return null;
  }
  // The SQL function RETURNS TABLE, so PostgREST hands back a one-row array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed: boolean; remaining: number; retry_after: number }
    | undefined;
  if (!row) return null;
  return { allowed: row.allowed, remaining: row.remaining, retryAfter: row.retry_after };
}
