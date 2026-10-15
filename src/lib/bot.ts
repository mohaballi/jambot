import { createSlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import { Chat, type Thread } from "chat";

import { createDevboxClient, type Devbox } from "@namespacelabs/sdk/devbox";

import {
  APP_PORT,
  DEVBOX_NAME,
  OPENCODE_PORT,
  appSessionCommand,
  createOpencodeSession,
  ensureExposedPort,
  ensureRunning,
  ensureSession,
  opencodeSessionCommand,
  opencodeSessionStatus,
  opencodeSessionUrl,
  pendingOpencodePermission,
  promptOpencodeSession,
  workspaceDir,
} from "./jambox";

export const bot = new Chat({
  userName: process.env.BOT_USERNAME ?? "jambot",
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createPostgresState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hi, ${message.author.fullName}! What's up?`);
});

bot.onSubscribedMessage(async (thread, message) => {
  await thread.post(`🚀 Spinning up a jambox...`);

  const prompt = message.text.trim();
  const client = createDevboxClient();

  try {
    const devbox = await client.devboxes.get(DEVBOX_NAME);
    await ensureRunning(devbox);
    const workspace = workspaceDir(devbox);

    const [appReady, opencodeReady] = await Promise.all([
      ensureSession(devbox, {
        name: "app",
        command: appSessionCommand(workspace),
        port: APP_PORT,
      }),
      ensureSession(devbox, {
        name: "opencode",
        command: opencodeSessionCommand(workspace),
        port: OPENCODE_PORT,
      }),
    ]);

    const [appUrl, opencodeUrl] = await Promise.all([
      ensureExposedPort(devbox, APP_PORT, "app"),
      ensureExposedPort(devbox, OPENCODE_PORT, "opencode"),
    ]);

    const sessionId = prompt ? await createOpencodeSession(devbox, workspace, title(prompt)) : undefined;

    if (sessionId) {
      await promptOpencodeSession(devbox, workspace, sessionId, prompt);
    }

    const sessionUrl = sessionId ? opencodeSessionUrl(opencodeUrl, workspace, sessionId) : undefined;

    await thread.post(
      [
        appReady && opencodeReady
          ? `🟢 jambox is ready`
          : `⚠️ jambox sessions are still starting`,
        `App: ${appUrl}${appReady ? "" : " (starting)"}`,
        sessionUrl ? `opencode: ${sessionUrl}` : `opencode: ${opencodeUrl}${opencodeReady ? "" : " (starting)"}`,
        sessionId ? `Prompted opencode with: ${quote(prompt)}` : `No prompt to send.`,
      ].join("\n"),
    );

    if (sessionId) {
      await watchOpencode(devbox, workspace, sessionId, thread);
    }
  } catch (error: any) {
    console.error(error);
    await thread.post(`❌ Execution failed: ${error.message}`);
  } finally {
    client.close();
  }
});

function title(prompt: string): string {
  const trimmed = prompt.replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
}

function quote(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const short = trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
  return `"${short}"`;
}

/**
 * opencode runs the prompt in the background, so check back briefly for the
 * states worth surfacing in Slack: a permission prompt, a hard failure, or a
 * turn that never started (bad model or missing credentials).
 */
async function watchOpencode(devbox: Devbox, workspace: string, sessionId: string, thread: Thread) {
  for (const delayMs of [10_000, 15_000]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    try {
      const permission = await pendingOpencodePermission(devbox, workspace, sessionId);
      if (permission) {
        await thread.post(`🔐 opencode needs your approval in the web UI: ${permission}`);
        return;
      }

      const status = await opencodeSessionStatus(devbox, workspace, sessionId);
      if (status.error) {
        await thread.post(`❌ opencode failed: ${status.error}`);
        return;
      }
      if (status.replied) return;
    } catch {
      return;
    }
  }

  await thread.post(`⏳ opencode hasn't replied yet — open the session above to see what's going on.`);
}
