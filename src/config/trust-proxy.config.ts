/**
 * Resolves `TRUST_PROXY_HOPS` — the number of proxies in front of this process
 * — and refuses to let a production deployment guess.
 *
 * ── Why this is a boot-time error and not a default ─────────────────────────
 * The auth rate limits key on `req.ip`, so `req.ip` has to actually *be* the
 * client. Behind a reverse proxy or PaaS router (which is how this API is
 * deployed) it isn't: Express reports the nearest hop unless it is told how
 * many hops to trust. Treating "unset" as 0 therefore made the *dangerous*
 * value the default, and the failure was silent — the boot log line only
 * appeared in the correct configuration, so a misconfigured deploy looked
 * identical to a healthy one until every login on the platform started
 * returning 429. With one shared `ip-<proxy-address>` bucket, ten requests a
 * minute from a single host is enough to lock out `login`,
 * `restore-account`, `reset-password` and `verify-email` for every user —
 * including the only self-serve way to recover a deleted account inside its
 * 30-day window.
 *
 * So: in production the variable must be set *explicitly*, to `0` or to a hop
 * count. Following the `SESSION_COOKIE_SECRET` precedent in
 * `auth/utils/session-cookie.util.ts`, an unset value throws at boot rather
 * than degrading quietly.
 *
 * ── Why a hop count rather than `trust proxy: true` ─────────────────────────
 * `true` makes Express take the left-most `X-Forwarded-For` entry, which is
 * whatever the caller chose to put there — an IP-keyed limit would then be
 * bypassable by setting a header. A hop count makes Express skip exactly that
 * many trusted hops counted from the connection inwards, so the resolved
 * address is one the infrastructure vouches for.
 */

/** What `app.set('trust proxy', …)` should be given, plus how to explain it. */
export interface TrustProxyResolution {
  /** `0` means "not behind a proxy" — `req.ip` stays the socket address. */
  hops: number;
  /** Log line for boot, so the effective setting is never ambiguous. */
  description: string;
  /** True when the resolved setting leaves every client in one bucket if the guess is wrong. */
  warn: boolean;
}

export const TRUST_PROXY_HOPS_ENV = 'TRUST_PROXY_HOPS';

export function resolveTrustProxyHops(
  env: NodeJS.ProcessEnv = process.env,
): TrustProxyResolution {
  const raw = env[TRUST_PROXY_HOPS_ENV]?.trim();
  const isProduction = env.NODE_ENV === 'production';

  if (raw === undefined || raw === '') {
    if (isProduction) {
      throw new Error(
        `${TRUST_PROXY_HOPS_ENV} must be set in production. Use the number of ` +
          `proxies in front of this process (1 for a typical single reverse ` +
          `proxy or PaaS router), or 0 if the process is directly exposed. ` +
          `Leaving it unset behind a proxy makes every request on the ` +
          `deployment share one rate-limit bucket, which takes down login for ` +
          `all users after ten attempts from any single host.`,
      );
    }
    return {
      hops: 0,
      description:
        `${TRUST_PROXY_HOPS_ENV} is unset — trusting no proxy, so req.ip is the ` +
        `socket address. Correct for local development and a directly-exposed ` +
        `process; required to be set explicitly in production.`,
      warn: false,
    };
  }

  const hops = Number(raw);
  // A malformed value is always a mistake, and it used to fail *unsafely*:
  // `Number('one')` is NaN, which failed the old `> 0` check and silently
  // resolved to "trust nothing" — the exact broken state this guards against.
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(
      `${TRUST_PROXY_HOPS_ENV} must be a non-negative integer (got "${raw}"). ` +
        `It is a count of proxy hops, not a boolean.`,
    );
  }

  if (hops === 0) {
    return {
      hops: 0,
      description:
        `${TRUST_PROXY_HOPS_ENV}=0 — trusting no proxy, so req.ip is the socket ` +
        `address. If anything sits in front of this process, every client shares ` +
        `one rate-limit bucket.`,
      warn: isProduction,
    };
  }

  return {
    hops,
    description: `Trusting ${hops} proxy hop(s) for client IP resolution (${TRUST_PROXY_HOPS_ENV}=${hops})`,
    warn: false,
  };
}
