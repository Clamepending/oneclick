import { markDeploymentFailed, processDeploymentJob } from "../src/workers/deployWorker";

type SqsRecord = { body: string };
type SqsEvent = { Records?: SqsRecord[] };
type DeploymentJob = { deploymentId: string; userId: string };

function parseRecordBody(body: string): DeploymentJob {
  const parsed = JSON.parse(body) as Partial<DeploymentJob> | null;
  if (!parsed || typeof parsed.deploymentId !== "string" || typeof parsed.userId !== "string") {
    throw new Error("Invalid deployment SQS message payload");
  }
  return { deploymentId: parsed.deploymentId, userId: parsed.userId };
}

export async function handler(event: SqsEvent) {
  for (const record of event.Records ?? []) {
    let job: DeploymentJob | null = null;
    try {
      job = parseRecordBody(record.body);
      await processDeploymentJob(job);
    } catch (error) {
      if (job?.deploymentId) {
        await markDeploymentFailed(job.deploymentId, error);
      }
      throw error;
    }
  }
  return { ok: true };
}
