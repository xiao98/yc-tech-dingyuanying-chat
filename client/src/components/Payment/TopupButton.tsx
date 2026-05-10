import { memo, useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Wallet, CreditCard, Coins } from 'lucide-react';

// PAYMENT_TOPUP_BUTTON — YC TECH 丁元英 Chat (P4 followup).
//
// State-managed popover (no Ariakit) to keep the panel open while the
// user fills in an amount. Channels share a single amount input; both
// backends accept arbitrary `amount` (Stripe via price_data, Alipay via
// page.pay).

type Channel = 'alipay' | 'stripe';

function TopupButton({ collapsed = true }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [channel, setChannel] = useState<Channel>('alipay');
  const [amount, setAmount] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
      const msg =
        (axios.isAxiosError(err) && err.response?.data?.error) ||
        (err instanceof Error ? err.message : 'request failed');
      setError(`${channel}: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, amount, channel]);

  const symbol = channel === 'alipay' ? '¥' : '$';
  const ccy = channel === 'alipay' ? 'CNY' : 'USD';

  const buttonContent = collapsed ? (
    <div className="flex flex-col items-center justify-center leading-tight">
      <Wallet className="h-4 w-4" aria-hidden="true" />
      <span className="text-[10px] font-medium">充值</span>
    </div>
  ) : (
    <>
      <Wallet className="h-5 w-5" aria-hidden="true" />
      <span>充值</span>
    </>
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="充值"
        title="充值"
        data-testid="topup-button"
        className={
          collapsed
            ? 'flex h-12 w-full items-center justify-center rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-700 transition-colors hover:bg-blue-500/20 dark:text-blue-300'
            : 'flex h-9 w-full items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-500/20 dark:text-blue-300'
        }
      >
        {buttonContent}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="充值"
          className="absolute z-[125] w-72 rounded-lg border border-border-light bg-surface-primary p-3 shadow-lg"
          style={{
            ...(collapsed
              ? { left: 'calc(100% + 8px)', top: 0 }
              : { bottom: 'calc(100% + 8px)', left: 0 }),
          }}
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
              autoFocus
              className="w-full bg-transparent py-1.5 pr-2 text-sm focus:outline-none"
              placeholder="例 30"
            />
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? '处理中...' : '去支付'}
          </button>
          {error && (
            <div className="mt-2 text-xs text-red-500" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(TopupButton);
