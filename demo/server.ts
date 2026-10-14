// Local demo panel for mini-ofc. Runs on your machine with your AWS CLI credentials,
// so it can do what a browser cannot: read workflow history, flip the failure switches
// on the Lambdas, inspect the queues and invoke functions directly.
//
//   npm run demo            (stack "sam-app" in us-east-1)
//   STACK_NAME=x AWS_REGION=y npm run demo
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CloudFormationClient, paginateListStackResources, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, GetExecutionHistoryCommand, DescribeExecutionCommand, StartExecutionCommand, type HistoryEvent } from '@aws-sdk/client-sfn';
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  InvokeCommand,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { SQSClient, GetQueueAttributesCommand, StartMessageMoveTaskCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const PORT = Number(process.env.PORT ?? 4000);
const STACK = process.env.STACK_NAME ?? 'sam-app';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const cfn = new CloudFormationClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sfn = new SFNClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const cw = new CloudWatchClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });

// Same starting stock as scripts/seed.ts, so every scenario starts from known numbers.
const SEED = [
  { sku: 'SKU-1', name: 'Kettle', price: 29, available: 1 },
  { sku: 'SKU-2', name: 'Toaster', price: 39, available: 10 },
];

// Logical IDs from template.yaml. Step 5 resources are listed so the panel can say "deploy first".
const NEEDED = [
  'OrdersTable',
  'InventoryTable',
  'OrderWorkflow',
  'CreateConsignmentFunction',
  'ReleaseStockFunction',
  'StoreConsumerFunction',
  'FulfilmentQueue',
  'FulfilmentDLQ',
  'FulfilmentDLQAlarm',
] as const;

type Resources = Record<(typeof NEEDED)[number], string> & { apiUrl: string };
let resources: Resources | null = null;

async function loadResources(): Promise<{ resources: Resources | null; missing: string[] }> {
  const physical: Record<string, string> = {};
  for await (const page of paginateListStackResources({ client: cfn }, { StackName: STACK })) {
    for (const r of page.StackResourceSummaries ?? []) physical[r.LogicalResourceId!] = r.PhysicalResourceId!;
  }
  const stack = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const apiUrl = stack.Stacks?.[0].Outputs?.find((o) => o.OutputKey === 'HttpApiUrl')?.OutputValue;

  const missing: string[] = NEEDED.filter((id) => !physical[id]);
  if (!apiUrl) missing.push('HttpApiUrl output');
  resources = missing.length ? null : ({ ...physical, apiUrl } as Resources);
  return { resources, missing };
}

function need(): Resources {
  if (!resources) throw new HttpError(409, 'Stack is missing step 5 resources. Deploy first (see the banner).');
  return resources;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const executionArn = (orderId: string) =>
  need().OrderWorkflow.replace(':stateMachine:', ':execution:') + ':' + orderId;

// ---------- failure switches (Lambda environment variables) ----------

async function getEnv(fn: string) {
  const conf = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn }));
  return conf.Environment?.Variables ?? {};
}

// Changes one env var in place. Faster than `sam deploy`, but CloudFormation does not know:
// the next `sam deploy` puts back whatever the FailRate/ConsumerFail parameters say.
async function setEnv(fn: string, key: string, value: string) {
  const vars = await getEnv(fn);
  if (vars[key] === value) return;
  await lambda.send(
    new UpdateFunctionConfigurationCommand({ FunctionName: fn, Environment: { Variables: { ...vars, [key]: value } } }),
  );
  await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 60 }, { FunctionName: fn });
}

async function getSwitches() {
  const r = need();
  const [consignment, consumer] = await Promise.all([
    getEnv(r.CreateConsignmentFunction),
    getEnv(r.StoreConsumerFunction),
  ]);
  return { failRate: consignment.FAIL_RATE ?? '0.3', consumerFail: consumer.CONSUMER_FAIL ?? 'false' };
}

// ---------- workflow history → something a person can read ----------

type Attempt = { scheduledAt: string; endedAt?: string; ok?: boolean; error?: string; cause?: string };
type StateRun = {
  name: string;
  enteredAt: string;
  exitedAt?: string;
  input?: unknown;
  output?: unknown;
  attempts: Attempt[];
  outcome: 'running' | 'succeeded' | 'failed';
};

