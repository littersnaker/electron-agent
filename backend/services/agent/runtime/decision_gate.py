"""代码修改前的 Decision Gate。

Gate 只检查可审计条件是否完整，不要求模型泄露内部思维过程；通过后才允许进入
事务式工作区写入工具。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

from backend.services.agent.loop_protocol import EditOperation
from backend.services.agent.runtime.reasoning_state import ReasoningState
from backend.services.agent.work_models import WorkItem
from backend.utils.sensitive_paths import is_sensitive_workspace_path


@dataclass(slots=True)
class DecisionGateResult:
    """保存修改决策是否获批及对应验证、影响和恢复方案。"""

    approved: bool
    reason: str
    validation: list[str] = field(default_factory=list)
    affected_modules: list[str] = field(default_factory=list)
    recovery: str = ""

    def to_json(self) -> dict[str, Any]:
        """转换为前端、Trace 和 Checkpoint 可共用的 JSON。"""

        return {
            "approved": self.approved,
            "reason": self.reason,
            "validation": list(self.validation),
            "affectedModules": list(self.affected_modules),
            "recovery": self.recovery,
        }


class DecisionGate:
    """在 edit 动作执行前检查五项必要工程判断。"""

    def evaluate(
        self,
        *,
        work: WorkItem,
        operations: list[EditOperation],
        reasoning: ReasoningState,
        validation_commands: list[str] | None = None,
    ) -> DecisionGateResult:
        """检查修改目的、影响、验证与恢复信息是否足够。"""

        if not operations:
            return DecisionGateResult(False, "没有可执行的编辑操作")

        paths = [operation.path.strip().replace("\\", "/") for operation in operations]
        if any(not path for path in paths):
            return DecisionGateResult(False, "编辑操作存在空路径")
        if any(is_sensitive_workspace_path(path) for path in paths):
            return DecisionGateResult(False, "编辑目标包含敏感配置或密钥文件")
        if any(not operation.reason.strip() for operation in operations):
            return DecisionGateResult(False, "每个编辑操作都必须说明修改原因")
        if not work.objective.strip():
            return DecisionGateResult(False, "当前 Work 缺少明确目标")

        affected = list(dict.fromkeys(self._module_name(path) for path in paths))
        validations = list(dict.fromkeys(validation_commands or work.commands))
        if not validations:
            validations = [
                criterion.strip()
                for criterion in work.acceptance_criteria
                if criterion.strip()
            ]
        if not validations:
            validations = ["至少执行语法、Lint 或相关测试检查"]

        reason = (
            f"修改用于完成“{work.objective[:300]}”，涉及 {len(paths)} 个文件、"
            f"{len(affected)} 个模块；写入由事务工具和文件版本指纹保护。"
        )
        reasoning.record_decision(
            decision=f"批准修改 {', '.join(paths[:6])}",
            reason=reason,
            evidence="；".join(operation.reason[:200] for operation in operations[:6]),
        )
        reasoning.set_next_action("应用修改后立即检查真实 diff，并执行对应验证。")
        return DecisionGateResult(
            approved=True,
            reason=reason,
            validation=validations[:20],
            affected_modules=affected,
            recovery="若写入或验证失败，事务工具回滚本批次；并重新读取最新文件后重规划。",
        )

    def _module_name(self, path: str) -> str:
        """从相对文件路径提取稳定的模块范围名称。"""

        parts = PurePosixPath(path).parts
        return "/".join(parts[:2]) if len(parts) >= 2 else path


__all__ = ["DecisionGate", "DecisionGateResult"]
