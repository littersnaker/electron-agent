import { ChatSession } from "../const/pageConst";

const DB_NAME = "GeminiChatDB";
const DB_VERSION = 1;

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllSessions(): Promise<ChatSession[]> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction("sessions", "readonly");
    const req = tx.objectStore("sessions").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

export async function saveSessionToDB(session: ChatSession) {
  const db = await openDB();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").put(session);
}

export async function deleteSessionFromDB(sessionId: string) {
  const db = await openDB();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").delete(sessionId);
}

export async function saveSetting(key: string, value: string) {
  const db = await openDB();
  const tx = db.transaction("settings", "readwrite");
  tx.objectStore("settings").put({ key, value });
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction("settings", "readonly");
    const req = tx.objectStore("settings").get(key);
    req.onsuccess = () => resolve(req.result?.value || null);
    req.onerror = () => resolve(null);
  });
}