export function createSessionId(): string {
  return "session_" + Date.now() + Math.random().toString(36).substring(2, 9);
}