/**
 * 模块职责：在 Electron 主进程中持久化 API Key，并尽可能使用系统加密能力。
 *
 * Renderer 只通过受限 IPC 读写白名单字段，不能指定任意文件路径。safeStorage 可用时，
 * 整份 JSON 使用操作系统密钥链加密；Linux 无密钥环等极端环境下才退回 Base64，且会
 * 明确记录警告。该降级仍优于把凭证绑定在某个临时网页 Origin 的 localStorage 中。
 */
import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { getStableDataPath } from "./data-paths";

const CREDENTIAL_FILE_NAME = "secure-credentials.json";
const MAX_CREDENTIAL_LENGTH = 20_000;

const ALLOWED_CREDENTIAL_KEYS = new Set([
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "GLM_API_KEY",
  "GLM_BASE_URL",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "DOUBAO_API_KEY",
  "DOUBAO_BASE_URL",
  "TALORDATA_API_TOKEN",
  "SERPAPI_API_KEY",
  "KEEPA_API_KEY",
  "AMAZON_SP_API_CLIENT_ID",
  "AMAZON_SP_API_CLIENT_SECRET",
  "AMAZON_SP_API_REFRESH_TOKEN",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_MERCHANT_ID",
  "TEMU_APP_KEY",
  "TEMU_APP_SECRET",
  "TEMU_ACCESS_TOKEN",
  "ALIBABA_1688_APP_KEY",
  "ALIBABA_1688_APP_SECRET",
  "ALIBABA_1688_ACCESS_TOKEN",
]);

type CredentialStore = Record<string, string>;

interface CredentialEnvelope {
  format: "safe-storage" | "base64";
  payload: string;
  updatedAt: string;
}

/** 严格清洗 IPC 输入，只接受已知字段和合理长度的字符串。 */
function normalizeCredentials(input: unknown): CredentialStore {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: CredentialStore = {};

  for (const [key, rawValue] of Object.entries(input)) {
    if (!ALLOWED_CREDENTIAL_KEYS.has(key) || typeof rawValue !== "string") {
      continue;
    }
    const value = rawValue.trim();
    if (value && value.length <= MAX_CREDENTIAL_LENGTH) result[key] = value;
  }
  return result;
}

/** 以临时文件 + rename 原子替换，避免强制关机留下半个 JSON。 */
function writeEnvelope(envelope: CredentialEnvelope): void {
  const filePath = getStableDataPath(CREDENTIAL_FILE_NAME);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(envelope, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch {
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporaryPath, filePath);
  }
  try {
    // POSIX 上收紧为仅当前用户可读写；Windows 会忽略不适用的权限位。
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    console.warn("[Electron] 无法收紧凭证文件权限", error);
  }
}

/** 从固定凭证文件读取并解密；任何损坏都安全回退为空对象。 */
export function readSecureCredentials(): CredentialStore {
  try {
    const filePath = getStableDataPath(CREDENTIAL_FILE_NAME);
    const envelope = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as CredentialEnvelope;
    const encrypted = Buffer.from(envelope.payload, "base64");
    const plainText =
      envelope.format === "safe-storage"
        ? safeStorage.decryptString(encrypted)
        : encrypted.toString("utf8");
    return normalizeCredentials(JSON.parse(plainText));
  } catch {
    return {};
  }
}

/** 覆盖写入当前完整凭证集合，不保留前端已经删除的旧 Key。 */
export function writeSecureCredentials(input: unknown): CredentialStore {
  const credentials = normalizeCredentials(input);
  const plainText = JSON.stringify(credentials);
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  const payload = encryptionAvailable
    ? safeStorage.encryptString(plainText)
    : Buffer.from(plainText, "utf8");

  if (!encryptionAvailable) {
    console.warn(
      "[Electron] 系统凭证加密不可用，API Key 已使用 Base64 本地保存；请配置系统密钥环以启用加密。",
    );
  }
  writeEnvelope({
    format: encryptionAvailable ? "safe-storage" : "base64",
    payload: payload.toString("base64"),
    updatedAt: new Date().toISOString(),
  });
  return credentials;
}
