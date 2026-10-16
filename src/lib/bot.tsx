import { createSlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import {
  Actions,
  Card,
  Chat,
  LinkButton,
  Plan,
  type Thread,
} from "chat";

import { createDevboxClient, type Devbox } from "@namespacelabs/sdk/devbox";

import {
  APP_PORT,
  DEVBOX_NAME,
  OPENCODE_PORT,
  appSessionCommand,
  checkoutMain,
  configureNamespaceAuth,
  createOpencodeSession,
  ensureExposedPort,
  ensureRunning,
  ensureSession,
  formatPermissionError,
  opencodeSessionCommand,
  opencodeSessionStatus,
  opencodeSessionUrl,
  pendingOpencodePermission,
  promptOpencodeSession,
  pullMain,
  workspaceDir,
} from "./jambox";

const BOT_USERNAME = process.env.BOT_USERNAME ?? "jambot";

const PROMPT_INSTRUCTIONS = [
  "Checkout a new branch for the following changes.",
  "Commit the changes once complete.",
].join("\n");

configureNamespaceAuth();

export const bot = new Chat({
  userName: BOT_USERNAME,
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createPostgresState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();

  const prompt = stripBotMention(message.text);
  const client = createDevboxClient();

  const plan = new Plan({ initialMessage: "Starting devbox" });
  await thread.post(plan);

  // The task a failure should be attributed to; updated as each step starts.
  let activeTaskId: string | undefined;

  try {
    const devbox = await client.devboxes.get(DEVBOX_NAME);
    await ensureRunning(devbox);
    await plan.updateTask("running");
    const workspace = workspaceDir(devbox);

    activeTaskId = (await plan.addTask({ title: "Checkout main" }))?.id;
    await checkoutMain(devbox, workspace);
    await plan.updateTask("on main");

    activeTaskId = (await plan.addTask({ title: "Pull latest changes" }))?.id;
    await pullMain(devbox, workspace);
    await plan.updateTask("up to date");

    const appTask = await plan.addTask({ title: "Start app", autoCompletePrevious: false });
    const opencodeTask = await plan.addTask({ title: "Start opencode", autoCompletePrevious: false });

    const [appResult, opencodeResult] = await Promise.all([
      runSession(devbox, appTask?.id, {
        name: "app",
        command: appSessionCommand(workspace),
        port: APP_PORT,
      }, (id) => { activeTaskId = id; }),
      runSession(devbox, opencodeTask?.id, {
        name: "opencode",
        command: opencodeSessionCommand(workspace),
        port: OPENCODE_PORT,
      }, (id) => { activeTaskId = id; }),
    ]);

    const appReady = appResult.ready;
    const opencodeReady = opencodeResult.ready;

    if (appTask) {
      await plan.updateTask({
        id: appTask.id,
        status: appReady ? "complete" : "in_progress",
        output: appReady ? "ready" : "still starting",
      });
    }
    if (opencodeTask) {
      await plan.updateTask({
        id: opencodeTask.id,
        status: opencodeReady ? "complete" : "in_progress",
        output: opencodeReady ? "ready" : "still starting",
      });
    }

    const [appUrl, opencodeUrl] = await Promise.all([
      ensureExposedPort(devbox, APP_PORT, "app"),
      ensureExposedPort(devbox, OPENCODE_PORT, "opencode"),
    ]);

    let sessionId: string | undefined;
    let sessionUrl: string | undefined;

    if (prompt) {
      activeTaskId = (await plan.addTask({ title: "Prompt opencode" }))?.id;
      sessionId = await createOpencodeSession(devbox, workspace, title(prompt));
      await promptOpencodeSession(devbox, workspace, sessionId, `${PROMPT_INSTRUCTIONS}\n\n${prompt}`);
      sessionUrl = opencodeSessionUrl(opencodeUrl, workspace, sessionId);
      await plan.updateTask(prompt);
    }

    const ready = appReady && opencodeReady;
    await plan.complete({ completeMessage: ready ? "Devbox is ready" : "Devbox is still starting" });

    await thread.post(linksCard(appUrl, sessionUrl ?? opencodeUrl));

    if (sessionId) {
      await watchOpencode(devbox, workspace, sessionId, thread);
    }
  } catch (error: any) {
    console.error(error);
    const missing = formatPermissionError(error);
    const detail = missing ? `${error.message} (missing ${missing})` : error.message;
    await plan.updateTask({ id: activeTaskId, status: "error", output: detail });
    await thread.post(`❌ Execution failed: ${detail}`);
  } finally {
    client.close();
  }
});

/**
 * Starts one devbox session. If it fails, points the outer handler's error at
 * this session's task so concurrent starts don't all land on the last task.
 */
async function runSession(
  devbox: Devbox,
  taskId: string | undefined,
  options: { name: string; command: string; port: number },
  onTaskError: (taskId: string | undefined) => void,
): Promise<{ ready: boolean }> {
  try {
    return { ready: await ensureSession(devbox, options) };
  } catch (error) {
    onTaskError(taskId);
    throw error;
  }
}

bot.onSubscribedMessage(async (thread, message) => {
  // do nothing
});

/** Card with link buttons - Slack treats these as pure hyperlinks without interactivity. */
function linksCard(appUrl: string, opencodeUrl: string) {
  return (
    <Card>
      <Actions>
        <LinkButton url={appUrl}>🚀  Launch App</LinkButton>
        <LinkButton url={opencodeUrl}>🤖 Opencode</LinkButton>
      </Actions>
    </Card>
  );
}

function title(prompt: string): string {
  const trimmed = prompt.replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
}

/**
 * The mention handler receives the message text with the bot's own @mention
 * still in it (`@jambot`, or Slack's `<@U…>` markup when the display name
 * can't be resolved). Strip it so the prompt is just what the user asked for.
 */
function stripBotMention(text: string): string {
  const escaped = BOT_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(
    `(?<!\\w)@${escaped}(?![\\w-])|<@!?[A-Z0-9]+(?:\\|${escaped})?>`,
    "gi",
  );
  return text.replace(mention, "").replace(/[^\S\n]{2,}/g, " ").trim();
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
