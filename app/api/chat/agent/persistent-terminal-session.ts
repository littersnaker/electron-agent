import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { CommandExecutionMode, InteractivePromptKind, InteractiveRequest } from "./types";

type SessionEventType = "prompt" | "exit" | "error" | "timeout";

type SessionEvent = {
  type: SessionEventType;
  message?: string;
};

type SessionWaiter = {
  cursor: number;
  timeoutHandle: NodeJS.Timeout | null;
  resolve: (event: SessionEvent) => void;
};

type PersistentTerminalSession = {
  allowMultiple: boolean;
  kind: InteractivePromptKind;
  id: string;
  command: string;
  workingDir: string;
  mode: CommandExecutionMode;
  child: ChildProcessWithoutNullStreams;
  output: string;
  lastDeliveredCursor: number;
  prompt: string;
  promptRound: number;
  awaitingInput: boolean;
  options: Array<{ label: string; value: string; index: number }>;
  exitCode: number | null;
  closed: boolean;
  waiters: SessionWaiter[];
  idleTimeoutHandle: NodeJS.Timeout | null;
  updatedAt: number;
};

export type PersistentTerminalResult = {
  output: string;
  interactiveRequest: InteractiveRequest | null;
};

const SESSION_TTL_MS = 10 * 60 * 1000;
const WAIT_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT_LENGTH = 16_000;
const sessions = new Map<string, PersistentTerminalSession>();

