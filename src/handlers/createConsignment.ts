import type { OrderItem } from '../lib/orders';

// Simulated carrier/consignment service. FAIL_RATE lets us force the retry and catch paths.
const FAIL_RATE = Number(process.env.FAIL_RATE ?? '0.3');

type CreateConsignmentInput = { orderId: string; items: OrderItem[] };

// Step Functions matches Retry/Catch on the error name, so it must be exactly "ConsignmentServiceError".
class ConsignmentServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsignmentServiceError';
  }
}

export const handler = async ({ orderId }: CreateConsignmentInput) => {
  if (Math.random() < FAIL_RATE) {
    throw new ConsignmentServiceError(`Consignment service unavailable for order ${orderId}`);
  }

  // Derived from the orderId, so a retry after a lost response yields the same consignment.
  return { consignmentId: 'con_' + orderId.replace(/^ord_/, '') };
};
