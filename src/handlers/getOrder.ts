import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { json, toPublicOrder, type OrderRecord } from '../lib/orders';

// Created once per execution environment and reused across warm invocations.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.ORDERS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const orderId = event.pathParameters?.id;
  if (!orderId) return json(400, { message: 'Order id is required' });

  // Strongly consistent so an order is readable immediately after it is created.
  const result = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { orderId }, ConsistentRead: true }),
  );

  if (!result.Item) return json(404, { message: 'Order not found' });

  return json(200, toPublicOrder(result.Item as OrderRecord));
};
