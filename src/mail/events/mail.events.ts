export const MailEvent = {
  USER_REGISTERED: 'user.registered',
  ORDER_PLACED: 'order.placed',
  PASSWORD_RESET: 'user.password-reset',
  WELCOME_USER: 'user.welcome',
  FORGOT_PASSWORD: 'user.forgot-password',
  PASSWORD_RESET_SUCCESS: 'user.password-reset-success',
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

export type MailEventPayloads = {
  [MailEvent.USER_REGISTERED]: UserRegisteredPayload;
  [MailEvent.ORDER_PLACED]: OrderPlacedPayload;
  [MailEvent.WELCOME_USER]: WelcomeUserPayload;
  [MailEvent.PASSWORD_RESET]: PasswordResetPayload;
  [MailEvent.PASSWORD_RESET_SUCCESS]: PasswordResetSuccessPayload;
};
