"use client";

import { useCallback, useMemo, useRef } from "react";
import type { CheckpointFinishResult } from "../../types/checkpoints";
import type { SubmitPromptOptions } from "./chat-stream-helpers";

/** 在交互暂停期间保留同一 Checkpoint 的完成回调。 */
export function useChatCheckpointBinding() {
  const checkpointIdRef = useRef("");
  const finishRef = useRef<SubmitPromptOptions["onCheckpointFinish"]>(undefined);
  const capture = useCallback((options: SubmitPromptOptions) => {
    if (options.checkpointId) checkpointIdRef.current = options.checkpointId;
    if (options.onCheckpointFinish) finishRef.current = options.onCheckpointFinish;
  }, []);
  const clear = useCallback(() => {
    checkpointIdRef.current = "";
    finishRef.current = undefined;
  }, []);
  const finalize = useCallback(
    async (
      options: SubmitPromptOptions,
      current: CheckpointFinishResult,
      answer: string,
      paused: boolean,
    ) => {
      const result = paused
        ? ({ status: "paused" } as const)
        : current.status === "completed" && answer.startsWith("⚠️")
          ? ({ status: "failed", error: answer.slice(2).trim() } as const)
          : current;
      await options.onCheckpointFinish?.(result);
      if (result.status !== "paused") clear();
    },
    [clear],
  );
  const replyOptions = useCallback(
    (): SubmitPromptOptions => ({
      suppressVisibleUserMessage: true,
      checkpointId: checkpointIdRef.current,
      onCheckpointFinish: finishRef.current,
    }),
    [],
  );
  return useMemo(
    () => ({ capture, finalize, replyOptions }),
    [capture, finalize, replyOptions],
  );
}
