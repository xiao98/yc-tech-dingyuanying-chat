import { Schema } from 'mongoose';
import type { IPaymentDocument } from '~/types/payment';

/**
 * Payment schema — YC TECH 丁元英 Chat P3a.
 *
 * One document per checkout intent. Born `pending` when the user starts
 * payment, transitions to `paid` / `failed` / `refunded` exclusively from
 * the channel webhook handler (P3b — `api/server/routes/payment/*.js`).
 *
 * `channel_ref` is the channel-side unique transaction id and is marked
 * `unique` here, which is the **physical basis for Goal criterion 4.2
 * (replay protection)**: a duplicate webhook delivery for the same
 * channel transaction will fail with E11000 on insert, which the P3b
 * handlers turn into an idempotent 200 response. Do NOT remove the
 * unique constraint without simultaneously providing a replacement
 * idempotency mechanism, or the same payment can be credited twice.
 */
const paymentSchema: Schema<IPaymentDocument> = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      required: true,
    },
    channel: {
      type: String,
      enum: ['alipay', 'wxpay', 'stripe'],
      required: true,
      index: true,
    },
    channel_ref: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      required: true,
      default: 'pending',
    },
    paid_at: {
      type: Date,
    },
    raw_payload: {
      type: Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

paymentSchema.index({ user_id: 1, createdAt: -1 });

export default paymentSchema;
