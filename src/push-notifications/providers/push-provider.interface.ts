export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushSendResult {
  successCount: number;
  failedTokens: string[];
}

export interface IPushProvider {
  readonly providerName: string;
  send(tokens: string[], payload: PushPayload): Promise<PushSendResult>;
}
