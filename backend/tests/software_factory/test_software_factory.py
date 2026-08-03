"""Software Factory 领域、Mock、API 和前端绑定生成测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.agent.loop_protocol import AgentAction, parse_agent_action
from backend.services.agent.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.work_action_handler import (
    WorkActionEnvironment,
    WorkActionHandler,
)
from backend.services.agent.work_state import WorkWorkerState
from backend.services.agent.work_models import WorkItem
from backend.software_factory import SOFTWARE_FACTORY
from backend.software_factory.planning import enrich_software_factory_works


def _create_react_project(root: Path) -> None:
    """创建最小 React 项目标记，供技术栈检测器使用。"""

    (root / "package.json").write_text(
        '{"name":"commerce-demo","dependencies":{"react":"19.0.0"}}',
        "utf-8",
    )
    (root / "src").mkdir()


def _connect_real_page(root: Path, *, include_states: bool = True) -> None:
    """创建一个位于生成目录之外、真实调用统一数据源的商品页面。"""

    page_directory = root / "src/pages"
    page_directory.mkdir(parents=True, exist_ok=True)
    state_code = ""
    if include_states:
        state_code = (
            "const loading = false;\n"
            "const error: Error | null = null;\n"
            "const empty = products.length === 0;\n"
            "void loading;\n"
            "void error;\n"
            "void empty;\n"
        )
    page_code = (
        'import { createCommerceDataSource } from '
        '"../features/commerce/data-source";\n\n'
        'const dataSource = createCommerceDataSource({ mode: "mock", baseUrl: "/api" });\n'
        "const products = await dataSource.listProducts();\n"
    )
    (page_directory / "products.ts").write_text(
        page_code + state_code,
        "utf-8",
    )


def test_factory_generates_consistent_commerce_data_layer(tmp_path: Path) -> None:
    """默认 12 个商品时全部生成文件应不超过 500 行并通过一致性校验。"""

    _create_react_project(tmp_path)
    result = SOFTWARE_FACTORY.generate(
        root=tmp_path,
        request_text="开发电商小程序，设计 Mock 数据、API 并接上商品和购物车页面",
        output_root="src/features/commerce",
        mock_count=12,
    )

    assert result["validation"]["ok"] is True
    changed_files = result["changedFiles"]
    assert "src/features/commerce/domain-schema.json" in changed_files
    assert "src/features/commerce/data-source.ts" in changed_files
    assert "src/features/commerce/mock-repository.ts" in changed_files
    assert "src/features/commerce/database-schema.sql" in changed_files
    assert "src/features/commerce/requirements.md" in changed_files
    assert "CREATE TABLE IF NOT EXISTS products" in (
        tmp_path / "src/features/commerce/database-schema.sql"
    ).read_text("utf-8")

    for relative_path in changed_files:
        line_count = len((tmp_path / relative_path).read_text("utf-8").splitlines())
        assert line_count <= 500, relative_path

    validation_before_binding = SOFTWARE_FACTORY.validate(
        root=tmp_path,
        output_root="src/features/commerce",
    )
    assert validation_before_binding["ok"] is False
    assert any("尚未接入真实页面" in item for item in validation_before_binding["errors"])

    _connect_real_page(tmp_path)
    validation_after_binding = SOFTWARE_FACTORY.validate(
        root=tmp_path,
        output_root="src/features/commerce",
    )
    assert validation_after_binding["ok"] is True
    assert not validation_after_binding["warnings"]


def test_factory_refuses_unreviewed_overwrite_and_reports_drift(tmp_path: Path) -> None:
    """已有文件必须显式允许覆盖，生成后人工修改应被清单识别。"""

    _create_react_project(tmp_path)
    arguments = {
        "root": tmp_path,
        "request_text": "电商 Mock API 接入",
        "output_root": "src/features/commerce",
        "mock_count": 4,
    }
    SOFTWARE_FACTORY.generate(**arguments)

    with pytest.raises(FileExistsError, match="overwrite=true"):
        SOFTWARE_FACTORY.generate(**arguments)

    contracts = tmp_path / "src/features/commerce/contracts.ts"
    contracts.write_text(contracts.read_text("utf-8") + "\n// 人工修改\n", "utf-8")
    _connect_real_page(tmp_path)
    validation = SOFTWARE_FACTORY.validate(
        root=tmp_path,
        output_root="src/features/commerce",
    )
    assert validation["ok"] is True
    assert any("contracts.ts" in item for item in validation["warnings"])


def test_factory_plan_does_not_write_files(tmp_path: Path) -> None:
    """plan 模式只返回蓝图和文件清单，不得提前修改工作区。"""

    _create_react_project(tmp_path)
    result = SOFTWARE_FACTORY.plan(
        root=tmp_path,
        request_text="设计商品 Mock 并接 API",
        output_root="src/features/commerce",
        mock_count=8,
    )

    assert result["validation"]["ok"] is True
    assert result["blueprint"]["frontendStack"] == "react"
    assert not (tmp_path / "src/features/commerce").exists()


def test_planner_enrichment_adds_compact_factory_chain() -> None:
    """电商 Mock 接入请求收敛为契约生成与页面接入校验两个 Work。"""

    works = [WorkItem("W001", "初始化页面", "创建电商小程序页面")]
    enriched = enrich_software_factory_works(
        "开发电商小程序，设计 mock 数据和 API 并接上购物车页面",
        works,
    )
    titles = [item.title for item in enriched]

    assert len(enriched) == 3  # W001 + 契约生成 + 页面接入校验
    assert "建立电商数据契约并生成 Mock 与 OpenAPI 数据源" in titles
    assert "接入电商页面并校验数据闭环" in titles
    contract = next(item for item in enriched if "数据契约" in item.title)
    binding = next(item for item in enriched if "数据闭环" in item.title)
    assert binding.dependencies == [contract.id]


def test_planner_enrichment_skips_page_binding_for_greenfield() -> None:
    """从零构建（空项目）时，不应追加依赖已有页面的“页面接入校验”Work。"""

    works = [WorkItem("W001", "初始化页面", "创建电商小程序页面")]
    enriched = enrich_software_factory_works(
        "开发电商小程序，设计 mock 数据和 API",
        works,
        greenfield=True,
    )
    titles = [item.title for item in enriched]

    assert len(enriched) == 2
    assert "接入电商页面并校验数据闭环" not in titles
    assert "建立电商数据契约并生成 Mock 与 OpenAPI 数据源" in titles


def test_planner_generated_mock_audit_work_is_not_duplicated() -> None:
    """Planner 已生成 mock/契约审计 Work 时，不应再追加重复的契约生成项。"""

    works = [
        WorkItem(
            "W001",
            "审查并补齐 Mock 数据与 Data Source 契约",
            "审计 mock 数据与 data source 契约一致性，补齐缺失字段并校验通过",
        )
    ]

    enriched = enrich_software_factory_works(
        "开发电商小程序，设计 mock 数据和 API 并接上购物车页面",
        works,
    )

    titles = [item.title for item in enriched]
    assert "建立电商数据契约并生成 Mock 与 OpenAPI 数据源" not in titles
    assert len(enriched) <= 2


def test_factory_action_protocol_parses_all_high_level_fields() -> None:
    """Code Agent 单动作协议应严格解析 Software Factory 参数。"""

    action = parse_agent_action(
        """{
          "action": "factory",
          "workId": "SF002",
          "mode": "generate",
          "domainId": "commerce-miniapp",
          "outputRoot": "src/features/commerce",
          "mockCount": 18,
          "overwrite": true
        }"""
    )

    assert action.action == "factory"
    assert action.factory_mode == "generate"
    assert action.factory_output_root == "src/features/commerce"
    assert action.factory_mock_count == 18
    assert action.factory_overwrite is True


def test_factory_warns_when_page_state_handling_is_incomplete(tmp_path: Path) -> None:
    """真实页面已接入但缺少异步状态时应通过结构校验并给出明确警告。"""

    _create_react_project(tmp_path)
    SOFTWARE_FACTORY.generate(
        root=tmp_path,
        request_text="电商 Mock API 接入",
        output_root="src/features/commerce",
        mock_count=4,
    )
    _connect_real_page(tmp_path, include_states=False)

    validation = SOFTWARE_FACTORY.validate(
        root=tmp_path,
        output_root="src/features/commerce",
    )

    assert validation["ok"] is True
    assert any("页面状态" in item for item in validation["warnings"])


@pytest.mark.asyncio
async def test_validation_work_cannot_complete_without_successful_factory_check(
    tmp_path: Path,
) -> None:
    """最终验收 Work 必须存在真实成功的 factory validate 结果。"""

    async def emit(_: str, __: dict[str, object]) -> None:
        """测试中忽略生命周期事件。"""

    async def checkpoint() -> None:
        """测试中使用空 Checkpoint 回调。"""

    state = WorkWorkerState()
    work = WorkItem(
        "SF004",
        "验证契约、Mock 与页面数据闭环",
        "调用 factory validate 并执行项目质量命令",
        acceptance_criteria=["Software Factory 一致性校验通过"],
    )
    handler = WorkActionHandler(
        WorkActionEnvironment(
            root=tmp_path,
            request_text="开发电商小程序并接入 Mock 数据",
            work=work,
            state=state,
            execution_mode="full_auto",
            coordinator=WorkspaceResourceCoordinator(),
            emit=emit,
            checkpoint=checkpoint,
            slot=1,
            agent_id="test-worker",
        )
    )

    rejected = await handler.execute(
        AgentAction("complete_work", work_id="SF004", summary="已完成")
    )
    assert rejected.kind == "continue"
    assert any("COMPLETE REJECTED" in item for item in state.transcript)

    state.factory_validations["src/features/commerce"] = True
    accepted = await handler.execute(
        AgentAction("complete_work", work_id="SF004", summary="已完成")
    )
    assert accepted.kind == "success"


@pytest.mark.asyncio
async def test_page_work_with_data_loop_acceptance_can_complete(tmp_path) -> None:
    """页面类 Work 的验收文案提到“数据闭环”不应被误判为工厂最终验收。"""

    async def emit(_: str, __: dict[str, object]) -> None:
        """测试中忽略生命周期事件。"""

    async def checkpoint() -> None:
        """测试中使用空 Checkpoint 回调。"""

    state = WorkWorkerState()
    work = WorkItem(
        "W003",
        "购物车页开发",
        "开发购物车页面",
        acceptance_criteria=["页面数据闭环与统一契约一致"],
    )
    handler = WorkActionHandler(
        WorkActionEnvironment(
            root=tmp_path,
            request_text="开发购物车页面",
            work=work,
            state=state,
            execution_mode="auto_edit",
            coordinator=WorkspaceResourceCoordinator(),
            emit=emit,
            checkpoint=checkpoint,
            slot=1,
            agent_id="test-worker",
        )
    )

    accepted = await handler.execute(
        AgentAction("complete_work", work_id="W003", summary="页面已写入")
    )

    assert accepted.kind == "success"
    assert not any("COMPLETE REJECTED" in item for item in state.transcript)


def test_factory_validation_state_survives_checkpoint_round_trip() -> None:
    """Factory 最终验收状态必须能够随 Worker Checkpoint 保存和恢复。"""

    state = WorkWorkerState(
        factory_validations={"src/features/commerce": True},
    )

    restored = WorkWorkerState.from_json(state.to_json())

    assert restored.factory_validations == {"src/features/commerce": True}
