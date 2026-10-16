/**
 * EXTRACT — Roomglow case study.
 *
 * Copied verbatim from the private Roomglow repository, and deliberately incomplete: the
 * modules it imports (the database layer, the HTTP router, the routes, the seed) are not
 * published here, so this will not compile or run on its own. It is here to be read.
 *
 * (c) Abdullah Rathore. All rights reserved.
 */

/**
 * Sign-in throttling.
 *
 * In memory, which is correct here because this is one long-lived process. Two counters
 * on purpose: per identity (so one room's PIN cannot be ground down from many phones)
 * and per address (so one phone cannot sweep every room). Failures back off
 * exponentially; a success clears the identity's counter, so an educator who fat-fingers
 * a PIN twice and then gets it right is never punished.
 *
 * Adapted from the pattern in al-amin-al-tajir-crm/packages/server/src/core/ratelimit.ts,
 * with a shorter free-attempt allowance because a 4-digit PIN has a 10,000-value keyspace
 * and a password does not.
 */
interface Bucket {
  failures: number;
  lockedUntil: number;
  last: number;
}

const byIdentity = new Map<string, Bucket>();
const byAddress = new Map<string, Bucket>();

const FREE_ATTEMPTS = 3;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 10 * 60_000;
const FORGET_AFTER_MS = 60 * 60_000;
const ADDRESS_ATTEMPT_CAP = 40;

function sweep(map: Map<string, Bucket>, now: number): void {
  if (map.size < 500) return;
  for (const [key, bucket] of map) if (now - bucket.last > FORGET_AFTER_MS) map.delete(key);
}

function bucketFor(map: Map<string, Bucket>, key: string, now: number): Bucket {
  const existing = map.get(key);
  if (existing && now - existing.last <= FORGET_AFTER_MS) return existing;
  const fresh: Bucket = { failures: 0, lockedUntil: 0, last: now };
  map.set(key, fresh);
  return fresh;
}

export interface Verdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkAttempt(identity: string, address: string): Verdict {
  const now = Date.now();
  sweep(byIdentity, now);
  sweep(byAddress, now);

  const id = bucketFor(byIdentity, identity.toLowerCase(), now);
  const addr = bucketFor(byAddress, address, now);

  const lockedUntil = Math.max(id.lockedUntil, addr.lockedUntil);
  if (lockedUntil > now) return { allowed: false, retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) };
  if (addr.failures > ADDRESS_ATTEMPT_CAP) {
    return { allowed: false, retryAfterSeconds: Math.ceil(MAX_DELAY_MS / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailure(identity: string, address: string): void {
  const now = Date.now();

  // Backoff belongs to the identity — this room's PIN, this email address.
  const id = bucketFor(byIdentity, identity.toLowerCase(), now);
  id.failures += 1;
  id.last = now;
  if (id.failures > FREE_ATTEMPTS) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (id.failures - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
    id.lockedUntil = now + delay;
  }

  // The address only ever gets the blunt cap, never the backoff.
  //
  // This was the other way round first, and a test exposed what that means in a real
  // centre: a building behind one router is one address to this server, so four typos on
  // one tablet would have locked every tablet in the centre out of signing in. A sweep
  // across many rooms from one address is still stopped, at the cap.
  const addr = bucketFor(byAddress, address, now);
  addr.failures += 1;
  addr.last = now;
  if (addr.failures > ADDRESS_ATTEMPT_CAP) addr.lockedUntil = now + MAX_DELAY_MS;
}

export function recordSuccess(identity: string, address: string): void {
  byIdentity.delete(identity.toLowerCase());
  const addr = byAddress.get(address);
  if (addr) {
    addr.failures = 0;
    addr.lockedUntil = 0;
    addr.last = Date.now();
  }
}

/** Test seam. Never called by the server. */
export function resetLimits(): void {
  byIdentity.clear();
  byAddress.clear();
}
