/**
 * The test run must not depend on anything outside this machine. Checks that
 * support/hermetic.ts refuses real network calls (the way Paystack, Google,
 * Firebase, S3/B2 and the mail providers would be reached) while loopback,
 * used by supertest and the in-memory test database, keeps working.
 */
import * as https from 'https';
import * as net from 'net';
import dns from 'dns';
import { createServer } from 'http';

describe('Hermetic test run', () => {
  it('refuses fetch to a real API', async () => {
    await expect(fetch('https://api.paystack.co/bank')).rejects.toThrow(
      /blocked/,
    );
  });

  it('refuses raw sockets', () => {
    expect(() => net.connect(443, 'oauth2.googleapis.com')).toThrow(/blocked/);
  });

  it('refuses https requests (axios, firebase-admin, aws-sdk)', async () => {
    const outcome = await new Promise<unknown>((resolve) => {
      try {
        const req = https.get('https://oauth2.googleapis.com/token');
        req.on('error', resolve);
        req.on('response', () => resolve('connected'));
      } catch (err) {
        resolve(err);
      }
    });
    expect(String(outcome)).toMatch(/blocked/);
  });

  it('refuses DNS lookups', async () => {
    const outcome = await new Promise<unknown>((resolve) =>
      dns.lookup('fcm.googleapis.com', (err) => resolve(err)),
    );
    expect(String(outcome)).toMatch(/blocked/);
  });

  it('still allows loopback', async () => {
    const server = createServer((_req, res) => res.end('ok')).listen(
      0,
      '127.0.0.1',
    );
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as net.AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}`);
    expect(await res.text()).toBe('ok');
    server.close();
  });

  it('signs tokens with keys generated for this run, not keys/', () => {
    expect(process.env.JWT_PUBLIC_KEY).toMatch(/BEGIN PUBLIC KEY/);
    expect(process.env.JWT_PRIVATE_KEY).toMatch(/BEGIN PRIVATE KEY/);
  });

  const inMemoryDb = process.env.E2E_REAL_POSTGRES === '1' ? it.skip : it;
  inMemoryDb('uses the in-memory database on this machine', () => {
    expect(process.env.DB_HOST).toBe('127.0.0.1');
    expect(process.env.DB_NAME).toBe('postgres');
  });
});
