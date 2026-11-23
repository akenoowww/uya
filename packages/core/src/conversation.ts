import type { ConversationMessage, RunDetail } from "@ide/protocol";

export const CONVERSATION_HISTORY_LIMIT = 12;
const HISTORY_BYTE_LIMIT = 48 * 1024;
const MESSAGE_CHAR_LIMIT = 7_500;

function boundedMessage(value: string): string {
  if (value.length <= MESSAGE_CHAR_LIMIT) return value;
  const clipped = value.slice(0, MESSAGE_CHAR_LIMIT).replace(/[\uD800-\uDBFF]$/, "");
  return `${clipped}\n[Earlier message truncated]`;
}

export function conversationMessages(previous: RunDetail[], prompt: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ role: "user", content: prompt }];
  let bytes = 0;
  for (const { run, events } of previous.toReversed()) {
    if (run.status !== "succeeded") continue;
    let answer = "";
    for (const event of events) {
      if (event.type === "status" && event.run.status === "running") answer = "";
      if (event.type === "text") answer += event.text;
    }
    if (!answer.trim()) continue;
    const userMessage = boundedMessage(run.prompt);
    const assistantMessage = boundedMessage(answer);
    bytes += Buffer.byteLength(userMessage) + Buffer.byteLength(assistantMessage);
    if (bytes > HISTORY_BYTE_LIMIT) break;
    messages.unshift({ role: "user", content: userMessage }, { role: "assistant", content: assistantMessage });
  }
  return messages;
}

export function promptForCli(prompt: string, messages?: readonly ConversationMessage[]): string {
  if (!messages || messages.length < 2) return prompt;
  return [
    "Earlier conversation turns (JSON reference). Continue the dialogue by answering the current user message below.",
    JSON.stringify(messages.slice(0, -1)),
    "Current user message:",
    prompt,
  ].join("\n\n");
}
