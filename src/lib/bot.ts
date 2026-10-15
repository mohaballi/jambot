import { createSlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import { Chat } from "chat";

import { createDevboxClient } from "@namespacelabs/sdk/devbox";

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

  const rawPrompt = message.text;

  try {
    const client = createDevboxClient();
    const devbox = await client.devboxes.get("jambox");

    const result = await devbox.exec(["echo", message.text]);

    await thread.post(result.stdout);

  } catch (error: any) {
    console.error(error);
    await thread.post(`❌ Execution failed: ${error.message}`);
  }
});
