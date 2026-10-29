export const MailEvent = {
  USER_REGISTERED: 'user.registered',
  ORDER_PLACED: 'order.placed',
  PASSWORD_RESET: 'user.password-reset',
  WELCOME_USER: 'user.welcome',
  FORGOT_PASSWORD: 'user.forgot-password',
  PASSWORD_RESET_SUCCESS: 'user.password-reset-success',
  PASSWORD_CHANGED: 'user.password-changed',
  SOCIAL_USER_REGISTERED: 'user.social-registered',
  /**
   * C1.5: sent unconditionally on every successful account deletion. This is
   * the security notice for someone whose account was deleted by another
   * party, so it is never suppressed by a notification preference and never
   * carries a restore token — it links to `/login`, where restoring requires
   * the account's own credentials.
   */
  ACCOUNT_DELETED: 'user.account-deleted',
  /** C1.4: sent when a soft-deleted account is restored inside its window. */
  ACCOUNT_RESTORED: 'user.account-restored',
} as const;

export interface UserRegisteredPayload {
  email: string;
  firstname: string;
  verificationToken: string;
}

export interface OrderPlacedPayload {
  email: string;
  orderId: string;
  total: number;
}

export interface WelcomeUserPayload {
  email: string;
  firstname: string;
}

export interface PasswordResetPayload {
  email: string;
  firstname: string;
  resetToken: string;
}

export interface PasswordResetSuccessPayload {
  email: string;
  firstname: string;
}

export interface PasswordChangedPayload {
  email: string;
  firstname: string;
}

export interface SocialUserRegisteredPayload {
  email: string;
  firstname: string;
  provider: string;
}

export interface AccountDeletedPayload {
  email: string;
  firstname: string;
  /** When the account was soft-deleted. */
  deletedAt: Date;
  /**
   * C1.5: the exact instant the account is permanently purged
   * (`deletedAt` + `SOFT_DELETE_RETENTION_DAYS`). The listener formats this as
   * a calendar date — the email must state a real date, not "30 days".
   */
  purgeAt: Date;
}

export interface AccountRestoredPayload {
  email: string;
  firstname: string;
}

export type MailEventPayloads = {
  [MailEvent.USER_REGISTERED]: UserRegisteredPayload;
  [MailEvent.ORDER_PLACED]: OrderPlacedPayload;
  [MailEvent.WELCOME_USER]: WelcomeUserPayload;
  [MailEvent.PASSWORD_RESET]: PasswordResetPayload;
  [MailEvent.PASSWORD_RESET_SUCCESS]: PasswordResetSuccessPayload;
  [MailEvent.PASSWORD_CHANGED]: PasswordChangedPayload;
  [MailEvent.SOCIAL_USER_REGISTERED]: SocialUserRegisteredPayload;
  [MailEvent.ACCOUNT_DELETED]: AccountDeletedPayload;
  [MailEvent.ACCOUNT_RESTORED]: AccountRestoredPayload;
};
