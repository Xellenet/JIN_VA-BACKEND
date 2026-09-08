import {
  resolveTrustProxyHops,
  TRUST_PROXY_HOPS_ENV,
} from './trust-proxy.config';

/**
 * H2: the boot-time decision behind every per-IP auth rate limit.
 *
 * The property that matters is that the *dangerous* configuration can no
 * longer be reached by accident. Leaving `TRUST_PROXY_HOPS` unset behind a
 * reverse proxy makes `req.ip` the proxy's address, so all eight throttled
 * auth routes share one `ip-<proxy-address>` bucket and ten requests from any
 * single host lock out `login`, `restore-account`, `reset-password` and
 * `verify-email` platform-wide. So: unset must be fatal in production, a
 * malformed value must be fatal everywhere, and every other outcome must
 * describe itself for the boot log.
 *
 * `resolveTrustProxyHops` takes its environment as an argument precisely so
 * this can be verified without mutating the real `process.env`.
 */
describe('resolveTrustProxyHops (H2)', () => {
  /** Builds an env without planting an explicit `undefined` NODE_ENV key. */
  const env = (nodeEnv?: string, hops?: string): NodeJS.ProcessEnv => ({
    ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
    ...(hops === undefined ? {} : { [TRUST_PROXY_HOPS_ENV]: hops }),
  });

  describe('unset outside production', () => {
    it('trusts no proxy without throwing, since a dev process is directly exposed', () => {
      const resolution = resolveTrustProxyHops({});

      expect(resolution.hops).toBe(0);
      expect(resolution.warn).toBe(false);
    });

    it.each(['development', 'test', 'staging', undefined])(
      'resolves quietly to 0 hops when NODE_ENV is %s',
      (nodeEnv) => {
        const resolution = resolveTrustProxyHops(env(nodeEnv));

        expect(resolution.hops).toBe(0);
        expect(resolution.warn).toBe(false);
      },
    );

    it.each(['', '   '])(
      'treats a blank value (%p) as unset rather than as a number',
      (blank) => {
        // `Number('')` is 0, so a blank value must be routed through the
        // "unset" branch explicitly or it would look deliberately configured.
        const resolution = resolveTrustProxyHops(env('development', blank));

        expect(resolution.hops).toBe(0);
        expect(resolution.warn).toBe(false);
      },
    );

    it('still explains the effective setting, so the boot log is never silent', () => {
      const resolution = resolveTrustProxyHops({});

      expect(resolution.description).toContain(TRUST_PROXY_HOPS_ENV);
      expect(resolution.description).not.toHaveLength(0);
    });
  });

  describe('unset in production', () => {
    it('refuses to boot rather than defaulting to the value that breaks login', () => {
      expect(() => resolveTrustProxyHops(env('production'))).toThrow(
        /must be set in production/,
      );
    });

    it.each(['', '   '])(
      'refuses to boot on a blank value (%p) too',
      (blank) => {
        expect(() => resolveTrustProxyHops(env('production', blank))).toThrow(
          /must be set in production/,
        );
      },
    );

    it('names the variable and the values an operator should choose', () => {
      let message = '';
      try {
        resolveTrustProxyHops(env('production'));
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain(TRUST_PROXY_HOPS_ENV);
      expect(message).toContain('0');
      expect(message).toContain('1');
    });
  });

  describe('a malformed value is fatal in every environment', () => {
    // Each of these is NaN, fractional or negative under `Number(…)`.
    const malformed = [
      'one',
      'true',
      'false',
      '1.5',
      '-1',
      '-2',
      'Infinity',
      '1 hop',
    ];
    const environments = ['production', 'development', 'test', undefined];

    for (const nodeEnv of environments) {
      it.each(malformed)(
        `throws on %p when NODE_ENV is ${String(nodeEnv)}`,
        (value) => {
          expect(() => resolveTrustProxyHops(env(nodeEnv, value))).toThrow(
            /must be a non-negative integer/,
          );
        },
      );
    }

    it('fails loudly on a NaN value, which used to resolve silently to "trust nothing"', () => {
      // The regression this guards: `Number('one')` is NaN, NaN failed the old
      // `> 0` check, and the process booted into the single-bucket state with
      // no log line at all.
      expect(() => resolveTrustProxyHops(env('production', 'one'))).toThrow(
        Error,
      );
    });

    it('says the variable is a hop count and not a boolean', () => {
      let message = '';
      try {
        resolveTrustProxyHops(env('production', 'true'));
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('not a boolean');
      expect(message).toContain('true');
    });
  });

  describe('an explicit 0', () => {
    it('warns in production, because it is only correct if nothing sits in front', () => {
      const resolution = resolveTrustProxyHops(env('production', '0'));

      expect(resolution.hops).toBe(0);
      expect(resolution.warn).toBe(true);
      expect(resolution.description).toContain('one rate-limit bucket');
    });

    it('does not warn outside production, where a direct socket is the norm', () => {
      const resolution = resolveTrustProxyHops(env('development', '0'));

      expect(resolution.hops).toBe(0);
      expect(resolution.warn).toBe(false);
    });
  });

  describe('a positive hop count', () => {
    it.each([1, 2, 3, 10])('resolves %i to that many trusted hops', (hops) => {
      const resolution = resolveTrustProxyHops(env('production', String(hops)));

      expect(resolution.hops).toBe(hops);
      expect(resolution.warn).toBe(false);
      expect(resolution.description).toContain(String(hops));
      expect(resolution.description).toContain(TRUST_PROXY_HOPS_ENV);
    });

    it('tolerates surrounding whitespace from a copy-pasted deploy variable', () => {
      expect(resolveTrustProxyHops(env('production', ' 2 ')).hops).toBe(2);
    });

    it('is unaffected by the environment, since a proxy count is a fact about the topology', () => {
      expect(resolveTrustProxyHops(env('development', '1')).hops).toBe(1);
      expect(resolveTrustProxyHops(env('production', '1')).hops).toBe(1);
    });
  });
});
