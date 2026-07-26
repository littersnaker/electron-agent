/**
 * 模块职责：并行修改的三方合并、冲突检测与结果聚合。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import fs from "fs";
import path from "path";
import { DEFAULT_MERGE_RESULT, InteractiveRequest, MergeConflict, MergeResult, ModifyTaskResult, WorkerFileChange } from "../types";
import { getSafePath, hashContent, normalizeFileKey, readRawFile } from "./workspace-file-tools";
import { AgentRuntimeState } from "./runtime-lifecycle";
export function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

export type ContiguousLineEdit = {
  start: number;
  end: number;
  replacement: string[];
};

export function computeContiguousLineEdit(
  baseContent: string,
  proposedContent: string,
): ContiguousLineEdit | null {
  if (baseContent === proposedContent) return null;
  const baseLines = baseContent.split("\n");
  const proposedLines = proposedContent.split("\n");

  let prefix = 0;
  while (
    prefix < baseLines.length &&
    prefix < proposedLines.length &&
    baseLines[prefix] === proposedLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < baseLines.length - prefix &&
    suffix < proposedLines.length - prefix &&
    baseLines[baseLines.length - 1 - suffix] ===
      proposedLines[proposedLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    start: prefix,
    end: baseLines.length - suffix,
    replacement: proposedLines.slice(prefix, proposedLines.length - suffix),
  };
}

export function lineEditsOverlap(
  left: ContiguousLineEdit,
  right: ContiguousLineEdit,
): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;

  // 对插入点采用保守判断：只要落在另一修改区间的边界或内部，就拒绝自动合并。
  if (leftInsertion) {
    return left.start >= right.start && left.start <= right.end;
  }
  if (rightInsertion) {
    return right.start >= left.start && right.start <= left.end;
  }
  return !(left.end <= right.start || right.end <= left.start);
}

export function tryThreeWayMergeChanges(
  changes: WorkerFileChange[],
): { merged: WorkerFileChange | null; conflict: MergeConflict | null } {
  const filePath = changes[0]?.filePath;
  const workerIds = Array.from(
    new Set(changes.flatMap((change) => change.sourceWorkerIds)),
  );
  const slots = uniqueNumbers(
    changes.flatMap((change) => change.sourceSlots),
  );

  if (!filePath || !changes.length) {
    return {
      merged: null,
      conflict: {
        type: "invalid_patch",
        filePath,
        workerIds,
        slots,
        message: "Merge 收到空文件提案组。",
      },
    };
  }

  const baseHashes = new Set(changes.map((change) => change.baseContentHash));
  const baseContents = new Set(
    changes.map((change) => change.baseContent ?? "<FILE_NOT_EXISTS>"),
  );
  if (baseHashes.size !== 1 || baseContents.size !== 1) {
    return {
      merged: null,
      conflict: {
        type: "base_mismatch",
        filePath,
        workerIds,
        slots,
        message: `多个 Worker 对 ${filePath} 使用了不同基线，无法三方合并。`,
      },
    };
  }

  const baseContent = changes[0].baseContent;
  if (baseContent === null) {
    return {
      merged: null,
      conflict: {
        type: "same_file",
        filePath,
        workerIds,
        slots,
        message: `多个 Worker 同时创建新文件且内容不同: ${filePath}`,
      },
    };
  }

  const edits = changes
    .map((change) => ({
      change,
      edit: computeContiguousLineEdit(baseContent, change.proposedContent),
    }))
    .filter(
      (item): item is { change: WorkerFileChange; edit: ContiguousLineEdit } =>
        item.edit !== null,
    );

  for (let leftIndex = 0; leftIndex < edits.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < edits.length;
      rightIndex += 1
    ) {
      if (lineEditsOverlap(edits[leftIndex].edit, edits[rightIndex].edit)) {
        return {
          merged: null,
          conflict: {
            type: "overlapping_patch",
            filePath,
            workerIds,
            slots,
            message: `多个 Worker 对 ${filePath} 的修改区间重叠，拒绝自动合并。`,
          },
        };
      }
    }
  }

  const mergedLines = baseContent.split("\n");
  [...edits]
    .sort((left, right) => right.edit.start - left.edit.start)
    .forEach(({ edit }) => {
      mergedLines.splice(
        edit.start,
        edit.end - edit.start,
        ...edit.replacement,
      );
    });
  const proposedContent = mergedLines.join("\n");

  return {
    merged: {
      workerId: "merge_agent",
      slot: Math.min(...slots),
      filePath,
      baseExists: changes[0].baseExists,
      baseContent,
      baseContentHash: changes[0].baseContentHash,
      proposedContentHash: hashContent(proposedContent),
      proposedContent,
      ready: true,
      sourceWorkerIds: workerIds,
      sourceSlots: slots,
      mergeStrategy: "three_way_disjoint",
    },
    conflict: null,
  };
}

export function resolveSameFileGroups(
  results: ModifyTaskResult[],
): {
  selectedChanges: WorkerFileChange[];
  conflicts: MergeConflict[];
  autoMergedFiles: string[];
  deduplicatedFiles: string[];
} {
  const groups = new Map<string, WorkerFileChange[]>();
  results
    .flatMap((result) => result.fileChanges.filter((change) => change.ready))
    .forEach((change) => {
      const key = normalizeFileKey(change.filePath);
      groups.set(key, [...(groups.get(key) || []), change]);
    });

  const selectedChanges: WorkerFileChange[] = [];
  const conflicts: MergeConflict[] = [];
  const autoMergedFiles: string[] = [];
  const deduplicatedFiles: string[] = [];

  groups.forEach((changes) => {
    if (changes.length === 1) {
      selectedChanges.push(changes[0]);
      return;
    }

    const uniqueByProposedHash = Array.from(
      new Map(
        changes.map((change) => [change.proposedContentHash, change]),
      ).values(),
    );
    if (uniqueByProposedHash.length === 1) {
      const selected = uniqueByProposedHash[0];
      selectedChanges.push({
        ...selected,
        sourceWorkerIds: Array.from(
          new Set(changes.flatMap((change) => change.sourceWorkerIds)),
        ),
        sourceSlots: uniqueNumbers(
          changes.flatMap((change) => change.sourceSlots),
        ),
        mergeStrategy: "identical_deduplicated",
      });
      deduplicatedFiles.push(selected.filePath);
      return;
    }

    const resolved = tryThreeWayMergeChanges(uniqueByProposedHash);
    if (resolved.merged) {
      selectedChanges.push(resolved.merged);
      autoMergedFiles.push(resolved.merged.filePath);
      return;
    }
    if (resolved.conflict) conflicts.push(resolved.conflict);
  });

  return {
    selectedChanges,
    conflicts,
    autoMergedFiles,
    deduplicatedFiles,
  };
}

export async function detectWorkspaceConflicts(
  changes: WorkerFileChange[],
  workingDir: string,
): Promise<{
  changesToApply: WorkerFileChange[];
  alreadyAppliedFiles: string[];
  conflicts: MergeConflict[];
}> {
  const changesToApply: WorkerFileChange[] = [];
  const alreadyAppliedFiles: string[] = [];
  const conflicts: MergeConflict[] = [];

  for (const change of changes) {
    const current = await readRawFile(change.filePath, workingDir);
    const currentHash = hashContent(current.content);

    if (currentHash === change.proposedContentHash) {
      alreadyAppliedFiles.push(change.filePath);
      continue;
    }

    if (currentHash !== change.baseContentHash) {
      conflicts.push({
        type: "workspace_changed",
        filePath: change.filePath,
        workerIds: change.sourceWorkerIds,
        slots: change.sourceSlots,
        message: `Worker 执行期间正式文件发生变化，拒绝覆盖: ${change.filePath}`,
      });
      continue;
    }

    changesToApply.push(change);
  }

  return { changesToApply, alreadyAppliedFiles, conflicts };
}

export async function applyMergedChanges(
  changes: WorkerFileChange[],
  workingDir: string,
): Promise<{ appliedFiles: string[]; error: Error | null }> {
  const backups = new Map<
    string,
    { safePath: string; existed: boolean; content: string | null }
  >();
  const appliedFiles: string[] = [];

  try {
    for (const change of changes) {
      const safePath = await getSafePath(change.filePath, workingDir);
      const existed = fs.existsSync(safePath);
      backups.set(change.filePath, {
        safePath,
        existed,
        content: existed ? fs.readFileSync(safePath, "utf-8") : null,
      });

      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      fs.writeFileSync(safePath, change.proposedContent, "utf-8");
      appliedFiles.push(change.filePath);
    }
    return { appliedFiles, error: null };
  } catch (error) {
    // 尽可能回滚本次 Merge 已写入的文件，避免半合并状态。
    for (const [filePath, backup] of Array.from(backups.entries()).reverse()) {
      try {
        if (backup.existed) {
          fs.writeFileSync(backup.safePath, backup.content || "", "utf-8");
        } else if (fs.existsSync(backup.safePath)) {
          fs.unlinkSync(backup.safePath);
        }
      } catch {
        // 回滚错误会在最终 apply_failed 冲突中体现。
      }
      if (!appliedFiles.includes(filePath)) continue;
    }
    return {
      appliedFiles: [],
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export async function mergeParallelWorkerResults(
  state: AgentRuntimeState,
): Promise<{ mergeResult: MergeResult; interactiveRequest: InteractiveRequest | null }> {
  const results = [...(state.modifyResults || [])].sort(
    (left, right) => left.slot - right.slot,
  );
  const blockedResult = results.find((result) => result.status === "blocked");
  if (blockedResult) {
    const mergeResult: MergeResult = {
      ...DEFAULT_MERGE_RESULT,
      status: "blocked",
      summary: `并发 Worker 尚未全部完成，${blockedResult.workerId} 正在等待交互。`,
    };
    return {
      mergeResult,
      interactiveRequest: blockedResult.interactiveRequest || null,
    };
  }

  const failedResults = results.filter((result) => result.status === "failed");
  const workerFailures: MergeConflict[] = failedResults.map((result) => ({
    type: "worker_failed",
    workerIds: [result.workerId],
    slots: [result.slot],
    message: `${result.workerId} 未能产生可安全合并的完整结果: ${result.summary}`,
  }));

  const sameFileCheck = resolveSameFileGroups(results);
  const workspaceCheck = await detectWorkspaceConflicts(
    sameFileCheck.selectedChanges,
    state.workingDir || process.cwd(),
  );
  const conflicts = [
    ...workerFailures,
    ...sameFileCheck.conflicts,
    ...workspaceCheck.conflicts,
  ];

  if (conflicts.length) {
    return {
      mergeResult: {
        status: "conflict",
        appliedFiles: [],
        alreadyAppliedFiles: workspaceCheck.alreadyAppliedFiles,
        autoMergedFiles: sameFileCheck.autoMergedFiles,
        deduplicatedFiles: sameFileCheck.deduplicatedFiles,
        skippedFiles: sameFileCheck.selectedChanges.map((item) => item.filePath),
        conflicts,
        summary: `检测到 ${conflicts.length} 个冲突/失败项，本轮未写入新的正式文件。`,
      },
      interactiveRequest: null,
    };
  }

  const applyResult = await applyMergedChanges(
    workspaceCheck.changesToApply,
    state.workingDir || process.cwd(),
  );
  if (applyResult.error) {
    const slots = uniqueNumbers(
      workspaceCheck.changesToApply.flatMap(
        (change) => change.sourceSlots,
      ),
    );
    return {
      mergeResult: {
        status: "failed",
        appliedFiles: [],
        alreadyAppliedFiles: workspaceCheck.alreadyAppliedFiles,
        autoMergedFiles: sameFileCheck.autoMergedFiles,
        deduplicatedFiles: sameFileCheck.deduplicatedFiles,
        skippedFiles: workspaceCheck.changesToApply.map((item) => item.filePath),
        conflicts: [
          {
            type: "apply_failed",
            workerIds: Array.from(
              new Set(
                workspaceCheck.changesToApply.flatMap(
                  (change) => change.sourceWorkerIds,
                ),
              ),
            ),
            slots,
            message: `Merge 写入失败并已尝试回滚: ${applyResult.error.message}`,
          },
        ],
        summary: "Merge 写入正式工作区失败。",
      },
      interactiveRequest: null,
    };
  }

  return {
    mergeResult: {
      status: "success",
      appliedFiles: applyResult.appliedFiles,
      alreadyAppliedFiles: workspaceCheck.alreadyAppliedFiles,
      autoMergedFiles: sameFileCheck.autoMergedFiles,
      deduplicatedFiles: sameFileCheck.deduplicatedFiles,
      skippedFiles: [],
      conflicts: [],
      summary: `并发 Merge 完成：新写入 ${applyResult.appliedFiles.length} 个文件，自动三方合并 ${sameFileCheck.autoMergedFiles.length} 个文件，相同提案去重 ${sameFileCheck.deduplicatedFiles.length} 个文件，已处于目标内容 ${workspaceCheck.alreadyAppliedFiles.length} 个文件。`,
    },
    interactiveRequest: null,
  };
}
