/**
 * Rate-limit handling (ticket 05): GitHub's documented back-off for writes
 * moved onto the publisher's client surface.
 *
 * A 403/429 response with `Retry-After` waits that duration before the
 * request retries; without the header (a secondary rate limit usually), it
 * waits at least one minute. Successive rate-limit responses back off
 * exponentially: 1min, 2min, 4min... capped well beyond any single run's
 * needs and re-throwing to the caller once the attempts run out. Auth
 * (401), permission (403 on an unrate-limited response) and anchor (422)
 * errors are never retried: they fail once with a reason.
 */
import type { HttpResponse } from "./publisher.js";

/** First fallback wait when GitHub answers 403/429 without `Retry-After`. */
export const RATE_LIMIT_MIN_WAIT_MS = 60_000;
/** Cap on the exponential growth so a bounded loop stays bounded. */
const RATE_LIMIT_MAX_WAIT_MS = 32 * RATE_LIMIT_MIN_WAIT_MS;

/** Classify one GitHub response for the retry client. */
export function isRateLimited(status: number): boolean {
  return status === 403 || status === 429;
}

/** Parse `Retry-After` (seconds, integer, per RFC 7231) from a response's stored headers. */
export function retryAfterMs(storedHeaders: Record<string, string> | undefined | null): number | undefined {
  const value = storedHeaders?.["retry-after"];
  if (value === undefined) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.max(0, seconds) * 1000;
}

/**
 * Wait for one rate-limit response: `Retry-After` when present, else the
 * one-minute minimum, and each successive response of a run doubles its
 * predecessor (exponential back-off).
 */
export async function rateLimitDelayMs(
  status: number,
  rateLimitStreak: number,
  getHeaders: () => Record<string, string>,
): Promise<number> {
  if (!isRateLimited(status)) return 0;
  const retryAfter = retryAfterMs(getHeaders());
  const exponential = Math.min(
    RATE_LIMIT_MAX_WAIT_MS,
    RATE_LIMIT_MIN_WAIT_MS * 2 ** Math.max(0, rateLimitStreak - 1),
  );
  return Math.max(exponential, retryAfter ?? 0);
}
