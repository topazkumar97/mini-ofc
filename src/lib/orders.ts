export type OrderItem = { sku: string; qty: number };

export type OrderRecord = {
  orderId: string;
  status: string;
  items: OrderItem[];
  createdAt: string;
  idempotencyKey: string;
  requestHash: string;
  // Set by the workflow when the order cannot be fulfilled.
  failureReason?: string;
};

export const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// The shape clients see. Internal bookkeeping fields stay in the table.
export const toPublicOrder = ({
  orderId,
  status,
  items,
  createdAt,
  failureReason,
}: OrderRecord) => ({
  orderId,
  status,
  items,
  createdAt,
  failureReason,
});
