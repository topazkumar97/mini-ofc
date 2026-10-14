# Step 5: CreateConsignment (Retry) → SQS → SENT_TO_STORE, with ReleaseStock compensation and a DLQ

## What changed in `C:\Users\user\Documents\mini-ofc`
- **New** `src/handlers/createConsignment.ts`: throws an error named `ConsignmentServiceError` when `Math.random() < FAIL_RATE` (default 0.3), else returns `{ consignmentId }`. The id is derived from the orderId, so a retry after a lost response gives the same consignment.
- **New** `src/handlers/releaseStock.ts`: one `TransactWriteItems` that does `available = available + qty` for each item **plus** sets `stockReleased = true` on the order with `attribute_not_exists(stockReleased)`. If only that marker fails its condition, the stock was already released, so it returns OK. A retried compensation can never add stock twice.
- **New** `src/handlers/storeConsumer.ts`: logs each message as JSON; with `CONSUMER_FAIL=true` it fails each message; returns `batchItemFailures` so only failed messages go back to the queue.
- `statemachine/order.asl.json`: ReserveStock → **CreateConsignment** (Retry + Catch) → **SendToFulfilmentQueue** (`arn:aws:states:::sqs:sendMessage`, Catch) → **MarkCompleted** (`SENT_TO_STORE` + consignmentId, the new end state, replacing MarkReserved). Catch `States.ALL` → **ReleaseStock** (with its own Retry) → **MarkFailed**. MarkFailed now writes `failureReason` from `$.error.Error`, so it says `OutOfStock` or `ConsignmentServiceError` etc.
- `template.yaml`:
  - Parameters `FailRate` (default `0.3`) and `ConsumerFail` (default `false`), wired to the env vars, so you can force failure paths with `--parameter-overrides`.
  - `FulfilmentDLQ` (14-day retention), `FulfilmentQueue` (visibility 30s, RedrivePolicy → DLQ, `maxReceiveCount: 3`), `StoreConsumerFunction` (SQS event, BatchSize 10, `ReportBatchItemFailures`), `FulfilmentDLQAlarm` (`ApproximateNumberOfMessagesVisible > 0`, Maximum over 60s, missing data = OK).
  - Least privilege: CreateConsignment has no extra policy. ReleaseStock: `dynamodb:UpdateItem` on Inventory and Orders only. **ReserveStock tightened** from `DynamoDBCrudPolicy` to `dynamodb:UpdateItem` on Inventory. State machine: invoke on its 3 Lambdas, `SQSSendMessagePolicy` on the queue, `dynamodb:UpdateItem` on Orders (was `DynamoDBWritePolicy`).
  - New outputs: `FulfilmentQueueUrl`, `FulfilmentDLQUrl`, `FulfilmentDLQAlarmName`.
- `src/lib/orders.ts`: `consignmentId` is in the public order; `stockReleased` is internal.
- `README.md`: diagram and highlights updated.

Typecheck passes, every handler bundles with esbuild, and `cfn-lint template.yaml` is clean. Not deployed yet.

## Deploy (PowerShell, in the mini-ofc folder)
```powershell
npm run typecheck
sam build
sam deploy --profile mini-ofc --parameter-overrides FailRate=0.3 ConsumerFail=false

$env:AWS_PROFILE = "mini-ofc"
$out = aws cloudformation describe-stacks --stack-name sam-app --query "Stacks[0].Outputs" | ConvertFrom-Json
function out($k) { ($out | Where-Object OutputKey -eq $k).OutputValue }
$api = out HttpApiUrl; $inv = out InventoryTableName; $dlq = out FulfilmentDLQUrl; $alarm = out FulfilmentDLQAlarmName
npx tsx scripts/seed.ts $inv      # SKU-1 = 1, SKU-2 = 10
```
Always pass both parameters on `sam deploy`, so you know which mode the stack is in.

Helper for placing an order:
```powershell
function order($sku = "SKU-2") {
  Invoke-RestMethod -Method Post "$api/orders" -Headers @{ 'Idempotency-Key' = "s5-$(Get-Random)" } `
    -ContentType 'application/json' -Body "{`"items`":[{`"sku`":`"$sku`",`"qty`":1}]}"
}
```

## Check 1: happy path (FailRate 0.3)
```powershell
$o = order; Start-Sleep 8; Invoke-RestMethod "$api/orders/$($o.orderId)"   # SENT_TO_STORE + consignmentId
sam logs -n StoreConsumerFunction --stack-name sam-app --profile mini-ofc   # "Fulfilment message received"
```
Place a few orders. In the console (Step Functions → execution → Graph/Events), some show CreateConsignment with `TaskFailed` events followed by a later success: that is Retry at work, invisible to the order. All 4 attempts failing is 0.3⁴ ≈ 1%.