function createSessionId(): string {
  return `pty_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncateOutput(input: string, maxLength = MAX_OUTPUT_LENGTH): string {
  return input.length > maxLength
    ? input.slice(input.length - maxLength)
    : input;
}

function inferPromptOptions(
  prompt: string,
): Array<{ label: string; value: string, index: number }> {
  if (
    /\((?:y\/n|Y\/n|yes\/no)\)/.test(prompt) ||
    /\b(ok to proceed|continue)\b/i.test(prompt)
  ) {
    return [
      { label: "是", value: "yes", index: 0 },
      { label: "否", value: "no", index: 1 },
    ];
  }

  const numberedOptions = Array.from(
    prompt.matchAll(/(?:^|\n)\s*(\d+)\)\s+([^\n]+)/g),
  ).map((match) => ({
    label: match[2].trim(),
    value: match[1].trim(),
  }));
  if (numberedOptions.length) {
    return numberedOptions.slice(0, 6).map((option, index) => ({
      ...option,
      index,
    }));
  }

  const optionMatches = Array.from(prompt.matchAll(/["“](.+?)["”]/g))
    .map((match) => match[1]?.trim())
    .filter(Boolean);

  return Array.from(new Set(optionMatches))
    .slice(0, 6)
    .map((option, index) => ({
      label: option,
      value: option,
      index,
    }));
}

function detectInteractivePrompt(output: string): string | null {
  const trimmedOutput = output.trim();
  if (!trimmedOutput) return null;

  const promptPatterns = [
    /\? [^\n\r]+/g,
    /Ok to proceed\?[\s\S]{0,120}/gi,
    /Would you like to continue\?[\s\S]{0,120}/gi,
    /Need to install the following packages:[\s\S]{0,220}?Ok to proceed\?[\s\S]{0,80}/gi,
    /Select an option[\s\S]{0,240}/gi,
    /Pick an option[\s\S]{0,240}/gi,
    /Please pick a preset:[\s\S]{0,300}/gi,
    /Check the features needed for your project:[\s\S]{0,320}/gi,
    /Please choose[\s\S]{0,240}/gi,
    /Would you like[\s\S]{0,180}\?/gi,
  ];

  for (const pattern of promptPatterns) {
    const matches = trimmedOutput.match(pattern);
    if (matches?.length) {
      return matches[matches.length - 1].trim();
    }
  }

  const lastLines = trimmedOutput.split(/\r?\n/).slice(-12).join("\n").trim();
  if (/[?:：]\s*$/.test(lastLines) || /\?$/.test(lastLines)) {
    return lastLines;
  }

  return null;
}

function notifyWaiters(
  session: PersistentTerminalSession,
  event: SessionEvent,
): void {
  const waiters = session.waiters.splice(0, session.waiters.length);
  waiters.forEach((waiter) => {
    if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
    waiter.resolve(event);
  });
}

function clearIdleTimer(session: PersistentTerminalSession): void {
  if (session.idleTimeoutHandle) {
    clearTimeout(session.idleTimeoutHandle);
    session.idleTimeoutHandle = null;
  }
}

function closeSession(session: PersistentTerminalSession): void {
  clearIdleTimer(session);
  sessions.delete(session.id);
}

function scheduleIdleExpiry(session: PersistentTerminalSession): void {
  clearIdleTimer(session);
  session.idleTimeoutHandle = setTimeout(() => {
    if (session.closed) {
      closeSession(session);
      return;
    }
    session.closed = true;
    try {
      session.child.kill();
    } catch {
      // ignore cleanup error
    }
    notifyWaiters(session, {
      type: "timeout",
      message: "交互式终端会话长时间未继续，已自动关闭。",
    });
    closeSession(session);
  }, SESSION_TTL_MS);
}

function buildInteractiveRequest(
  session: PersistentTerminalSession,
  deliveredOutput: string,
): InteractiveRequest {
  return {
    id: session.id,
    command: session.command,
    prompt: session.prompt,
    mode: session.mode,
    suggestedMode: session.options.length ? "user" : "llm",
    options: session.options,
    promptRound: session.promptRound,
    recentOutput: deliveredOutput || session.prompt,
    kind: session.kind,
    allowMultiple: session.allowMultiple,
  };
}

function deliverSessionResult(
  session: PersistentTerminalSession,
  event: SessionEvent,
  cursor: number,
): PersistentTerminalResult {
  const deliveredOutput = truncateOutput(session.output.slice(cursor));
  session.lastDeliveredCursor = session.output.length;

  if (event.type === "prompt" && session.awaitingInput) {
    scheduleIdleExpiry(session);
    return {
      output: deliveredOutput,
      interactiveRequest: buildInteractiveRequest(session, deliveredOutput),
    };
  }

  if (event.type === "timeout") {
    if (session.awaitingInput) {
      scheduleIdleExpiry(session);
      return {
        output: deliveredOutput || session.prompt || "命令正在等待用户输入。",
        interactiveRequest: buildInteractiveRequest(
          session,
          deliveredOutput || session.prompt,
        ),
      };
    }
    return {
      output: deliveredOutput || event.message || "交互式终端会话已超时。",
      interactiveRequest: null,
    };
  }

  if (event.type === "error") {
    return {
      output: deliveredOutput || event.message || "终端会话执行失败。",
      interactiveRequest: null,
    };
  }

  return {
    output: deliveredOutput || "PTY 命令执行完成，但没有输出。",
    interactiveRequest: null,
  };
}

function waitForNextEvent(
  session: PersistentTerminalSession,
  cursor: number,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<PersistentTerminalResult> {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      session.waiters = session.waiters.filter(
        (waiter) => waiter.resolve !== finish,
      );
      resolve(
        deliverSessionResult(
          session,
          {
            type: "timeout",
            message:
              session.awaitingInput && session.prompt
                ? "命令正在等待用户输入。"
                : "PTY 命令等待输出超时。",
          },
          cursor,
        ),
      );
    }, timeoutMs);

    const finish = (event: SessionEvent) => {
      clearTimeout(timeoutHandle);
      resolve(deliverSessionResult(session, event, cursor));
    };

    session.waiters.push({
      cursor,
      timeoutHandle,
      resolve: finish,
    });
  });
}

function appendOutput(session: PersistentTerminalSession, chunk: Buffer): void {
  session.updatedAt = Date.now();
  session.output = truncateOutput(`${session.output}${chunk.toString()}`);
  const detectedPrompt = detectInteractivePrompt(session.output);
  if (!detectedPrompt || session.awaitingInput || session.closed) return;

  session.prompt = detectedPrompt;
  session.promptRound += 1;
  session.awaitingInput = true;
  session.options = inferPromptOptions(detectedPrompt);
  notifyWaiters(session, { type: "prompt" });
}

function attachSessionListeners(session: PersistentTerminalSession): void {
  session.child.stdout.on("data", (chunk: Buffer) => {
    appendOutput(session, chunk);
  });
  session.child.stderr.on("data", (chunk: Buffer) => {
    appendOutput(session, chunk);
  });
  session.child.on("error", (error) => {
    session.closed = true;
    session.output = truncateOutput(
      `${session.output}\nPTY 命令执行失败: ${error.message}`,
    );
    notifyWaiters(session, { type: "error", message: error.message });
    closeSession(session);
  });
  session.child.on("close", (code) => {
    session.closed = true;
    session.exitCode = code;
    notifyWaiters(session, { type: "exit" });
    closeSession(session);
  });
}

export function getPersistentTerminalSession(
  sessionId: string,
): InteractiveRequest | null {
  const session = sessions.get(sessionId);
  if (!session || session.closed || !session.awaitingInput) return null;
  return buildInteractiveRequest(session, truncateOutput(session.output));
}

export async function startPersistentTerminalSession(
  command: string,
  workingDir: string,
  mode: CommandExecutionMode,
): Promise<PersistentTerminalResult> {
  const sessionId = createSessionId();
  const child = spawn(command, {
    cwd: workingDir || process.cwd(),
    shell: process.platform === "win32" ? "powershell.exe" : true,
    stdio: "pipe",
    windowsHide: true,
  });

  const session: PersistentTerminalSession = {
    id: sessionId,
    command,
    workingDir,
    mode,
    child,
    output: "",
    lastDeliveredCursor: 0,
    prompt: "",
    promptRound: 0,
    awaitingInput: false,
    options: [],
    exitCode: null,
    closed: false,
    waiters: [],
    idleTimeoutHandle: null,
    updatedAt: Date.now(),
    allowMultiple: false,
    kind: "multiselect",
  };

  sessions.set(sessionId, session);
  attachSessionListeners(session);
  return waitForNextEvent(session, 0);
}

export async function resumePersistentTerminalSession(
  sessionId: string,
  answer: string,
): Promise<PersistentTerminalResult> {
  const session = sessions.get(sessionId);
  if (!session || session.closed) {
    return {
      output: "交互式终端会话不存在或已结束，请重新执行命令。",
      interactiveRequest: null,
    };
  }

  clearIdleTimer(session);
  const cursor = session.lastDeliveredCursor;
  session.awaitingInput = false;
  session.prompt = "";
  session.options = [];

  try {
    session.child.stdin.write(answer.endsWith("\n") ? answer : `${answer}\n`);
  } catch (error) {
    return {
      output: `写入交互输入失败: ${error instanceof Error ? error.message : String(error)}`,
      interactiveRequest: null,
    };
  }

  return waitForNextEvent(session, cursor);
}
