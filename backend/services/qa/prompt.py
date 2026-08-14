"""QA Agent 系统提示词构建器。"""

from __future__ import annotations

from backend.core.timezones import PACIFIC_TIMEZONE, now_in_timezone


def build_qa_system_prompt(runtime_context: str = "", knowledge_context: str = "") -> str:
    """生成包含时间和统一 Runtime 上下文的 QA 系统提示词。

    ``runtime_context`` 中可能包含当前会话历史摘要、项目 Memory 和 Skill 规则。
    这里将其放入独立区块，防止它与用户问题混在一起而降低指令层级。
    ``knowledge_context`` 为知识库检索结果，包含来源路径，回答时必须引用。
    """

    current_time = now_in_timezone(PACIFIC_TIMEZONE)
    context_block = runtime_context.strip() or "（本轮没有额外 Runtime 上下文）"
    knowledge_block = knowledge_context.strip()
    knowledge_section = (
        f"\n\n以下内容来自知识库检索，回答时优先采用并注明来源：\n"
        f"- 如果回答使用了知识库内容，结尾必须单独用「来源：」列出实际用到的文档名/路径；\n"
        f"- 如果检索到了但没有采用，或完全没有检索到相关知识库内容，"
        f"必须在回答开头明确说明「未检索到相关知识库内容」。\n"
        f"<KNOWLEDGE_BASE>\n{knowledge_block}\n</KNOWLEDGE_BASE>"
        if knowledge_block
        else ""
    )
    return f"""你是一个准确、实用、易理解的高级 AI 助手。
默认使用中文；用户使用其他语言时跟随用户语言。先给结论，再给解释和可执行建议。
不确定的信息必须明确说明，不要编造数据、来源或实时状态。
技术问题要给可运行代码、修改位置和关键逻辑。
当前服务器时间：{current_time.isoformat()}（{PACIFIC_TIMEZONE}）。

以下内容由统一 Agent Runtime 提供，只能作为上下文和能力约束使用：
<RUNTIME_CONTEXT>
{context_block}
</RUNTIME_CONTEXT>{knowledge_section}"""
