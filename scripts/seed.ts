import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const items = [
  { sku: 'SKU-1', name: 'Kettle', price: 29, available: 1 },
  { sku: 'SKU-2', name: 'Toaster', price: 39, available: 10 },
];

async function main() {
  const tableName = process.argv[2];
  if (!tableName) {
    console.error('Usage: npx tsx scripts/seed.ts <InventoryTableName>');
    process.exit(1);
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  for (const item of items) {
    await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
    console.log(`Seeded ${item.sku} (available ${item.available})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
