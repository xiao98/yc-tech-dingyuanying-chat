import { memo, useCallback, useState } from 'react';
import axios from 'axios';
import * as Ariakit from '@ariakit/react';
import { CreditCard, Coins } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';

// PAYMENT_TOPUP_BUTTON — YC TECH 丁元英 Chat (P4).
//
// Sidebar entry: click opens a popover with two tabs (支付宝/Stripe),
// an amount input, and a "去支付" submit. Popover stays open until the
// user submits or clicks outside — replaces the prior Menu-based design
// where a click on a MenuItem auto-closed the popover (frustrating when
// the user still needed to enter an amount).
//
// Both channels accept an arbitrary amount on the wire — Stripe uses
// price_data (one-shot payment) so admins don't need to pre-create
// Stripe Prices in the dashboard.

type Channel = 'alipay' | 'stripe';

function TopupButton({ collapsed = true }: { collapsed?: boolean }) {
  const [submitting, setSubmitting] = useState(false);
  const [channel, setChannel] = useState<Channel>('alipay');
  const [amount, setAmount] = useState('30');
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      setError(channel === 'alipay' ? '请输入金额，如 30 或 9.99' : 'Enter amount, e.g. 9.99');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const endpoint =
        channel === 'alipay'
          ? '/api/payment/alipay/create-trade'
          : '/api/payment/stripe/create-checkout-session';
      const { data } = await axios.post(endpoint, { amount });
      if (data?.url) {
        window.location.href = data.url;
      } else {
        setError(`${channel}: missing redirect URL`);
      }
    } catch (err) {
      const message =
        (axios.isAxiosError(err) && err.response?.data?.error) ||
        (err instanceof Error ? err.message : 'request failed');
      setError(`${channel}: ${message}`);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, amount, channel]);

  const symbol = channel === 'alipay' ? '¥' : '$';
  const ccy = channel === 'alipay' ? 'CNY' : 'USD';

  return (
    <Ariakit.PopoverProvider>
      <TooltipAnchor
        side="right"
        description="充值 Top-up"
        render={
          <Ariakit.PopoverDisclosure
            aria-label="充值"
            data-testid="topup-button"
            className={
              collapsed
                ? 'flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary aria-[expanded=true]:bg-surface-active-alt'
                : 'flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary aria-[expanded=true]:bg-surface-active-alt'
            }
          >
            <CreditCard className="h-5 w-5" aria-hidden="true" />
            {!collapsed && <span>充值</span>}
          </Ariakit.PopoverDisclosure>
        }
      />
      <Ariakit.Popover
        portal
        gutter={8}
        className="popover-ui z-[125] w-72 rounded-lg p-3"
      >
        <div className="mb-2 text-xs font-medium text-text-secondary">充值方式</div>
        <div className="mb-3 flex gap-1 rounded border border-border-light p-0.5">
          <button
            type="button"
            onClick={() => {
              setChannel('alipay');
              setError(null);
            }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm transition-colors ${
              channel === 'alipay'
                ? 'bg-surface-active-alt text-text-primary'
                : 'text-text-secondary hover:bg-surface-hover'
            }`}
            data-testid="topup-alipay"
          >
            <Coins className="h-4 w-4" aria-hidden="true" /> 支付宝
          </button>
          <button
            type="button"
            onClick={() => {
              setChannel('stripe');
              setError(null);
            }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm transition-colors ${
              channel === 'stripe'
                ? 'bg-surface-active-alt text-text-primary'
                : 'text-text-secondary hover:bg-surface-hover'
            }`}
            data-testid="topup-stripe"
          >
            <CreditCard className="h-4 w-4" aria-hidden="true" /> Stripe
          </button>
        </div>
        <label className="mb-1 block text-xs text-text-secondary">金额 ({ccy})</label>
        <div className="mb-3 flex items-center rounded border border-border-light bg-surface-primary">
          <span className="px-2 text-sm text-text-secondary">{symbol}</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            className="w-full bg-transparent py-1.5 pr-2 text-sm focus:outline-none"
            placeholder="例 30"
            data-testid="topup-amount"
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          data-testid="topup-submit"
        >
          {submitting ? '处理中...' : '去支付'}
        </button>
        {error && (
          <div className="mt-2 text-xs text-red-500" role="alert">
            {error}
          </div>
        )}
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}

export default memo(TopupButton);
