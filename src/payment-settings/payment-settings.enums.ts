/** The checkout methods a customer can put first (B5). */
export const PREFERRED_CHANNELS = ['mobile_money', 'card'] as const;
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number];

/** The mobile money networks a customer can pick (B5). No number is stored. */
export const MOMO_NETWORKS = ['MTN', 'TELECEL', 'AT'] as const;
export type MomoNetwork = (typeof MOMO_NETWORKS)[number];
