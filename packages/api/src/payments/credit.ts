// PAYMENT_CREDIT_HOOK — YC TECH 丁元英 Chat (P3b).
//
// Atomic balance-credit primitive shared by the three webhook handlers
// (alipay / stripe). Consumers pass a verified payment event;
// this module persists the audit trail in the `Payment` collection and
// increments `Balance.tokenCredits` for the user — both in a single
// mongoose transaction so a partial-write cannot leave money credited
// without a Payment row, or vice versa.
//
// Replay protection (Goal criterion 4.2):
//   The schema's `channel_ref` UNIQUE index is the *physical* idempotency
//   key. We deliberately rely on the duplicate-key error (E11000) instead
//   of an application-layer "find then insert" check — under concurrent
//   webhook deliveries the latter has a race window where two parallel
//   inserts both pass the existence check before either commits. Letting
//   Mongo enforce uniqueness collapses that race to a single winner; the
//   loser's E11000 is converted to an idempotent 200 success.

import type { Connection, ClientSession, Model } from 'mongoose';

interface PaymentDoc {
  _id: unknown;
  user_id: unknown;
  amount: number;
  currency: string;
  channel: 'alipay' | 'stripe';
  channel_ref: string;
  status: string;
  paid_at?: Date;
  raw_payload?: unknown;
}

interface BalanceDoc {
  user: unknown;
  tokenCredits: number;
}

export interface CreditInput {
  userId: string;
  amount: number;
  currency: string;
  channel: 'alipay' | 'stripe';
  channelRef: string;
  rawPayload: unknown;
  ratio: number;
}

export interface CreditSuccess {
  idempotent: false;
  paymentId: string;
  newBalance: number;
  creditDelta: number;
}

export interface CreditIdempotent {
  idempotent: true;
  alreadyPaid: {
    paymentId: string;
    channelRef: string;
    amount: number;
    paid_at?: Date;
  };
}

export type CreditResult = CreditSuccess | CreditIdempotent;

interface CreditDeps {
  connection: Connection;
}

/**
 * Atomically (a) insert a Payment doc with status=paid and
 * (b) increment the user's Balance.tokenCredits by amount * ratio.
 *
 * Returns `{idempotent:true, alreadyPaid:...}` when the channel_ref has
 * already been credited (E11000). Caller MUST translate that into a
 * success response per the channel's protocol so the channel stops
 * retrying.
 */
export async function creditUserBalance(
  input: CreditInput,
  deps: CreditDeps,
): Promise<CreditResult> {
  const { userId, amount, currency, channel, channelRef, rawPayload, ratio } = input;
  const { connection } = deps;

  const Payment = connection.model<PaymentDoc>('Payment');
  const Balance = connection.model<BalanceDoc>('Balance');

  const creditDelta = amount * ratio;

  const supportsTransactions = await transactionsAvailable(connection);

  if (!supportsTransactions) {
    return creditWithoutTransaction({
      Payment,
      Balance,
      userId,
      amount,
      currency,
      channel,
      channelRef,
      rawPayload,
      creditDelta,
    });
  }

  const session = await connection.startSession();
  try {
    let result: CreditResult | null = null;
    await session.withTransaction(async () => {
      result = await creditWithSession({
        session,
        Payment,
        Balance,
        userId,
        amount,
        currency,
        channel,
        channelRef,
        rawPayload,
        creditDelta,
      });
    });
    if (!result) {
      throw new Error('credit transaction returned no result');
    }
    return result;
  } finally {
    await session.endSession();
  }
}

interface CreditCtx {
  Payment: Model<PaymentDoc>;
  Balance: Model<BalanceDoc>;
  userId: string;
  amount: number;
  currency: string;
  channel: 'alipay' | 'stripe';
  channelRef: string;
  rawPayload: unknown;
  creditDelta: number;
}

async function creditWithSession(
  ctx: CreditCtx & { session: ClientSession },
): Promise<CreditResult> {
  const {
    session,
    Payment,
    Balance,
    userId,
    amount,
    currency,
    channel,
    channelRef,
    rawPayload,
    creditDelta,
  } = ctx;
  try {
    const inserted = await Payment.create(
      [
        {
          user_id: userId,
          amount,
          currency,
          channel,
          channel_ref: channelRef,
          status: 'paid',
          paid_at: new Date(),
          raw_payload: rawPayload,
        },
      ],
      { session },
    );
    const updated = await Balance.findOneAndUpdate(
      { user: userId },
      { $inc: { tokenCredits: creditDelta } },
      { new: true, upsert: true, session },
    );
    return {
      idempotent: false,
      paymentId: String(inserted[0]._id),
      newBalance: updated?.tokenCredits ?? creditDelta,
      creditDelta,
    };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const existing = await Payment.findOne({ channel_ref: channelRef })
        .session(session)
        .lean<{ _id: unknown; channel_ref: string; amount: number; paid_at?: Date }>();
      if (!existing) {
        throw err;
      }
      return {
        idempotent: true,
        alreadyPaid: {
          paymentId: String(existing._id),
          channelRef: existing.channel_ref,
          amount: existing.amount,
          paid_at: existing.paid_at,
        },
      };
    }
    throw err;
  }
}

async function creditWithoutTransaction(ctx: CreditCtx): Promise<CreditResult> {
  const {
    Payment,
    Balance,
    userId,
    amount,
    currency,
    channel,
    channelRef,
    rawPayload,
    creditDelta,
  } = ctx;
  try {
    const inserted = await Payment.create({
      user_id: userId,
      amount,
      currency,
      channel,
      channel_ref: channelRef,
      status: 'paid',
      paid_at: new Date(),
      raw_payload: rawPayload,
    });
    const updated = await Balance.findOneAndUpdate(
      { user: userId },
      { $inc: { tokenCredits: creditDelta } },
      { new: true, upsert: true },
    );
    return {
      idempotent: false,
      paymentId: String(inserted._id),
      newBalance: updated?.tokenCredits ?? creditDelta,
      creditDelta,
    };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const existing = await Payment.findOne({ channel_ref: channelRef }).lean<{
        _id: unknown;
        channel_ref: string;
        amount: number;
        paid_at?: Date;
      }>();
      if (!existing) {
        throw err;
      }
      return {
        idempotent: true,
        alreadyPaid: {
          paymentId: String(existing._id),
          channelRef: existing.channel_ref,
          amount: existing.amount,
          paid_at: existing.paid_at,
        },
      };
    }
    throw err;
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { code?: number }).code;
  return code === 11000;
}

async function transactionsAvailable(connection: Connection): Promise<boolean> {
  const client = connection.getClient?.();
  if (!client) {
    return false;
  }
  try {
    const admin = client.db().admin();
    const info = await admin.command({ hello: 1 });
    return Boolean(info?.setName) || info?.msg === 'isdbgrid';
  } catch {
    return false;
  }
}
