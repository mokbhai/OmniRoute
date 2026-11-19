/**
 * Text extraction for text policies.
 *
 * Callers that already have plain text (an image prompt, a tool argument, a batch
 * line) pass it straight to the engine. Callers holding a chat-shaped request body
 * use `extractPolicyText()`.
 */

/** Max characters scanned. Longer text keeps its head and tail halves. */
export const POLICY_SCAN_LIMIT = 32_000;

/** Head + tail window, so a huge constant preamble cannot hide the variable tail. */
export function clipPolicyText(text: string, limit = POLICY_SCAN_LIMIT): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

function pushText(out: string[], value: unknown, depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushText(out, item, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  // Text-bearing fields across OpenAI chat, Responses and Claude message shapes.
  // Media payloads (image_url, input_audio, base64 data) are deliberately skipped.
  if (typeof record.text === "string") out.push(record.text);
  if (record.content !== undefined) pushText(out, record.content, depth + 1);
}

/** Collect the user-controlled text of a chat / Responses / Claude / image-prompt body. */
export function extractPolicyText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const body = payload as Record<string, unknown>;
  const out: string[] = [];
  pushText(out, body.system);
  pushText(out, body.instructions);
  pushText(out, body.prompt);
  if (Array.isArray(body.messages)) pushText(out, body.messages);
  if (body.input !== undefined) pushText(out, body.input);
  return clipPolicyText(out.join("\n"));
}
