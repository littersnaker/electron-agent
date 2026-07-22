export type SseController = ReadableStreamDefaultController<Uint8Array>;

/** 将统一 JSON 事件写入 SSE 流。 */
export function sendSse(
  controller: SseController,
  encoder: TextEncoder,
  payload: Record<string, unknown>,
): void {
  controller.enqueue(
    encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
  );
}

/** 发送 SSE 注释，尽快建立长连接且不触发前端业务事件。 */
export function sendSseComment(
  controller: SseController,
  encoder: TextEncoder,
  comment: string,
): void {
  controller.enqueue(encoder.encode(`: ${comment}\n\n`));
}

/** 统一输出 Token 使用量。 */
export function sendUsage(
  controller: SseController,
  encoder: TextEncoder,
  usage: { prompt: number; completion: number; total: number },
): void {
  sendSse(controller, encoder, {
    type: "USAGE",
    content: usage,
  });
}
