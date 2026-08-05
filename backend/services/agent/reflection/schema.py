"""复盘输出的 Pydantic Schema 与校验过滤。"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

Confidence = Literal["high", "medium", "low"]

MAX_FACTS = 8
MAX_LESSONS = 5
MAX_SKILL_UPDATES = 2
MAX_FACT_CHARS = 600
MAX_LESSON_CHARS = 800
MAX_SKILL_DIFF_CHARS = 1_000


class ReviewFact(BaseModel):
    """一条可复用的长期事实。"""

    content: str = Field(min_length=1, max_length=MAX_FACT_CHARS)
    scope: str = "project"
    confidence: Confidence = "medium"

    @field_validator("content")
    @classmethod
    def _content_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("content 不能为空")
        return value


class ReviewLesson(BaseModel):
    """一条经验/教训，附带触发场景。"""

    content: str = Field(min_length=1, max_length=MAX_LESSON_CHARS)
    trigger: str = Field(default="", max_length=300)
    confidence: Confidence = "medium"

    @field_validator("content")
    @classmethod
    def _content_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("content 不能为空")
        return value


class ReviewSkillUpdate(BaseModel):
    """一条技能更新建议（默认进审批门，不直接改写技能文件）。"""

    action: Literal["create", "patch"]
    name: str = Field(min_length=1, max_length=100)
    diff_summary: str = Field(min_length=1, max_length=MAX_SKILL_DIFF_CHARS)
    evidence: str = Field(default="", max_length=300)


class ReviewOutput(BaseModel):
    """复盘模型的结构化输出。"""

    facts: list[ReviewFact] = Field(default_factory=list)
    lessons: list[ReviewLesson] = Field(default_factory=list)
    skill_updates: list[ReviewSkillUpdate] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list, max_length=5)


_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def extract_json_object(text: str) -> dict[str, Any]:
    """从模型输出中提取第一个 JSON 对象（容忍 Markdown 围栏与前后解释）。"""

    raw = (text or "").strip()
    if not raw:
        raise ValueError("复盘模型返回空输出")
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        match = _JSON_BLOCK.search(raw)
        if not match:
            raise ValueError("复盘输出中未找到 JSON 对象")
        try:
            parsed = json.loads(match.group(0))
        except (ValueError, TypeError) as exc:
            raise ValueError(f"复盘输出 JSON 解析失败：{exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("复盘输出必须是 JSON 对象")
    return parsed


def parse_review_output(text: str) -> ReviewOutput:
    """解析并校验复盘输出；非法结构直接抛错，由调用方丢弃。"""

    payload = extract_json_object(text)
    return ReviewOutput.model_validate(payload)


def filter_review_output(output: ReviewOutput) -> ReviewOutput:
    """置信度过滤 + 数量/长度收敛，避免低质量内容污染记忆库。"""

    facts: list[ReviewFact] = []
    for fact in output.facts:
        if fact.confidence == "low":
            continue
        if not fact.content.strip():
            continue
        facts.append(fact)
        if len(facts) >= MAX_FACTS:
            break

    lessons: list[ReviewLesson] = []
    for lesson in output.lessons:
        if lesson.confidence == "low":
            continue
        if not lesson.content.strip():
            continue
        lessons.append(lesson)
        if len(lessons) >= MAX_LESSONS:
            break

    skill_updates = list(output.skill_updates)[:MAX_SKILL_UPDATES]
    risks = [str(item).strip() for item in output.risks if str(item).strip()][:5]
    return ReviewOutput(
        facts=facts,
        lessons=lessons,
        skill_updates=skill_updates,
        risks=risks,
    )


def review_output_has_content(output: ReviewOutput) -> bool:
    """判断过滤后的复盘是否还有值得写入的内容。"""

    return bool(output.facts or output.lessons or output.skill_updates)
