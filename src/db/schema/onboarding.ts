export type OnboardingSession = {
  userId: string;
  botName: string;
  channel: string | null;
  plan: string;
  currentStep: number;
  completed: boolean;
  updatedAt: string;
};