## Check 2: compensation (FailRate 1)
```powershell
sam deploy --profile mini-ofc --parameter-overrides FailRate=1 ConsumerFail=false
Invoke-RestMethod "$api/products"                       # note SKU-2 available
$o = order; Start-Sleep 15; Invoke-RestMethod "$api/orders/$($o.orderId)"   # FAILED, failureReason ConsignmentServiceError
Invoke-RestMethod "$api/products"                       # SKU-2 back to the same number
```
Graph: ReserveStock ✓ → CreateConsignment caught (orange) → ReleaseStock → MarkFailed. Events tab shows 4 CreateConsignment attempts with growing, random gaps (max 1s, 2s, 4s), then the Catch. In DynamoDB the order has `stockReleased = true`.

## Check 3: DLQ and alarm (ConsumerFail true)
```powershell
sam deploy --profile mini-ofc --parameter-overrides FailRate=0 ConsumerFail=true
$o = order; Start-Sleep 8; Invoke-RestMethod "$api/orders/$($o.orderId)"   # still SENT_TO_STORE
Start-Sleep 90   # 3 receives × 30s visibility
aws sqs get-queue-attributes --queue-url $dlq --attribute-names ApproximateNumberOfMessages
aws cloudwatch describe-alarms --alarm-names $alarm --query "MetricAlarms[0].StateValue"   # ALARM (metric lags a few min)
```
Logs show the same messageId with receiveCount 1, 2, 3, then nothing. Note the order says SENT_TO_STORE while the store never processed it: the workflow's job ended at "handed to the queue". Redrive once fixed:
```powershell
sam deploy --profile mini-ofc --parameter-overrides FailRate=0.3 ConsumerFail=false
$dlqArn = aws sqs get-queue-attributes --queue-url $dlq --attribute-names QueueArn --query "Attributes.QueueArn" --output text
aws sqs start-message-move-task --source-arn $dlqArn   # moves messages back to FulfilmentQueue
```

## Retry vs Catch
- **Retry** = "try the *same* step again". For *transient* faults: throttles, a flaky carrier API. Evaluated first. `IntervalSeconds 1, BackoffRate 2, MaxAttempts 3` = up to 3 retries after 1s, 2s, 4s (4 attempts total). `JitterStrategy FULL` makes each wait a random value between 0 and that cap, so 500 failing orders don't all retry on the same second (thundering herd).
- **Catch** = "give up on this step and go *somewhere else*". For failures retries can't fix, or once retries run out. It turns an exception into a business path: release stock, mark FAILED with a reason. `ResultPath: "$.error"` keeps `orderId`/`items` so the next state can still use them.
- Order matters: Retry runs until exhausted, *then* Catch is evaluated. An error not in any Retry list (e.g. a bug) goes straight to Catch.
- Only retry what is safe to repeat. CreateConsignment is safe because its id is deterministic (real systems pass an idempotency key to the carrier). ReleaseStock is safe because of the `stockReleased` marker.
- Not retrying `OutOfStock`: retrying a business "no" just wastes time; it is caught directly.

## Known nuances (be ready to discuss)
- **MarkCompleted can fail after the message is sent** (no Retry/Catch on it): execution fails, order stays PLACED, but the store has it. Fix: add a Retry on MarkCompleted for DynamoDB transient errors, and alarm on `ExecutionsFailed`.
- **Catch on SendToFulfilmentQueue can lie**: a sendMessage that timed out may still have been delivered, then we release stock for an order the store will pick. Rare; mitigate with an idempotent consumer that checks order status, or the outbox pattern.
- **SQS standard is at-least-once**, and Step Functions may send twice on retry, so the store consumer must dedupe on orderId/consignmentId. FIFO + `MessageDeduplicationId` is the rejected alternative: ordering and dedupe, but lower throughput, and per-store ordering is not needed here.
- **ReleaseStock failing 4 times** fails the execution and leaks stock. Alarm on failed executions; a reconciliation job compares reservations with orders.
- **Visibility timeout ≥ function timeout** (AWS recommends 6×). Too short and a message is redelivered while still being processed.
- **SAM's SQS event** attaches the AWS-managed `AWSLambdaSQSQueueExecutionRole` (receive/delete on `*`). For strict least privilege, replace it with a custom statement scoped to the queue ARN.
- **The alarm has no action**. Real setup: `AlarmActions` → SNS topic → email/PagerDuty.
- **Saga, not a transaction.** Between ReserveStock and ReleaseStock the stock looks taken. That is fine (it is what "reserved" means), but say it out loud.
