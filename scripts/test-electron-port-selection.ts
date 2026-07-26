import net from "net";
import {
  findAvailableServerPort,
  SERVER_HOST,
} from "../electron/server-port";

/**
 * 创建一个真实 TCP 监听器并保持占用，用于模拟“端口已被其他程序使用”的场景。
 * 端口传入 0 时由操作系统选择当前可用端口，可避免测试本身依赖固定测试端口。
 */
function holdRandomPort(): Promise<{
  port: number;
  server: net.Server;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen({ host: SERVER_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("测试监听器未能获取 TCP 端口"));
        return;
      }

      resolve({ port: address.port, server });
    });
  });
}

/** 安全关闭测试监听器，并把关闭异常继续抛给测试入口。 */
function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function run(): Promise<void> {
  const { port: occupiedPort, server } = await holdRandomPort();

  try {
    process.env.ELECTRON_PORT_SCAN_START = String(occupiedPort);
    const selectedWhileOccupied = await findAvailableServerPort();

    if (selectedWhileOccupied === occupiedPort) {
      throw new Error(`动态端口测试失败：仍然选择了已占用端口 ${occupiedPort}`);
    }

    await closeServer(server);

    process.env.ELECTRON_PORT_SCAN_START = String(occupiedPort);
    const selectedAfterRelease = await findAvailableServerPort();

    if (selectedAfterRelease !== occupiedPort) {
      throw new Error(
        `端口释放测试失败：期望重新选择 ${occupiedPort}，实际选择 ${selectedAfterRelease}`,
      );
    }

    console.log(
      `[通过] 占用 ${occupiedPort} 时自动选择 ${selectedWhileOccupied}；释放后重新选择 ${selectedAfterRelease}。`,
    );
  } finally {
    // 前面的断言失败时监听器可能仍然存在；finally 确保测试不会遗留占用端口。
    if (server.listening) {
      await closeServer(server);
    }
    delete process.env.ELECTRON_PORT_SCAN_START;
  }
}

void run().catch((error: unknown) => {
  console.error("[失败] Electron 动态端口回归测试未通过:", error);
  process.exitCode = 1;
});
