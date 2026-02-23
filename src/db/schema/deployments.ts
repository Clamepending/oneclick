export type DeploymentStatus = "queued" | "starting" | "ready" | "failed";

export type Deployment = {
  id: string;
  userId: string;
  status: DeploymentStatus;
  hostName: string | null;
  readyUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentEvent = {
  id: number;
  deploymentId: string;
  status: DeploymentStatus;
  message: string;
  createdAt: string;
};
