"""Code Agent 工程 Harness 的稳定数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.services.agent.shared.work_models import WorkItem


@dataclass(slots=True)
class ProjectHarness:
    """保存一次代码任务可复用的工程事实、Skill 和验证入口。"""

    framework: str = "unknown"
    package_manager: str = ""
    source_root: str = "."
    entry_files: list[str] = field(default_factory=list)
    config_files: list[str] = field(default_factory=list)
    quality_commands: list[str] = field(default_factory=list)
    skill_ids: list[str] = field(default_factory=list)
    skill_directives: list[str] = field(default_factory=list)
    task_kind: str = "coding"

    def to_json(self) -> dict[str, Any]:
        """转换成 Checkpoint 可保存的稳定 JSON。"""

        return {
            "framework": self.framework,
            "packageManager": self.package_manager,
            "sourceRoot": self.source_root,
            "entryFiles": list(self.entry_files),
            "configFiles": list(self.config_files),
            "qualityCommands": list(self.quality_commands),
            "skillIds": list(self.skill_ids),
            "skillDirectives": list(self.skill_directives),
            "taskKind": self.task_kind,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> ProjectHarness:
        """从 Checkpoint 恢复工程 Harness，并容忍旧版本缺失字段。"""

        return cls(
            framework=str(value.get("framework") or "unknown"),
            package_manager=str(value.get("packageManager") or ""),
            source_root=str(value.get("sourceRoot") or "."),
            entry_files=_strings(value.get("entryFiles")),
            config_files=_strings(value.get("configFiles")),
            quality_commands=_strings(value.get("qualityCommands")),
            skill_ids=_strings(value.get("skillIds")),
            skill_directives=_strings(value.get("skillDirectives")),
            task_kind=str(value.get("taskKind") or "coding"),
        )

    def compact_summary(self) -> str:
        """生成每个 Worker 可重复使用的短工程摘要。"""

        commands = ", ".join(self.quality_commands[:4]) or "按项目脚本自动识别"
        entries = ", ".join(self.entry_files[:6]) or "尚未识别"
        skills = ", ".join(self.skill_ids) or "workspace-code-agent"
        return (
            f"框架={self.framework}；包管理器={self.package_manager or '未知'}；"
            f"源码根={self.source_root}；入口={entries}；验证={commands}；"
            f"已选择 Skills={skills}。"
        )

    def worker_directive(self, work: WorkItem) -> str:
        """只渲染当前 Work 需要的 Skill 约束，避免注入完整 Runtime 历史。"""

        directives = "\n".join(f"- {item}" for item in self.skill_directives[:4])
        acceptance = "；".join(work.acceptance_criteria[:6]) or "以当前 Work 目标为准"
        return (
            "PROJECT HARNESS:\n"
            f"- {self.compact_summary()}\n"
            f"- 当前验收：{acceptance}\n"
            f"{directives or '- 遵循项目现有组件、样式和工程约束。'}"
        )


def _strings(value: object) -> list[str]:
    """把外部 JSON 数组清洗成去重字符串列表。"""

    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))


__all__ = ["ProjectHarness"]
