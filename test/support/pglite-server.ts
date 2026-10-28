/**
 * Serves an in-memory PGlite database over the Postgres wire protocol, so the
 * app's normal pg/TypeORM connection pool can use it in tests.
 *
 * PGlite is a single session, but the pool opens several connections. This
 * server shares the session safely:
 *
 * - A request is a whole round trip, not one protocol message. The pg driver
 *   sends Parse, Bind, Describe, Execute and Sync as separate messages and
 *   relies on the unnamed statement/portal surviving between them, so
 *   messages are buffered per connection and run together up to their Sync
 *   (or a simple Query). Interleaving them across connections is what breaks
 *   with `portal "" does not exist` in @electric-sql/pglite-socket.
 * - While a connection has a transaction open, only that connection runs, so
 *   transactions stay isolated from each other as they would on a server.
 *   Others wait their turn.
 *
 * Test-only: no TLS, no authentication, loopback only.
 */
import { createServer, type Server, type Socket } from 'net';
import type { PGlite } from '@electric-sql/pglite';

const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

type Batch = { conn: number; bytes: Uint8Array; socket: Socket };

export class PGliteServer {
  private server?: Server;
  private nextConn = 1;
  private queue: Batch[] = [];
  private running = false;
  /** The connection holding an open transaction, if any. */
  private owner: number | null = null;
  /** The owner's last statement, for the stall warning. */
  private lastSql = '';
  private stallTimer?: NodeJS.Timeout;

  constructor(private readonly db: PGlite) {}

  /** Listens on a free loopback port and returns it. */
  async start(): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('PGliteServer: no TCP address');
    }
    return address.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private accept(socket: Socket): void {
    const conn = this.nextConn++;
    let buffer = Buffer.alloc(0);
    let started = false;
    let pending: Buffer[] = [];
    socket.setNoDelay(true);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          // Startup-phase messages have no type byte: [length][code].
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const code = buffer.readInt32BE(4);
          const message = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          if (code === SSL_REQUEST || code === GSS_REQUEST) {
            socket.write('N'); // no TLS; the client continues in plain text
            continue;
          }
          if (code === CANCEL_REQUEST) {
            socket.end();
            return;
          }
          started = true;
          this.enqueue({ conn, bytes: message, socket });
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0]);
        const length = 1 + buffer.readInt32BE(1);
        if (buffer.length < length) return;
        const message = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        if (type === 'X') {
          socket.end(); // Terminate: nothing to tell the database
          return;
        }
        pending.push(message);
        // Sync ends an extended-protocol round trip, Query is one on its own.
        if (type === 'S' || type === 'Q') {
          this.enqueue({ conn, bytes: Buffer.concat(pending), socket });
          pending = [];
        }
      }
    });

    const drop = () => void this.release(conn);
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private enqueue(batch: Batch): void {
    this.queue.push(batch);
    void this.drain();
  }

  /** Runs queued round trips one at a time, honouring an open transaction. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const index =
          this.owner === null
            ? 0
            : this.queue.findIndex((b) => b.conn === this.owner);
        if (index === -1 && this.queue.length > 0) this.watchForStall();
        if (index === -1 || this.queue.length === 0) return;
        const [batch] = this.queue.splice(index, 1);
        clearTimeout(this.stallTimer);
        this.stallTimer = undefined;
        this.lastSql = sqlOf(batch.bytes);
        await this.db.runExclusive(() =>
          this.db.execProtocolRawStream(batch.bytes, {
            onRawData: (data: Uint8Array) => {
              if (batch.socket.writable) batch.socket.write(data);
            },
          }),
        );
        this.owner = this.db.isInTransaction() ? batch.conn : null;
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * A real server runs every connection at once; this one can't while a
   * transaction is open. If the transaction's owner goes quiet while others
   * wait, the code is usually running a query outside its own transaction
   * (on another pool connection) and waiting for it — a deadlock here, if
   * harmless on a server. Names both queries so the cause is findable rather
   * than a silent timeout. The fix is to run that query on the transaction's
   * manager.
   */
  private watchForStall(): void {
    if (this.stallTimer) return;
    const owner = this.owner;
    this.stallTimer = setTimeout(() => {
      if (this.owner !== owner || this.queue.length === 0) return;
      console.error(
        `[pglite-server] connection #${owner} has a transaction open and has gone quiet ` +
          'while other connections wait. Is a query running outside its transaction?\n' +
          `  transaction's last statement: ${this.lastSql}\n` +
          this.queue
            .map((b) => `  waiting #${b.conn}: ${sqlOf(b.bytes)}`)
            .join('\n'),
      );
    }, 10_000);
    this.stallTimer.unref();
  }

  /** A connection went away: drop its work and any transaction it left open. */
  private async release(conn: number): Promise<void> {
    this.queue = this.queue.filter((b) => b.conn !== conn);
    if (this.owner === conn) {
      await this.db.runExclusive(() => this.db.exec('ROLLBACK'));
      this.owner = null;
    }
    void this.drain();
  }
}

/** The readable SQL inside a batch of protocol messages, shortened. */
function sqlOf(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('latin1')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim()
    .slice(0, 200);
}
