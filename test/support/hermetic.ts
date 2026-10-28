/**
 * Makes a test run self-contained, so it behaves the same on a laptop and in
 * a CI pipeline with nothing provisioned. Loaded by both the unit and the e2e
 * Jest configs (setupFiles), before any test imports application code.
 *
 * - JWT keys: a fresh RSA pair is generated in memory for every run, so no
 *   test reads the gitignored keys/ folder (or a real signing key).
 * - Network: every outbound connection is refused, except to this machine.
 *   Loopback stays open because supertest talks to the app over a local
 *   socket. Anything else (Google, Paystack, Photon, FCM, S3/B2, SMTP,
 *   Resend) must be mocked; a test that forgets fails loudly instead of
 *   quietly depending on the internet.
 */
import { generateKeyPairSync } from 'crypto';
import dns from 'dns';
import * as net from 'net';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.JWT_PRIVATE_KEY = privateKey;
process.env.JWT_PUBLIC_KEY = publicKey;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

function refuse(target: string): Error {
  return new Error(
    `[hermetic tests] network access to "${target}" is blocked. Mock the external service instead.`,
  );
}

/** Host of a net.connect / socket.connect call, whatever its argument shape. */
function hostOf(args: unknown[]): string | undefined {
  const [first, second] = args;
  // net.connect() and http agents pass their already-normalized arguments
  // on as a single array.
  if (Array.isArray(first)) return hostOf(first);
  if (typeof first === 'object' && first !== null) {
    const opts = first as { host?: string; path?: string };
    if (opts.path) return undefined; // a local IPC/unix socket
    return opts.host ?? 'localhost';
  }
  if (typeof first === 'number') {
    return typeof second === 'string' ? second : 'localhost';
  }
  return undefined; // a unix socket path
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;
const originalConnect = Object.getOwnPropertyDescriptor(
  net.Socket.prototype,
  'connect',
)!.value as Connect;
const guardedConnect: Connect = function connect(this: net.Socket, ...args) {
  const host = hostOf(args);
  if (host !== undefined && !LOOPBACK.has(host)) throw refuse(host);
  return Reflect.apply(originalConnect, this, args);
};
Object.defineProperty(net.Socket.prototype, 'connect', {
  value: guardedConnect,
  writable: true,
  configurable: true,
});

const originalFetch = globalThis.fetch;
globalThis.fetch = function fetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(host)) return Promise.reject(refuse(host));
  return originalFetch(input, init);
};

// Name lookups are the first step of any outbound call; refuse them too so a
// client that resolves before connecting fails at once instead of timing out.
const originalLookup = dns.lookup;
(dns as { lookup: unknown }).lookup = function lookup(
  hostname: string,
  ...rest: unknown[]
) {
  if (LOOPBACK.has(hostname)) {
    return (originalLookup as (...a: unknown[]) => void)(hostname, ...rest);
  }
  const callback = rest[rest.length - 1];
  if (typeof callback === 'function') {
    process.nextTick(() => (callback as (e: Error) => void)(refuse(hostname)));
    return;
  }
  throw refuse(hostname);
};
