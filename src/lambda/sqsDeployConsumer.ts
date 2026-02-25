import { markDeploymentFailed, processDeploymentJob, type DeploymentJob } from "@/workers/deployWorker";

type LambdaSqsRecord = {
  messageId: string;
  body: string;
};

type LambdaSqsEvent = {
  Records: LambdaSqsRecord[];
};

type LambdaSqsBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

function isDeploymentJob(value: unknown): value is DeploymentJob {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.deploymentId === "string" && typeof obj.userId === "string";
}

export async function handler(event: LambdaSqsEvent): Promise<LambdaSqsBatchResponse> {
  const batchItemFailures: LambdaSqsBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      const parsed = JSON.parse(record.body) as unknown;
      if (!isDeploymentJob(parsed)) {
        throw new Error("Invalid deployment job payload");
      }
      await processDeploymentJob(parsed);
    } catch (error) {
      const maybeJob = (() => {
        try {
          const parsed = JSON.parse(record.body) as unknown;
          return isDeploymentJob(parsed) ? parsed : null;
        } catch {
          return null;
        }
      })();
      if (maybeJob) {
        await markDeploymentFailed(maybeJob.deploymentId, error);
      }
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
