import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { json, toPublicOrder, type OrderItem, type OrderRecord } from '../lib/orders';

// Created once per execution environment and reused across warm invocations.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});
const TABLE = process.env.ORDERS_TABLE!;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function parseItems(body: string | undefined): OrderItem[] | null {
  try {
    const items = JSON.parse(body ?? '{}').items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const valid = items.every(
      (i) => typeof i?.sku === 'string' && i.sku !== '' && Number.isInteger(i.qty) && i.qty > 0,
    );
    return valid ? items.map((i) => ({ sku: i.sku, qty: i.qty })) : null;
  } catch {
    return null;
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // HTTP API lowercases header names.
  const key = event.headers['idempotency-key'];
  if (!key) return json(400, { message: 'Idempotency-Key header is required' });

  const items = parseItems(event.body);
  if (!items) return json(400, { message: 'items must be a non-empty array of {sku, qty > 0}' });

  // Same key always maps to the same orderId, so a retry targets the same item.
  const orderId = 'ord_' + sha256(key).slice(0, 16);
  // Fingerprint of the normalized request, used to detect a key reused for a different order.
  const requestHash = sha256(JSON.stringify(items));

  const order: OrderRecord = {
    orderId,
    status: 'PLACED',
    items,
    createdAt: new Date().toISOString(),
    idempotencyKey: key,
    requestHash,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: order,
        ConditionExpression: 'attribute_not_exists(orderId)',
      }),
    );

    // Only a brand-new order starts the workflow. Naming the execution after the order
    // means Step Functions itself refuses a second workflow for the same order.
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: orderId,
        input: JSON.stringify({ orderId, items }),
      }),
    );
    return json(202, toPublicOrder(order));
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;

    // Duplicate request: return the order that already exists.
    const existing = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { orderId }, ConsistentRead: true }),
    );
    const stored = existing.Item as OrderRecord;

    if (stored.requestHash !== requestHash) {
      return json(409, {
        message: 'Idempotency-Key was already used with a different request body',
      });
    }
    return json(200, toPublicOrder(stored));
  }
};
