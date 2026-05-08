import { memo, useCallback, useState } from 'react';
import axios from 'axios';
import * as Menu from '@ariakit/react/menu';
import { CreditCard, Coins } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';

// PAYMENT_TOPUP_BUTTON — YC TECH 丁元英 Chat (P4).
//
// Sidebar entry-point that lets the signed-in user top up their
// balance through one of two channels: Stripe (USD subscription) or
// Alipay (CNY one-shot trade). Clicking the button opens an Ariakit
// Menu popover with both options. The two channels share the same
// "request initiation URL → window.location.href = url" flow; they
// only differ in:
//   - Stripe needs a Stripe Price id (subscription product on the
//     Stripe Dashboard). For now we read it from the global env
//     STRIPE_TOPUP_PRICE_ID exposed via window.__APP_CONFIG__ if
//     present, otherwise fall back to a baked-in TODO placeholder.
//     TODO(P4-followup): wire this through `/api/config` so admins
//     can rotate prices without a redeploy.
//   - Alipay asks the user for an amount (CNY decimal yuan) inline
//     before sending the request.

const STRIPE_PRICE_ID_FALLBACK = 'price_TODO_replace_in_dashboard';

function readStripePriceId(): string {
  const w = window as unknown as { __APP_CONFIG__?: { stripeTopupPriceId?: string } };
  return w.__APP_CONFIG__?.stripeTopupPriceId || STRIPE_PRICE_ID_FALLBACK;
}

function TopupButton({ collapsed = true }: { collapsed?: boolean }) {
  const [submitting, setSubmitting] = useState(false);
  const [showAmount, setShowAmount] = useState(false);
  const [amount, setAmount] = useState('30.00');
  const [error, setError] = useState<string | null>(null);

  const handleStripe = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const priceId = readStripePriceId();
      const { data } = await axios.post('/api/payment/stripe/create-checkout-session', {
        priceId,
      });
      if (data?.url) {
        window.location.href = data.url;
      } else {
        setError('Stripe: missing checkout URL');
      }
    } catch (err) {
      const message =
        (axios.isAxiosError(err) && err.response?.data?.error) ||
        (err instanceof Error ? err.message : 'request failed');
      setError(`Stripe: ${message}`);
    } finally {
      setSubmitting(false);
    }
  }, [submitting]);

  const handleAlipayClick = useCallback(() => {
    setShowAmount(true);
    setError(null);
  }, []);

  const handleAlipaySubmit = useCallback(async () => {
    if (submitting) return;
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      setError('请输入金额，如 30 或 9.99');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await axios.post('/api/payment/alipay/create-trade', { amount });
      if (data?.url) {
        window.location.href = data.url;
      } else {
        setError('Alipay: missing gateway URL');
      }
    } catch (err) {
      const message =
        (axios.isAxiosError(err) && err.response?.data?.error) ||
        (err instanceof Error ? err.message : 'request failed');
      setError(`Alipay: ${message}`);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, amount]);

  return (
    <Menu.MenuProvider>
      <TooltipAnchor
        side="right"
        description="充值 Top-up"
        render={
          <Menu.MenuButton
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
          </Menu.MenuButton>
        }
      />
      <Menu.Menu
        portal
        className="popover-ui z-[125] min-w-[220px] rounded-lg p-1"
        placement={collapsed ? 'right-end' : undefined}
        style={{
          transformOrigin: collapsed ? 'left bottom' : 'bottom',
          translate: collapsed ? '4px 0' : '0 -4px',
        }}
      >
        <div className="px-3 py-2 text-xs text-text-secondary">充值方式</div>
        <Menu.MenuItem
          onClick={handleStripe}
          disabled={submitting}
          className="select-item flex items-center gap-2 px-3 py-2 text-sm"
          data-testid="topup-stripe"
        >
          <CreditCard className="icon-md" aria-hidden="true" />
          Stripe (USD)
        </Menu.MenuItem>
        <Menu.MenuItem
          onClick={handleAlipayClick}
          disabled={submitting}
          className="select-item flex items-center gap-2 px-3 py-2 text-sm"
          data-testid="topup-alipay"
        >
          <Coins className="icon-md" aria-hidden="true" />
          支付宝 (CNY)
        </Menu.MenuItem>
        {showAmount && (
          <div className="border-t border-border-light p-2">
            <label className="block px-1 pb-1 text-xs text-text-secondary">充值金额 (CNY)</label>
            <div className="flex items-center gap-1">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAlipaySubmit();
                  }
                }}
                className="w-full rounded border border-border-light bg-surface-primary px-2 py-1 text-sm"
                placeholder="例 30.00"
                data-testid="topup-alipay-amount"
              />
              <button
                type="button"
                onClick={handleAlipaySubmit}
                disabled={submitting}
                className="rounded bg-surface-active-alt px-2 py-1 text-xs text-text-primary hover:bg-surface-hover disabled:opacity-50"
                data-testid="topup-alipay-submit"
              >
                去支付
              </button>
            </div>
          </div>
        )}
        {error && (
          <div className="border-t border-border-light px-3 py-2 text-xs text-red-500" role="alert">
            {error}
          </div>
        )}
      </Menu.Menu>
    </Menu.MenuProvider>
  );
}

export default memo(TopupButton);
