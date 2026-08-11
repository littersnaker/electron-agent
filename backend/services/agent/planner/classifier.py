"""Code Agent 请求分类模块。

分类器既要避免分析问题误触发写入，也要识别代码会话中的“继续做完”“修好再交付”这类
省略式追问。执行模式只作为辅助信号，不能覆盖用户明确提出的只读要求。
"""

from __future__ import annotations

import re
from typing import Literal

RequestMode = Literal["workspace_info", "read_only", "code_change", "interactive_reply"]
AgentMode = Literal["suggest", "auto_edit", "full_auto"]

_WRITE_PATTERNS = (
    r"\b(add|create|implement|develop|fix|modify|update|delete|rename|refactor|write|apply|build)\b",
    r"新增|创建|实现|开发|制作|搭建|做成|完善|修复|修改|更新|删除|重命名|重构|写入|替换|迁移|调整|改好|修好|落地",
)
_CONTINUATION_WRITE_PATTERNS = (
    r"\b(continue|resume|retry|finish it|complete it|do it|ship it)\b",
    r"继续|接着|恢复任务|重试|再试|重新做|做完|完成它|干完|活干完|处理完|帮我做|帮我弄|"
    r"跑起来|直接执行|开始做|继续写|继续改|不要只分析|不要只读|把代码写完|交付代码",
)
_MODE_SWITCH_WRITE_PATTERNS = (
    r"\b(?:switch|change|go|return)\s+(?:back\s+)?to\s+"
    r"(?:edit|write|writable|auto edit|full auto)\s+mode\b",
    r"(?:切回|切换到|切到|恢复|启用|开启|打开|使用|改成)\s*"
    r"(?:读写|可写|写入|编辑|自动编辑|全自动)(?:模式|权限|工具)?",
)
_REPAIR_FOLLOWUP_PATTERNS = (
    r"\b(error|failed|failure|broken|stuck|not working)\b",
    r"报错|失败|卡住|没做完|没有完成|没完成|不能写|没有写入|工具没了|一直试",
)
_EXPLICIT_READ_ONLY_PATTERNS = (
    r"\b(read only|analysis only|do not modify|don't modify|no changes)\b",
    r"只分析|仅分析|只解释|仅解释|不要修改|不要写入|先别改|暂时别改|先分析|先看看原因",
)
_NEGATED_WRITE_DIRECTIVE_PATTERNS = (
    r"\b(?:do not|don't|dont|never|no need to)\s+"
    r"(?:modify|edit|write|change|update|delete|rename|refactor)\b",
    r"(?:不要|别|禁止|无需|不用|不可|不能)\s*(?:再)?"
    r"(?:修改|编辑|写入|改动|更新|删除|重命名|重构)",
)
_READ_ONLY_COMPLAINT_PATTERNS = (
    r"\b(?:why|still|keeps?)\b[^\n]{0,80}\b(?:read only|analysis only)\b",
    r"(?:为什么|怎么|一直|每次|还是|竟然|结果|现在)[^\n，。；]{0,40}"
    r"(?:只分析|仅分析|只读|不能写|没有写入|没写入)",
    r"(?:不要|别|不能|不是|并非)[^\n，。；]{0,12}(?:只分析|仅分析|只读)",
    r"(?:只分析|仅分析|只读)[^\n，。；]{0,40}(?:不干活|不修改|没法写|不能写|没有写入)",
)
_READ_PATTERNS = (
    r"\b(explain|analyze|review|find|search|where|why|how)\b",
    r"解释|分析|审查|查找|搜索|在哪|为什么|怎么|阅读|总结|原因",
)
_WORKSPACE_PATTERNS = (
    r"项目路径|工作区路径|当前项目|项目名称|绑定目录",
    r"\b(workspace|project path|working directory)\b",
)


