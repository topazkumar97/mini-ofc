import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

type Product = {
  sku: string;
  name: string;
  price: number;
  available: number;
};

// Created once per execution environment and reused across warm invocations.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.INVENTORY_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async () => {
  const result = await ddb.send(new ScanCommand({ TableName: TABLE }));

  const products: Product[] = (result.Items ?? []).map((item) => ({
    sku: item.sku,
    name: item.name,
    price: item.price,
    available: item.available,
  }));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(products),
  };
};
