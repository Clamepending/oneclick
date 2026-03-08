import { ensureRuntimeSessionById } from "@/app/api/runtime/[id]/shared";
import { runRuntimeTurn, RuntimeRouterError } from "@/lib/runtime/runtimeRouter";
import type { RuntimeMetadata } from "@/lib/runtime/runtimeMetadata";
import type { ServerlessRuntimeModelConfig } from "@/lib/runtime/serverlessChatEngine";
import {
  sendTelegramTextMessage,
  sendTelegramTypingAction,
} from "@/lib/telegram/serverlessWebhook";

export type ServerlessTelegramTurnResult = {
  processed: boolean;
  sessionId: string;
  error: string | null;
  userMessageId: number | null;
  assistantMessageId: number | null;
};

export async function executeServerlessTelegramTurn(input: {
  deploymentId: string;
  botToken: string;
  chatId: number;
  messageId: number | null;
  userText: string;
  runtimeMetadata: RuntimeMetadata;
  modelConfig: ServerlessRuntimeModelConfig;
  requestOrigin: string;
  sendTyping?: boolean;
}) {
  const sessionId = `telegram:${input.chatId}`;
  await ensureRuntimeSessionById({
    deploymentId: input.deploymentId,
    sessionId,
    name: `Telegram ${input.chatId}`,
  });

  if (input.sendTyping !== false) {
    await sendTelegramTypingAction({
      botToken: input.botToken,
      chatId: input.chatId,
    }).catch(() => null);
  }

  try {
    const result = await runRuntimeTurn({
      deploymentId: input.deploymentId,
      sessionId,
      userMessage: input.userText,
      requestOrigin: input.requestOrigin,
      runtimeMetadata: input.runtimeMetadata,
      modelConfig: input.modelConfig,
    });

    await sendTelegramTextMessage({
      botToken: input.botToken,
      chatId: input.chatId,
      text: result.assistantMessage.content,
      replyToMessageId: input.messageId,
    });

    return {
      processed: true,
      sessionId,
      error: null,
      userMessageId: result.userMessage.id,
      assistantMessageId: result.assistantMessage.id,
    } satisfies ServerlessTelegramTurnResult;
  } catch (error) {
    const reason =
      error instanceof RuntimeRouterError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "runtime_failed";

    try {
      await sendTelegramTextMessage({
        botToken: input.botToken,
        chatId: input.chatId,
        text: `OneClick runtime error: ${reason}`,
        replyToMessageId: input.messageId,
      });
    } catch {
      // Ignore secondary Telegram send failures. The caller receives a failure result.
    }

    return {
      processed: false,
      sessionId,
      error: reason,
      userMessageId: null,
      assistantMessageId: null,
    } satisfies ServerlessTelegramTurnResult;
  }
}

