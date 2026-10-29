export interface MetaData {
  timestamp: string;
  path: string;
  statusCode: number;
  pagination?: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
  /**
   * Which error this is, for clients that need to branch on it. Defaults to the
   * exception's class name (`'BadRequestException'`,
   * `'SocialOnlyAccountException'`); an exception can override it with a stable
   * screaming-snake code by putting `errorCode` in its response object — see
   * `AllExceptionsFilter`.
   */
  error?: string;
  /**
   * How long a throttled caller should wait before retrying, in seconds.
   * Present only on responses that are actually retry-after-able (429s).
   */
  retryAfterSeconds?: number;
  /**
   * C1.4: primitive, machine-readable facts an error needs the client to act
   * on rather than merely display — e.g. the pending-deletion login
   * rejection's `deletedAt` / `restorableUntil`. Opt-in per exception, never
   * present on a 5xx in production. See `AllExceptionsFilter`.
   */
  details?: Record<string, string | number | boolean>;
}

export interface SuccessResponse<T> {
  status: 'success';
  message: string;
  data: T;
  meta: MetaData;
}

export interface ErrorResponse {
  status: 'error';
  message: string | string[];
  meta: MetaData;
}
