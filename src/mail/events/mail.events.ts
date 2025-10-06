export const MailEvent = {
  USER_REGISTERED: 'user.registered',
  ORDER_PLACED: 'order.placed',
  PASSWORD_RESET: 'user.password-reset',
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

export type MailEventPayloads = {
  [MailEvent.USER_REGISTERED]: UserRegisteredPayload;
  [MailEvent.ORDER_PLACED]: OrderPlacedPayload;
};
