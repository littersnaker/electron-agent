import net from "net";

/**
 * Electron 内嵌的 Next.js 服务只监听本机回环地址，避免被局域网中的其他设备访问。
 * 使用明确的 IPv4 地址还能避免部分系统把 localhost 解析为 IPv6 后出现连接差异。
 */
export const SERVER_HOST = "127.0.0.1";

/**
 * 默认从 3100 开始扫描，主动避开最常被 Next.js 开发服务占用的 3000。
 * 若 3100 已被其他程序占用，会继续检测 3101、3102……直到找到可用端口。
 */
const DEFAULT_PORT_SCAN_START = 3100;
const MAX_SEQUENTIAL_PORT_CHECKS = 200;

// 3000 常被项目根目录的 `next dev` 或其他前端开发服务占用。
// Electron 内嵌服务主动避开该端口，减少并发启动时的竞争。
const RESERVED_PORTS = new Set([3000]);

/**
 * 检查指定 TCP 端口能否在本机回环地址上监听。
 *
 * 这里只进行一次短暂监听并立即释放，不会启动真实业务服务。端口在检测与 Next.js
 * 正式启动之间理论上存在极短的竞争窗口，但顺序扫描配合后面的启动错误处理，已经能
 * 避免绝大多数“3000 端口已占用”问题。
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probeServer = net.createServer();

    // 检测用服务不应阻止 Electron 进程正常退出。
    probeServer.unref();
    probeServer.once("error", () => resolve(false));
    probeServer.listen(
      {
        host: SERVER_HOST,
        port,
        exclusive: true,
      },
      () => {
        probeServer.close((closeError) => resolve(closeError === undefined));
      },
    );
  });
}

/**
 * 获取操作系统随机分配的临时端口，作为顺序扫描全部失败时的兜底方案。
 */
function requestEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probeServer = net.createServer();

    probeServer.unref();
    probeServer.once("error", reject);
    probeServer.listen(
      {
        host: SERVER_HOST,
        port: 0,
        exclusive: true,
      },
      () => {
        const address = probeServer.address();
        if (!address || typeof address === "string") {
          probeServer.close();
          reject(new Error("操作系统未返回可用的 TCP 端口"));
          return;
        }

        const allocatedPort = address.port;
        probeServer.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          resolve(allocatedPort);
        });
      },
    );
  });
}

/**
 * 从可配置起点开始寻找空闲端口。
 *
 * 可通过 ELECTRON_PORT_SCAN_START 调整扫描起点；传入非法值时自动回退到 3100。
 * 该变量只决定“从哪里开始找”，不会强制占用某个固定端口。
 */
export async function findAvailableServerPort(): Promise<number> {
  const configuredStart = Number.parseInt(
    process.env.ELECTRON_PORT_SCAN_START ?? "",
    10,
  );
  const scanStart =
    Number.isInteger(configuredStart) &&
    configuredStart >= 1024 &&
    configuredStart <= 65535
      ? configuredStart
      : DEFAULT_PORT_SCAN_START;

  const scanEnd = Math.min(
    scanStart + MAX_SEQUENTIAL_PORT_CHECKS - 1,
    65535,
  );

  for (
    let candidatePort = scanStart;
    candidatePort <= scanEnd;
    candidatePort += 1
  ) {
    if (RESERVED_PORTS.has(candidatePort)) continue;

    if (await isPortAvailable(candidatePort)) {
      return candidatePort;
    }
  }

  // 顺序扫描范围均不可用时，由操作系统从临时端口范围中挑选一个空闲端口。
  return requestEphemeralPort();
}
