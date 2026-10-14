import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { OrderItem } from '../lib/orders';

// Created once per execution environment and reused across warm invocations.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.INVENTORY_TABLE!;

type ReserveStockInput = { orderId: string; items: OrderItem[] };

export const handler = async ({ orderId, items }: ReserveStockInput) => {
  try {
    // All-or-nothing: every SKU is decremented, or none is.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: items.map(({ sku, qty }) => ({
          Update: {
            TableName: TABLE,
            Key: { sku },
            UpdateExpression: 'SET available = available - :qty',
            ConditionExpression: 'available >= :qty',
            ExpressionAttributeValues: { ':qty': qty },
          },
        })),
      }),
    );
  } catch (err) {
    if (!(err instanceof TransactionCanceledException)) throw err;

    // Step Functions matches Catch on the error name, so it must be exactly "OutOfStock".
    const outOfStock = new Error(`Not enough stock for order ${orderId}`);
    outOfStock.name = 'OutOfStock';
    throw outOfStock;
  }

  return { orderId, items };
};
