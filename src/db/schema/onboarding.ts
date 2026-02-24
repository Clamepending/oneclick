export type OnboardingSession = {
  userId: string;
  botName: string;
  channel: string | null;
  modelProvider: string | null;
  modelApiKey: string | null;
  plan: string;
  currentStep: number;
  completed: boolean;
  updatedAt: string;
};
