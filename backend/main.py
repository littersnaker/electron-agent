"""FastAPI 服务入口。

开发环境可通过 ``python -m backend.main`` 启动；Electron 打包后会启动由 PyInstaller
生成的同名可执行文件。生产环境中，FastAPI 还负责托管 Vite 构建后的 React 静态文件。
"""

from __future__ import annotations

import argparse
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.api.router import api_router
from backend.core.background import drain_background_tasks
from backend.core.config import get_settings
from backend.core.logging import configure_console_encoding, configure_logging
from backend.core.request_audit import RequestAuditMiddleware
from backend.core.timezones import PACIFIC_TIMEZONE, timezone_source
from backend.services.llm.custom_models import initialize_custom_models
from backend.services.llm.gateway import GATEWAY
from backend.services.runtime.bootstrap import RUNTIME
from backend.services.workspace.database import initialize_database

LOGGER = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """在应用启动时初始化数据库，在退出时关闭共享 HTTP 连接池。"""

    configure_logging()
    await initialize_database()
    await initialize_custom_models()
    await RUNTIME.initialize()
    LOGGER.info("FastAPI 后端已完成数据库、自定义模型和 Agent Runtime 初始化")
    LOGGER.info("时区支持来源：%s", timezone_source(PACIFIC_TIMEZONE))
    try:
        yield
    finally:
        # 先排空仍在运行的后台复盘/索引任务，再关闭共享连接池，避免
        # shutdown 期间的任务撞上已关闭的 httpx 连接（Event loop is closed）。
        await drain_background_tasks()
        await GATEWAY.close()
        LOGGER.info("FastAPI 后端已安全关闭")


def create_app() -> FastAPI:
    """创建并配置 FastAPI 应用实例。

    该工厂函数方便测试代码单独创建应用，不需要真正启动网络端口。
    """

    app = FastAPI(
        title="Multi-agent Desktop Python Backend",
        version="2.0.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:4173",
            "http://localhost:4173",
        ],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(RequestAuditMiddleware)
    app.include_router(api_router)
    _register_exception_handlers(app)
    _register_frontend(app)
    return app


def _register_exception_handlers(app: FastAPI) -> None:
    """把 FastAPI 默认 ``detail`` 错误转换成旧 React 代码读取的 ``error`` 字段。"""

    @app.exception_handler(HTTPException)
    async def handle_http_exception(_: Request, exc: HTTPException) -> JSONResponse:
        """处理业务主动抛出的 HTTP 错误。"""

        return JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})

    @app.exception_handler(RequestValidationError)
    async def handle_validation_exception(_: Request, exc: RequestValidationError) -> JSONResponse:
        """把 Pydantic 参数校验错误转换成便于初学者理解的中文响应。"""

        first = exc.errors()[0] if exc.errors() else {}
        location = ".".join(str(item) for item in first.get("loc", []))
        message = first.get("msg", "请求参数格式不正确")
        return JSONResponse(
            status_code=422,
            content={"error": f"请求参数 {location or 'body'} 校验失败：{message}"},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_exception(_: Request, exc: Exception) -> JSONResponse:
        """记录未预期异常，并向前端返回不含密钥和堆栈的错误信息。"""

        LOGGER.exception("未处理的后端异常", exc_info=exc)
        return JSONResponse(status_code=500, content={"error": "后端内部错误，请查看本地日志"})


def _register_frontend(app: FastAPI) -> None:
    """在生产环境注册 Vite 静态资源和单页应用回退路由。"""

    frontend_dir = get_settings().frontend_dir
    if frontend_dir is None or not frontend_dir.is_dir():
        return
    assets_dir = frontend_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{requested_path:path}", include_in_schema=False)
    async def serve_react_application(requested_path: str) -> FileResponse:
        """优先返回真实静态文件，否则返回 React 的 ``index.html``。"""

        candidate = (frontend_dir / requested_path).resolve()
        if frontend_dir in candidate.parents and candidate.is_file():
            return FileResponse(candidate)
        index_file = frontend_dir / "index.html"
        if not index_file.is_file():
            raise HTTPException(status_code=404, detail="前端构建文件不存在")
        return FileResponse(index_file)


def _parse_arguments() -> argparse.Namespace:
    """解析命令行主机、端口和日志等级参数。"""

    settings = get_settings()
    parser = argparse.ArgumentParser(description="启动 Multi-agent FastAPI 后端")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--log-level", default=settings.log_level.lower())
    parser.add_argument(
        "--reload",
        action="store_true",
        help="开发模式监听 Python 源码并自动重启 FastAPI worker",
    )
    parser.add_argument(
        "--reload-dir",
        action="append",
        default=[],
        help="开发模式需要监听的目录，可重复传入",
    )
    return parser.parse_args()


def run() -> None:
    """使用 Uvicorn 启动 FastAPI 服务。"""

    # 必须在 Uvicorn 创建热重载父进程前设置 UTF-8，否则 Windows 管道会把中文日志解码成乱码。
    configure_console_encoding()
    arguments = _parse_arguments()
    application = "backend.main:app" if arguments.reload else app
    uvicorn.run(
        application,
        host=arguments.host,
        port=arguments.port,
        log_level=arguments.log_level,
        reload=arguments.reload,
        reload_dirs=arguments.reload_dir or None,
    )


app = create_app()


if __name__ == "__main__":
    run()