const parse = (s?: string) => {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

// A Lambda error's cause is a JSON blob; the message inside is what people want to read.
const readableCause = (cause?: string) => {
  const c = parse(cause);
  return typeof c === 'object' && c && 'errorMessage' in c ? String(c.errorMessage) : cause;
};

const FAILURE_TYPES = new Set([
  'LambdaFunctionFailed',
  'LambdaFunctionTimedOut',
  'LambdaFunctionStartFailed',
  'LambdaFunctionScheduleFailed',
  'TaskFailed',
  'TaskTimedOut',
  'TaskStartFailed',
  'TaskSubmitFailed',
]);

function errorDetails(e: HistoryEvent) {
  for (const [k, v] of Object.entries(e)) {
    if (k.endsWith('EventDetails') && v && typeof v === 'object' && 'error' in v) {
      return { error: (v as { error?: string }).error, cause: (v as { cause?: string }).cause };
    }
  }
  return {};
}

function summarise(events: HistoryEvent[]) {
  const states: StateRun[] = [];
  let current: StateRun | undefined;
  let execution: { error?: string; cause?: string } = {};

  for (const e of events) {
    const at = e.timestamp!.toISOString();
    const type = e.type!;
    if (type.endsWith('StateEntered')) {
      current = { name: e.stateEnteredEventDetails!.name!, enteredAt: at, input: parse(e.stateEnteredEventDetails!.input), attempts: [], outcome: 'running' };
      states.push(current);
    } else if (type.endsWith('StateExited') && current) {
      current.exitedAt = at;
      current.output = parse(e.stateExitedEventDetails?.output);
      current.outcome = current.attempts.at(-1)?.ok === false ? 'failed' : 'succeeded';
    } else if ((type === 'LambdaFunctionScheduled' || type === 'TaskScheduled') && current) {
      current.attempts.push({ scheduledAt: at });
    } else if ((type === 'LambdaFunctionSucceeded' || type === 'TaskSucceeded') && current) {
      Object.assign(current.attempts.at(-1) ?? {}, { endedAt: at, ok: true });
    } else if (FAILURE_TYPES.has(type) && current) {
      const { error, cause } = errorDetails(e);
      Object.assign(current.attempts.at(-1) ?? {}, { endedAt: at, ok: false, error, cause: readableCause(cause) });
      current.outcome = 'failed';
    } else if (type === 'ExecutionFailed') {
      execution = errorDetails(e);
    }
  }

  // A state's outcome is its last attempt: failures that a Retry recovered from still end "succeeded",
  // and a state left through Catch ends "failed".
  return { states, path: states.map((s) => s.name), ...execution };
}

async function getExecution(orderId: string) {
  const arn = executionArn(orderId);
  let desc;
  try {
    desc = await sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
  } catch (err) {
    if ((err as Error).name === 'ExecutionDoesNotExist') return { exists: false, arn };
    throw err;
  }
  const events: HistoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(new GetExecutionHistoryCommand({ executionArn: arn, maxResults: 1000, nextToken }));
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken);

  return { exists: true, arn, status: desc.status, startDate: desc.startDate, stopDate: desc.stopDate, ...summarise(events) };
}

// ---------- queues, alarm, consumer logs ----------

async function queueCounts(url: string) {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'QueueArn'],
    }),
  );
  const a = res.Attributes ?? {};
  return { visible: Number(a.ApproximateNumberOfMessages), inFlight: Number(a.ApproximateNumberOfMessagesNotVisible), arn: a.QueueArn! };
}

async function consumerLogs(since: number) {
  try {
    const res = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: `/aws/lambda/${need().StoreConsumerFunction}`,
        startTime: since,
        filterPattern: '?"Fulfilment message received" ?"Message failed"',
      }),
    );
    // Node's Lambda runtime prefixes each line with "timestamp requestId LEVEL"; the JSON follows.
    return (res.events ?? []).map((e) => {
      const msg = e.message ?? '';
      const brace = msg.indexOf('{');
      return { at: new Date(e.timestamp!).toISOString(), ...(brace >= 0 ? (parse(msg.slice(brace)) as object) : { raw: msg }) };
    });
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return []; // consumer has never run
    throw err;
  }
}

// ---------- console deep links, so every screen has a "see it in AWS" button ----------

function consoleLinks(r: Resources) {
  const base = `https://${REGION}.console.aws.amazon.com`;
  const enc = encodeURIComponent;
  return {
    stateMachine: `${base}/states/home?region=${REGION}#/statemachines/view/${enc(r.OrderWorkflow)}`,
    executionPrefix: `${base}/states/home?region=${REGION}#/v2/executions/details/`,
    ordersTable: `${base}/dynamodbv2/home?region=${REGION}#item-explorer?table=${enc(r.OrdersTable)}`,
    inventoryTable: `${base}/dynamodbv2/home?region=${REGION}#item-explorer?table=${enc(r.InventoryTable)}`,
    queue: `${base}/sqs/v3/home?region=${REGION}#/queues/${enc(r.FulfilmentQueue)}`,
    dlq: `${base}/sqs/v3/home?region=${REGION}#/queues/${enc(r.FulfilmentDLQ)}`,
    alarm: `${base}/cloudwatch/home?region=${REGION}#alarmsV2:alarm/${enc(r.FulfilmentDLQAlarm)}`,
    consumerLogs: `${base}/cloudwatch/home?region=${REGION}#logsV2:log-groups/log-group/${enc(enc(`/aws/lambda/${r.StoreConsumerFunction}`))}`,
  };
}

// ---------- routes ----------

type Handler = (body: any, params: Record<string, string>, query: URLSearchParams) => Promise<unknown>;
const routes: Array<[string, RegExp, Handler]> = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h]);

