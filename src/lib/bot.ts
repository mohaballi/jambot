import { createSlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import { Chat, type Thread } from "chat";

import { createDevboxClient, type DevboxExecution } from "@namespacelabs/sdk/devbox";

import {
  APP_PORT,
  DEVBOX_NAME,
  OPENCODE_PORT,
  appSessionCommand,
  ensureExposedPort,
  ensureRunning,
  ensureSession,
  opencodeSessionCommand,
  promptOpencode,
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

  const prompt = message.text;
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

    const run = prompt.trim() ? await promptOpencode(devbox, workspace, prompt) : undefined;

    await thread.post(
      [
        appReady && opencodeReady
          ? `🟢 jambox is ready`
          : `⚠️ jambox sessions are still starting`,
        `App: ${appUrl}${appReady ? "" : " (starting)"}`,
        `opencode: ${opencodeUrl}${opencodeReady ? "" : " (starting)"}`,
        run ? `Prompted opencode with: ${quote(prompt)}` : `No prompt to send.`,
      ].join("\n"),
    );

    if (run) {
      await reportPromptFailure(thread, run);
    }
  } catch (error: any) {
    console.error(error);
    await thread.post(`❌ Execution failed: ${error.message}`);
  } finally {
    client.close();
  }
});

function quote(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const short = trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
  return `"${short}"`;
}

async function reportPromptFailure(thread: Thread, run: DevboxExecution) {
  try {
    const result = await run.wait({ timeoutMs: 15_000 });
    if (result.exitCode === 0) return;
    const tail = (result.stderr || result.stdout).trim().split("\n").slice(-10).join("\n");
    const detail = [result.error, tail].filter(Boolean).join("\n");
    await thread.post(`❌ opencode prompt failed:\n${detail || `exit code ${result.exitCode}`}`);
  } catch {
    return;
  }
}
