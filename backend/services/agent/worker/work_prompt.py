"""Code Agent Worker 的系统提示词、可见状态与失败分类助手。

从原 work_worker.py 拆分：这些是每轮 Worker 循环内联使用的纯函数，
与多轮执行主循环解耦，便于独立测试与维护。
"""

from __future__ import annotations

import json

from backend.services.agent.harness.models import ProjectHarness
from backend.services.agent.shared.loop_protocol import AgentAction
from backend.services.agent.shared.loop_support import ExecutionMode
from backend.services.agent.shared.tool_registry import (
    code_mode_enabled,
    render_tool_catalog,
)
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import FailureKind, WorkWorkerState


def _shorten_paths(paths: list[str]) -> str:
    """把路径列表压缩成前端可读的短文本。"""

    unique = list(dict.fromkeys(str(item) for item in paths if str(item).strip()))
    if not unique:
        return "（未指定）"
    if len(unique) <= 5:
        return "、".join(unique)
    return "、".join(unique[:5]) + f" 等 {len(unique)} 个文件"


def _action_status(action: AgentAction, work: WorkItem) -> str:
    """把当前轮动作转换成“正在读/改什么文件”的可见状态。"""

    prefix = f"{work.id} · {work.title}："
    if action.action == "read":
        return f"{prefix}正在读取文件：{_shorten_paths(action.paths)}"
    if action.action == "search":
        return f"{prefix}正在搜索：{action.query[:80]}"
    if action.action == "inspect":
        files = _shorten_paths(action.paths)
        return f"{prefix}正在分析代码：{files}"
    if action.action == "edit":
        files = _shorten_paths(sorted({operation.path for operation in action.operations}))
        return f"{prefix}正在修改文件：{files}"
    if action.action == "factory":
        return f"{prefix}正在执行 Software Factory {action.factory_mode}"
    if action.action == "run":
        return f"{prefix}正在执行验证命令：{action.command[:80]}"
    if action.action == "complete_work":
        return f"{prefix}正在确认完成"
    return f"{prefix}正在执行 {action.action}"


def _action_files(action: AgentAction) -> list[str]:
    """提取当前动作涉及的文件路径，供前端展示“正在修改什么文件”。"""

    if action.action in {"read", "inspect"}:
        return list(action.paths)
    if action.action == "edit":
        return sorted({operation.path for operation in action.operations})
    return []