route('GET', '/api/config', async () => {
  const { resources: r, missing } = await loadResources();
  if (!r) return { ready: false, stack: STACK, region: REGION, missing };
  return { ready: true, stack: STACK, region: REGION, apiUrl: r.apiUrl, switches: await getSwitches(), links: consoleLinks(r) };
});

route('POST', '/api/switches', async (body: { failRate?: string; consumerFail?: string }) => {
  const r = need();
  await Promise.all([
    body.failRate !== undefined && setEnv(r.CreateConsignmentFunction, 'FAIL_RATE', String(body.failRate)),
    body.consumerFail !== undefined && setEnv(r.StoreConsumerFunction, 'CONSUMER_FAIL', String(body.consumerFail)),
  ]);
  return getSwitches();
});

route('GET', '/api/inventory', async () => {
  const res = await ddb.send(new ScanCommand({ TableName: need().InventoryTable }));
  return (res.Items ?? []).sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
});

route('POST', '/api/inventory/reset', async () => {
  for (const item of SEED) await ddb.send(new PutCommand({ TableName: need().InventoryTable, Item: item }));
  return SEED;
});

// Goes through the real HTTP API, exactly like a client would.
route('POST', '/api/orders', async (body: { key?: string | null; payload?: unknown; rawBody?: string }) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (body.key !== null) headers['idempotency-key'] = body.key ?? randomUUID();
  const res = await fetch(`${need().apiUrl}/orders`, {
    method: 'POST',
    headers,
    body: body.rawBody ?? JSON.stringify(body.payload ?? {}),
  });
  return { status: res.status, key: headers['idempotency-key'] ?? null, body: parse(await res.text()) };
});

route('GET', '/api/orders/:id', async (_b, { id }) => {
  const [api, raw] = await Promise.all([
    fetch(`${need().apiUrl}/orders/${encodeURIComponent(id)}`).then(async (r) => ({ status: r.status, body: parse(await r.text()) })),
    ddb.send(new GetCommand({ TableName: need().OrdersTable, Key: { orderId: id }, ConsistentRead: true })),
  ]);
  return { api, raw: raw.Item ?? null };
});

route('GET', '/api/executions/:orderId', async (_b, { orderId }) => getExecution(orderId));

// Proves the "execution named after the order" guard: a second workflow for the same order is refused.
route('POST', '/api/executions/:orderId/duplicate', async (_b, { orderId }) => {
  const raw = await ddb.send(new GetCommand({ TableName: need().OrdersTable, Key: { orderId } }));
  try {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: need().OrderWorkflow,
        name: orderId,
        input: JSON.stringify({ orderId, items: raw.Item?.items ?? [] }),
      }),
    );
    return { started: true };
  } catch (err) {
    return { started: false, error: (err as Error).name, message: (err as Error).message };
  }
});

// Calls ReleaseStock again by hand, the same way a Step Functions retry would.
route('POST', '/api/release-again/:orderId', async (_b, { orderId }) => {
  const raw = await ddb.send(new GetCommand({ TableName: need().OrdersTable, Key: { orderId } }));
  if (!raw.Item) throw new HttpError(404, 'Order not found');
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: need().ReleaseStockFunction,
      Payload: Buffer.from(JSON.stringify({ orderId, items: raw.Item.items })),
    }),
  );
  return { functionError: res.FunctionError ?? null, result: parse(Buffer.from(res.Payload ?? []).toString()) };
});

route('GET', '/api/queues', async () => {
  const r = need();
  const [main, dlq, alarm] = await Promise.all([
    queueCounts(r.FulfilmentQueue),
    queueCounts(r.FulfilmentDLQ),
    cw.send(new DescribeAlarmsCommand({ AlarmNames: [r.FulfilmentDLQAlarm] })),
  ]);
  const a = alarm.MetricAlarms?.[0];
  return { main, dlq, alarm: { state: a?.StateValue, reason: a?.StateReason, updatedAt: a?.StateUpdatedTimestamp } };
});

route('GET', '/api/consumer-logs', async (_b, _p, q) => consumerLogs(Number(q.get('since') ?? Date.now() - 15 * 60_000)));

// Moves every DLQ message back to the queue it came from.
route('POST', '/api/dlq/redrive', async () => {
  const { arn } = await queueCounts(need().FulfilmentDLQ);
  const res = await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: arn }));
  return { taskHandle: res.TaskHandle };
});

route('POST', '/api/dlq/purge', async () => {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: need().FulfilmentDLQ }));
  return { purged: true };
});

// ---------- plumbing ----------

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, await readFile(new URL('./index.html', import.meta.url), 'utf8'), 'text/html; charset=utf-8');
    }
    for (const [method, pattern, handler] of routes) {
      const m = req.method === method && pattern.exec(url.pathname);
      if (m) return send(res, 200, await handler(await readBody(req), { ...m.groups }, url.searchParams));
    }
    send(res, 404, { message: 'Not found' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    console.error(err);
    send(res, status, { message: (err as Error).message, name: (err as Error).name });
  }
}).listen(PORT, () => {
  console.log(`mini-ofc demo panel → http://localhost:${PORT}  (stack ${STACK}, ${REGION})`);
});
