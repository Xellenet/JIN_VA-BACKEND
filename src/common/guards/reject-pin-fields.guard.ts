import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import {
  findPinLikeKeys,
  PIN_REFUSED_MESSAGE,
} from '../../payment-methods/payment-methods.constants';

/** `meta.error` when a body carries a PIN-like field. */
export const PIN_NOT_ACCEPTED = 'PIN_NOT_ACCEPTED';

/**
 * Defence in depth on the payment endpoints: a body with any field named
 * like a PIN (`pin`, `momoPin`, `pin_code`, at any depth) is refused with
 * 400 before validation, whatever else it carries. JinVa never takes a PIN;
 * the customer approves on their phone. The value is never read or logged.
 */
@Injectable()
export class RejectPinFieldsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ body?: unknown }>();
    if (findPinLikeKeys(req?.body).length > 0) {
      throw new BadRequestException({
        errorCode: PIN_NOT_ACCEPTED,
        message: PIN_REFUSED_MESSAGE,
      });
    }
    return true;
  }
}
