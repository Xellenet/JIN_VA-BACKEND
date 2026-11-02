/**
 * Customer experience v2: the query DTO for routes that take **no** query
 * parameters (B7a, B6, B3f). With the global `ValidationPipe`'s
 * `forbidNonWhitelisted`, any parameter at all, including an owner id such as
 * `customerId` or `userId` (SEC-1), is rejected with 400 instead of being
 * silently ignored.
 */
export class EmptyQueryDto {}
