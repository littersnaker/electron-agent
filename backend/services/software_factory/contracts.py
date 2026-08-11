"""Software Factory 各阶段共享的数据契约。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

FieldType = Literal[
    "string",
    "integer",
    "number",
    "boolean",
    "datetime",
    "string_array",
]
HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
ArtifactKind = Literal["domain", "contract", "mock", "frontend", "document", "manifest"]


@dataclass(frozen=True, slots=True)
class FieldSpec:
    """描述一个领域实体字段及其生成约束。"""

    name: str
    field_type: FieldType
    description: str
    required: bool = True
    example: Any = None
    enum_values: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        """转换成可写入领域契约文件的稳定 JSON。"""

        return {
            "name": self.name,
            "type": self.field_type,
            "description": self.description,
            "required": self.required,
            "example": self.example,
            "enum": list(self.enum_values),
        }


@dataclass(frozen=True, slots=True)
class EntitySpec:
    """描述一个可被 Mock、OpenAPI 和前端类型共同使用的领域实体。"""

    name: str
    description: str
    fields: tuple[FieldSpec, ...]

    def to_json(self) -> dict[str, Any]:
        """转换成领域契约 JSON。"""

        return {
            "name": self.name,
            "description": self.description,
            "fields": [field.to_json() for field in self.fields],
        }


@dataclass(frozen=True, slots=True)
class EndpointSpec:
    """描述一个前后端共享的 HTTP API 契约。"""

    method: HttpMethod
    path: str
    operation_id: str
    summary: str
    response_entity: str
    request_entity: str = ""
    collection_response: bool = False

    def to_json(self) -> dict[str, Any]:
        """转换成便于诊断和测试的字典。"""

        return {
            "method": self.method,
            "path": self.path,
            "operationId": self.operation_id,
            "summary": self.summary,
            "requestEntity": self.request_entity,
            "responseEntity": self.response_entity,
            "collectionResponse": self.collection_response,
        }


@dataclass(frozen=True, slots=True)
class FactoryBlueprint:
    """保存一次 Software Factory 的完整单一事实源。"""

    domain_id: str
    project_name: str
    request_text: str
    frontend_stack: str
    source_root: str
    output_root: str
    mock_count: int
    entities: tuple[EntitySpec, ...]
    endpoints: tuple[EndpointSpec, ...]
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        """转换成可序列化的领域蓝图。"""

        return {
            "version": 1,
            "domainId": self.domain_id,
            "projectName": self.project_name,
            "requestText": self.request_text,
            "frontendStack": self.frontend_stack,
            "sourceRoot": self.source_root,
            "outputRoot": self.output_root,
            "mockCount": self.mock_count,
            "entities": [entity.to_json() for entity in self.entities],
            "endpoints": [endpoint.to_json() for endpoint in self.endpoints],
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True, slots=True)
class GeneratedArtifact:
    """保存一个待写入工作区的生成文件。"""

    path: str
    content: str
    kind: ArtifactKind
    description: str

    def to_json(self, *, include_content: bool = False) -> dict[str, Any]:
        """按调用方需要返回文件摘要或完整内容。"""

        result: dict[str, Any] = {
            "path": self.path,
            "kind": self.kind,
            "description": self.description,
            "lineCount": len(self.content.splitlines()),
            "characterCount": len(self.content),
        }
        if include_content:
            result["content"] = self.content
        return result


@dataclass(frozen=True, slots=True)
class FactoryValidation:
    """保存 Software Factory 一致性校验结果。"""

    ok: bool
    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    checks: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        """转换成工具观察和测试可使用的 JSON。"""

        return {
            "ok": self.ok,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "checks": list(self.checks),
        }
