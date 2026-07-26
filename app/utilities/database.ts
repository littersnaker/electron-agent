// 模块说明：封装浏览器 IndexedDB 中的会话与设置读写。
import type { ChatSession } from "../constants/page-constants";

const DATABASE_NAME = "GeminiChatDB";
const DATABASE_VERSION = 1;
const SESSION_STORE_NAME = "sessions";
const SETTING_STORE_NAME = "settings";

/** 打开聊天应用数据库，并在首次运行时创建对象仓库。 */
export function openChatDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE_NAME)) {
        database.createObjectStore(SESSION_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SETTING_STORE_NAME)) {
        database.createObjectStore(SETTING_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 读取全部本地会话。 */
export async function listStoredSessions(): Promise<ChatSession[]> {
  const database = await openChatDatabase();
  return new Promise((resolve) => {
    const transaction = database.transaction(SESSION_STORE_NAME, "readonly");
    const request = transaction.objectStore(SESSION_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

/** 新增或覆盖一条本地会话。 */
export async function saveChatSession(session: ChatSession): Promise<void> {
  const database = await openChatDatabase();
  const transaction = database.transaction(SESSION_STORE_NAME, "readwrite");
  transaction.objectStore(SESSION_STORE_NAME).put(session);
}

/** 根据会话 ID 删除本地会话。 */
export async function deleteChatSession(sessionId: string): Promise<void> {
  const database = await openChatDatabase();
  const transaction = database.transaction(SESSION_STORE_NAME, "readwrite");
  transaction.objectStore(SESSION_STORE_NAME).delete(sessionId);
}

/** 保存单个应用设置。 */
export async function saveApplicationSetting(
  key: string,
  value: string,
): Promise<void> {
  const database = await openChatDatabase();
  const transaction = database.transaction(SETTING_STORE_NAME, "readwrite");
  transaction.objectStore(SETTING_STORE_NAME).put({ key, value });
}

/** 读取单个应用设置。 */
export async function getApplicationSetting(
  key: string,
): Promise<string | null> {
  const database = await openChatDatabase();
  return new Promise((resolve) => {
    const transaction = database.transaction(SETTING_STORE_NAME, "readonly");
    const request = transaction.objectStore(SETTING_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result?.value || null);
    request.onerror = () => resolve(null);
  });
}

// 保留旧导出，避免其他模块在迁移期间中断。
export const openDB = openChatDatabase;
export const getAllSessions = listStoredSessions;
export const saveSessionToDB = saveChatSession;
export const deleteSessionFromDB = deleteChatSession;
export const saveSetting = saveApplicationSetting;
export const getSetting = getApplicationSetting;