def _worker_prompt(
    work: WorkItem,
    harness: ProjectHarness,
    execution_mode: ExecutionMode,
    state: WorkWorkerState | None = None,
) -> str:
    """生成聚焦当前 Work 的短系统提示词，避免每轮重复完整用户需求。"""

    run_rule = (
        "允许 run 执行 Harness 已识别的受限质量命令。"
        if execution_mode == "full_auto"
        else "当前为自动编辑模式，run 会被跳过。"
    )
    work_payload = {
        "id": work.id,
        "title": work.title,
        "objective": work.objective[:1_500],
        "acceptanceCriteria": work.acceptance_criteria[:8],
        "dependencies": work.dependencies,
        "targetFiles": work.target_files[:30],
        "priority": work.priority,
    }
    factory_hint = ""
    if any(
        term in f"{work.title} {work.objective}".lower()
        for term in ("mock", "契约", "contract", "openapi", "数据源", "api client")
    ):
        factory_hint = (
            "- 涉及 Mock、契约或 API 生成时，优先调用 factory 工具（plan/generate/validate）"
            "按 outputRoot 落地；执行 generate 前先确认输出目录：产物已存在且 validate "
            "通过时直接复用，禁止重复生成或覆盖；只有确实需要补齐时才 generate。禁止把整份 "
            "Mock JSON 作为 edit 内容手写，大批量生成必须交给 factory，单轮 edit 只改必要文件。\n"
        )
    retry_directive = ""
    if state is not None and state.attempt_number > 1:
        retry_directive = (
            "- 当前是重试尝试：先 read 目标文件核对验收标准；如果改动已存在且符合要求，"
            "直接 complete_work，不要重复编辑；只补齐缺失部分，禁止重做已应用的内容。\n"
            "- 不要重新做完整审计：如果上次失败来自校验或错误信息，直接 read 错误提到的"
            "具体文件并只修复这些点，然后立即完成。\n"
        )
    # run_code 批量执行通道：开启 CODE_AGENT_CODE_MODE 才注入 SDK 说明。
    sdk_block = ""
    if code_mode_enabled():
        from backend.services.agent.code_mode import SDK_BLOCK

        sdk_block = SDK_BLOCK.strip()
    return f"""你是 Code Agent 的并行 Worker，只处理 CURRENT WORK。
工具：
{render_tool_catalog(compact=True, execution_mode=execution_mode)}

{sdk_block}
协议：每轮只返回一个 JSON 对象，不得附加 Markdown。  - 已知文件必须一次 read 批量读取；Harness 已预读的内容不得再次搜索。
  - 动手 edit 前先核对目标文件是否已满足 CURRENT WORK 的验收标准；已满足则直接
    complete_work，不要重复修改；只修改确实缺失的部分。
  - read 默认返回完整文件内容；超大文件可用 offsets（字符偏移）分页查看。
  - 最多补充必要上下文，随后立即 edit；通过验收后立即 complete_work。
  - factory 只用于尚未被本地 Factory Worker处理的数据层工作。
  {factory_hint}
  {retry_directive}
  - 文件版本冲突时重新 read 冲突文件；不得重做其他已成功 Work。
- edit 就是写入/新建文件工具：operations.type=write 可创建文件，replace 可精确修改。
- write 必须一次给出完整可运行内容；禁止空文件、占位符或分步填空；新建文件后不要反复
  read 验证，路径正确就直接 complete_work。
- 如果确认目标文件已满足验收标准或无法确定修改点，直接 complete_work 说明原因，
  不要返回空 operations 的 edit。
- 一次 edit 必须用多组 operations 完成本 Work 当前轮能确定的所有修改点；禁止
  “改一处 → read 验证 → 再改下一处”的小步循环，也不要逐轮拆分成多个 edit。
- edit 写入成功后不要 read 刚写过的文件验证：工具 OBSERVATION 已返回变更结果，
  直接 complete_work。read 只用于首次了解文件或编辑前的现状核对。
- write 只用于新建文件；修改已存在文件一律用 replace（可在同一 edit 内多组），
  禁止对已存在文件整文件 write 重写。
- replace 的 old 必须来自最近 read 返回的 OBSERVATION 原文；同文件已被本 Work
  改过时，不得再用旧内容做 replace（会失配）。若需再次修改同一文件，先基于
  最新 OBSERVATION 或上一轮"上次编辑结果"确认现状，再生成精确 old。
- replace 的 old/new 只包含足以唯一定位的最小片段（通常 3~8 行），禁止把整个
  文件或大段代码块作为 old/new 输出；改动只有几行时不要整文件重写。
- replace 最小示例（old/new 各 1~2 行即可）：
  {{"type":"replace","path":"src/app.scss","old":"padding-bottom: var(--spacing-xl);","new":"padding-bottom: var(--spacing-2xl);"}}
- 自动编辑模式无法运行命令：需要运行构建/测试才能验证的任务，做静态修复后应在
  complete_work 中说明“需切换全自动模式运行验证命令”。
- 敏感路径在目录树和工具层都会被过滤；收到 SECURITY SKIP 后不得重试该路径，改读 .env.example 或配置类型。
- tabBar/小程序图标必须引用真实存在的 PNG 位图（iconPath 支持 png/jpg/jpeg，不支持 SVG）；
  图标文件缺失时系统会自动补齐占位 PNG，你只需保证路径符合项目约定（Taro 相对 src，原生相对根目录），
  不要写空路径，也不要伪造二进制图片文件。
- 不读取密钥或越出项目；源码不超过 500 行；遵守中文注释、ESLint 和项目格式。
- {run_rule}

{harness.worker_directive(work)}

CURRENT WORK:
{json.dumps(work_payload, ensure_ascii=False)}
"""


def _failure_kind(error: str) -> FailureKind:
    """把工具失败区分为代码、验证或运行时错误，避免 Planner 修复协议本身。"""

    normalized = error.upper()
    if normalized.startswith("VALIDATION FAILED") or normalized.startswith("RUN "):
        return "validation"
    if "PARALLEL" in normalized or "内容已变化" in error:
        return "resource"
    if "PROTOCOL" in normalized or "TIMEOUT" in normalized:
        return "runtime"
    return "code"


__all__ = [
    "_shorten_paths",
    "_action_status",
    "_action_files",
    "_worker_prompt",
    "_failure_kind",
]