def _matches(patterns: tuple[str, ...], text: str) -> bool:
    """判断文本是否命中任意分类规则。"""

    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def _remove_negated_write_directives(text: str) -> str:
    """移除“不要修改”一类否定片段，避免把禁止写入误判成写入请求。

    这里只移除明确的动作短语，不删除后面的作用域文本。例如“不要修改后端，只修改
    前端”会保留“后端，只修改前端”，后半句仍能被识别为真实修改目标。
    """

    cleaned = text
    for pattern in _NEGATED_WRITE_DIRECTIVE_PATTERNS:
        cleaned = re.sub(pattern, " ", cleaned, flags=re.IGNORECASE)
    return cleaned


def _has_positive_write_intent(text: str) -> bool:
    """判断文本中是否仍存在未被否定的修改或继续执行意图。"""

    cleaned = _remove_negated_write_directives(text)
    return (
        _matches(_WRITE_PATTERNS, cleaned)
        or _matches(_CONTINUATION_WRITE_PATTERNS, cleaned)
        or _matches(_MODE_SWITCH_WRITE_PATTERNS, cleaned)
    )


def classify_request(
    text: str,
    *,
    agent_mode: AgentMode = "auto_edit",
    conversation_text: str = "",
) -> RequestMode:
    """根据当前消息、执行模式和最近会话判断本轮应只读还是继续修改。

    强写入表达优先于普通“为什么/怎么”等疑问词；只有“只分析、不要修改”这种明确
    限制才会强制进入只读模式。自动编辑和全自动模式不会无条件写文件，而只用于识别
    “继续、做完、重试”这类依赖上文的省略式指令。
    """

    normalized = text.strip().lower()
    recent = conversation_text.strip().lower()
    if normalized.startswith("[interactive_reply]"):
        return "interactive_reply"
    if _matches(_WORKSPACE_PATTERNS, normalized):
        return "workspace_info"

    positive_write_intent = _has_positive_write_intent(normalized)
    explicit_read_only = _matches(_EXPLICIT_READ_ONLY_PATTERNS, normalized)
    read_only_complaint = _matches(_READ_ONLY_COMPLAINT_PATTERNS, normalized)

    # “为什么只分析、不干活，这次把代码写完”描述的是权限异常，不是要求只读。
    # 这类投诉必须优先恢复写入模式，否则“只分析”三个字会覆盖后面的明确执行要求。
    if read_only_complaint and positive_write_intent:
        return "code_change"

    # 同一句中既要求先分析又要求随后修复时，最终交付目标仍是代码修改。只有没有任何
    # 正向写入意图的“只分析/不要修改”才真正进入只读 Agent。
    if positive_write_intent:
        return "code_change"
    if explicit_read_only:
        return "read_only"

    if _matches(_READ_PATTERNS, normalized):
        return "read_only"

    # 自动模式中的报错追问可能省略了原任务。只有最近会话存在明确修改目标，且当前
    # 消息本身描述执行失败时，才继承为代码修改请求；普通“为什么”仍保持只读。
    if agent_mode in {"auto_edit", "full_auto"}:
        prior_write_intent = _matches(_WRITE_PATTERNS, recent)
        repair_followup = _matches(_REPAIR_FOLLOWUP_PATTERNS, normalized)
        if prior_write_intent and repair_followup:
            return "code_change"
    return "read_only"


def resolve_effective_code_request(
    current_text: str,
    recent_user_messages: list[str],
) -> str:
    """为省略式追问补回最近一次明确代码任务，避免 Planner 只看到“继续做”。"""

    normalized = current_text.strip()
    if _matches(_WRITE_PATTERNS, normalized.lower()) and not _matches(
        _CONTINUATION_WRITE_PATTERNS, normalized.lower()
    ):
        return normalized

    for previous in reversed(recent_user_messages[:-1]):
        candidate = previous.strip()
        if not candidate or not _matches(_WRITE_PATTERNS, candidate.lower()):
            continue
        if candidate == normalized:
            return normalized
        return f"{candidate[:12_000]}\n\n本轮补充要求：\n{normalized[:4_000]}"
    return normalized


__all__ = ["AgentMode", "RequestMode", "classify_request", "resolve_effective_code_request"]
