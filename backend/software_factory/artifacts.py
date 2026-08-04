"""把 Software Factory 蓝图转换成一组可写入文件。"""

from __future__ import annotations

import hashlib
import json

from backend.software_factory.contract import (
    build_openapi_document,
    render_database_schema,
)
from backend.software_factory.contracts import FactoryBlueprint, GeneratedArtifact
from backend.software_factory.documents import render_requirements_document
from backend.software_factory.frontend import (
    render_api_client,
    render_contracts,
    render_data_source,
    render_integration_guide,
    render_mock_data,
    render_mock_repository,
)
from backend.software_factory.mock import generate_mock_payload


def build_artifacts(
    blueprint: FactoryBlueprint,
) -> tuple[dict[str, object], tuple[GeneratedArtifact, ...]]:
    """生成领域、API、Mock、前端绑定、文档和清单文件。"""

    mock_payload = generate_mock_payload(blueprint)
    output_root = blueprint.output_root.rstrip("/")
    artifacts = [
        GeneratedArtifact(
            f"{output_root}/domain-schema.json",
            _json_text(blueprint.to_json(), compact=True),
            "domain",
            "领域实体与 API 的单一事实源",
        ),
        GeneratedArtifact(
            f"{output_root}/openapi.json",
            _json_text(build_openapi_document(blueprint), compact=True),
            "contract",
            "OpenAPI 3.1 前后端契约",
        ),
        GeneratedArtifact(
            f"{output_root}/database-schema.sql",
            render_database_schema(blueprint),
            "contract",
            "由领域模型派生的 SQLite 数据库 DDL",
        ),
        GeneratedArtifact(
            f"{output_root}/requirements.md",
            render_requirements_document(blueprint),
            "document",
            "产品、前端、后端和测试共享的需求基线",
        ),
        GeneratedArtifact(
            f"{output_root}/mock-data.json",
            _json_text(mock_payload, compact=True),
            "mock",
            "可用于测试和调试的标准 Mock JSON",
        ),
        GeneratedArtifact(
            f"{output_root}/contracts.ts",
            render_contracts(blueprint),
            "frontend",
            "由领域模型生成的 TypeScript 类型",
        ),
        GeneratedArtifact(
            f"{output_root}/mock-data.ts",
            render_mock_data(mock_payload),
            "frontend",
            "前端可直接导入的只读 Mock 数据",
        ),
        GeneratedArtifact(
            f"{output_root}/api-client.ts",
            render_api_client(blueprint),
            "frontend",
            "真实 API 客户端",
        ),
        GeneratedArtifact(
            f"{output_root}/mock-repository.ts",
            render_mock_repository(blueprint),
            "frontend",
            "具有购物车和订单状态的内存 Mock Repository",
        ),
        GeneratedArtifact(
            f"{output_root}/data-source.ts",
            render_data_source(),
            "frontend",
            "Mock 与真实 API 可切换的数据源入口",
        ),
        GeneratedArtifact(
            f"{output_root}/README.md",
            render_integration_guide(blueprint),
            "document",
            "页面接入和联调说明",
        ),
    ]
    manifest = _manifest(blueprint, artifacts)
    artifacts.append(
        GeneratedArtifact(
            f"{output_root}/software-factory.manifest.json",
            _json_text(manifest),
            "manifest",
            "生成版本、文件哈希和后续校验依据",
        )
    )
    return mock_payload, tuple(artifacts)


def _manifest(
    blueprint: FactoryBlueprint,
    artifacts: list[GeneratedArtifact],
) -> dict[str, object]:
    """为非清单文件生成 SHA-256 摘要。"""

    return {
        "version": 1,
        "domainId": blueprint.domain_id,
        "frontendStack": blueprint.frontend_stack,
        "outputRoot": blueprint.output_root,
        "files": [
            {
                "path": artifact.path,
                "kind": artifact.kind,
                "sha256": hashlib.sha256(artifact.content.encode("utf-8")).hexdigest(),
                "lineCount": len(artifact.content.splitlines()),
            }
            for artifact in artifacts
        ],
    }


def _json_text(value: object, *, compact: bool = False) -> str:
    """把对象编码成稳定 UTF-8 JSON；大型机器文件使用紧凑格式控制行数。"""

    if compact:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=False,
        ) + "\n"
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
