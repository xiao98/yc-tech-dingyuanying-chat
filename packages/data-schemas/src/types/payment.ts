import type { Document, Types } from 'mongoose';

/**
 * Payment — one row per webhook-confirmed payment intent across the three
 * supported channels (alipay / stripe). The row is born `pending`
 * when the user starts checkout and transitions to `paid` / `failed` /
 * `refunded` exclusively from the channel webhook (P3b).
 *
 * Replay protection (Goal criterion 4.2 — physical basis):
 *   `channel_ref` is the channel-side unique transaction id (alipay
 *   `trade_no`, stripe `event.id`). Marked
 *   `unique` in the schema so a duplicate webhook delivery cannot
 *   create a second row — the second insert throws `E11000` and the
 *   handler returns 200 idempotently.
 */
export interface IPayment {
  user_id: Types.ObjectId;
  amount: number;
  currency: string;
  channel: 'alipay' | 'stripe';
  channel_ref: string;
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  paid_at?: Date;
  raw_payload?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IPaymentDocument = IPayment & Document;
