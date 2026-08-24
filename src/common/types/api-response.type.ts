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
