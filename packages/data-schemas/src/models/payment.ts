import paymentSchema from '~/schema/payment';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import type { IPaymentDocument } from '~/types/payment';

export function createPaymentModel(mongoose: typeof import('mongoose')) {
  applyTenantIsolation(paymentSchema);
  return (
    mongoose.models.Payment || mongoose.model<IPaymentDocument>('Payment', paymentSchema)
  );
}
