import { randomUUID } from "crypto";
import { getOpenClawImage, getOpenClawPort, getOpenClawStartCommand } from "@/lib/provisioner/openclawBundle";

type LaunchInput = {
  deploymentId: string;
  userId: string;
  hostName: string;
};

export async function launchUserContainer(input: LaunchInput) {
  const image = getOpenClawImage();
  const port = getOpenClawPort();
  const startCommand = getOpenClawStartCommand();

  // This implementation is intentionally lightweight for v1:
  // the worker records placement metadata and returns a deterministic URL shape.
  // A real provider adapter can replace this with actual Docker API calls.
  const runtimeId = randomUUID();
  const readyUrl = `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/runtime/${input.deploymentId}`;

  return {
    runtimeId,
    image,
    port,
    startCommand,
    hostName: input.hostName,
    readyUrl,
  };
}
