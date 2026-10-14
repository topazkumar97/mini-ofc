import type { SQSBatchResponse, SQSHandler } from 'aws-lambda';

// Simulates a store system that is down, to push messages to the DLQ.
const CONSUMER_FAIL = process.env.CONSUMER_FAIL === 'true';

export const handler: SQSHandler = async (event) => {
  const response: SQSBatchResponse = { batchItemFailures: [] };

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);
      console.log(
        JSON.stringify({
          msg: 'Fulfilment message received',
          messageId: record.messageId,
          receiveCount: record.attributes.ApproximateReceiveCount,
          ...message,
        }),
      );

      if (CONSUMER_FAIL) throw new Error(`Store rejected order ${message.orderId}`);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'Message failed', messageId: record.messageId, error: String(err) }));
      // Only this message goes back to the queue; the rest of the batch is deleted.
      response.batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return response;
};
