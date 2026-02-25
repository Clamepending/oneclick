export type DeploymentStatus = "queued" | "starting" | "ready" | "failed" | "stopped";

export type Deployment = {
  id: string;
  userId: string;
  botName: string | null;
  status: DeploymentStatus;
  hostName: string | null;
  runtimeId: string | null;
  deployProvider: string | null;
  subsidyProxyToken: string | null;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  openrouterApiKey: string | null;
  telegramBotToken: string | null;
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
