import { createSlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import { Chat } from "chat";

export const bot = new Chat({
  userName: process.env.BOT_USERNAME ?? "jambot",
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createPostgresState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hello, ${message.author.fullName}! I'm listening to this thread.`);
});

bot.onSubscribedMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});
