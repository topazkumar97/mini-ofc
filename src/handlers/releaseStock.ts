import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { OrderItem } from '../lib/orders';

// Created once per execution environment and reused across warm invocations.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const INVENTORY_TABLE = process.env.INVENTORY_TABLE!;
const ORDERS_TABLE = process.env.ORDERS_TABLE!;

type ReleaseStockInput = { orderId: string; items: OrderItem[] };

// Compensation for ReserveStock: give back every item that was reserved.
export const handler = async ({ orderId, items }: ReleaseStockInput) => {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...items.map(({ sku, qty }) => ({
            Update: {
              TableName: INVENTORY_TABLE,
              Key: { sku },
              UpdateExpression: 'SET available = available + :qty',
              ExpressionAttributeValues: { ':qty': qty },
            },
          })),
          // Marker in the same transaction: a retried release cannot add the stock back twice.
          {
            Update: {
              TableName: ORDERS_TABLE,
              Key: { orderId },
              UpdateExpression: 'SET stockReleased = :true',
              ConditionExpression: 'attribute_not_exists(stockReleased)',
              ExpressionAttributeValues: { ':true': true },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof TransactionCanceledException)) throw err;

    // The marker is the last item. If only it failed its condition, the stock was already released.
    const reasons = err.CancellationReasons ?? [];
    const alreadyReleased = reasons.at(-1)?.Code === 'ConditionalCheckFailed';
    if (!alreadyReleased) throw err;
  }

  return { orderId, items };
};
