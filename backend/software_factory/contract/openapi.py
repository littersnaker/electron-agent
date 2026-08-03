"""从领域蓝图生成 OpenAPI 3.1 文档。"""

from __future__ import annotations

from typing import Any

from backend.software_factory.contracts import EndpointSpec, EntitySpec, FactoryBlueprint, FieldSpec


def build_openapi_document(blueprint: FactoryBlueprint) -> dict[str, Any]:
    """生成前端、Mock 服务和未来后端共同使用的 OpenAPI 文档。"""

    schemas = {
        entity.name: _entity_schema(entity)
        for entity in blueprint.entities
    }
    paths: dict[str, dict[str, Any]] = {}
    for endpoint in blueprint.endpoints:
        path_item = paths.setdefault(endpoint.path, {})
        path_item[endpoint.method.lower()] = _operation(endpoint)

    return {
        "openapi": "3.1.0",
        "info": {
            "title": f"{blueprint.project_name} Commerce API",
            "version": "1.0.0",
            "description": "由 Software Factory 生成的电商小程序 API 契约。",
        },
        "servers": [{"url": "/api", "description": "应用 API 根地址"}],
        "paths": paths,
        "components": {"schemas": schemas},
    }


def _entity_schema(entity: EntitySpec) -> dict[str, Any]:
    """把领域实体转换成 OpenAPI object schema。"""

    properties = {field.name: _field_schema(field) for field in entity.fields}
    required = [field.name for field in entity.fields if field.required]
    schema: dict[str, Any] = {
        "type": "object",
        "description": entity.description,
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


def _field_schema(field: FieldSpec) -> dict[str, Any]:
    """把内部字段类型映射成 OpenAPI 基础类型。"""

    mapping: dict[str, dict[str, Any]] = {
        "string": {"type": "string"},
        "integer": {"type": "integer"},
        "number": {"type": "number"},
        "boolean": {"type": "boolean"},
        "datetime": {"type": "string", "format": "date-time"},
        "string_array": {"type": "array", "items": {"type": "string"}},
    }
    schema = dict(mapping[field.field_type])
    schema["description"] = field.description
    if field.example is not None:
        schema["example"] = field.example
    if field.enum_values:
        schema["enum"] = list(field.enum_values)
    return schema


def _operation(endpoint: EndpointSpec) -> dict[str, Any]:
    """生成单个 HTTP 操作，并自动补充路径参数和请求体。"""

    operation: dict[str, Any] = {
        "operationId": endpoint.operation_id,
        "summary": endpoint.summary,
        "responses": {
            "200": {
                "description": "操作成功",
                "content": {
                    "application/json": {
                        "schema": _response_schema(endpoint),
                    }
                },
            }
        },
    }

    path_parameters = _path_parameters(endpoint.path)
    if path_parameters:
        operation["parameters"] = path_parameters
    if endpoint.request_entity:
        operation["requestBody"] = {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {"$ref": f"#/components/schemas/{endpoint.request_entity}"}
                }
            },
        }
    return operation


def _response_schema(endpoint: EndpointSpec) -> dict[str, Any]:
    """根据接口是否返回集合生成响应 schema。"""

    reference = {"$ref": f"#/components/schemas/{endpoint.response_entity}"}
    if endpoint.collection_response:
        return {"type": "array", "items": reference}
    return reference


def _path_parameters(path: str) -> list[dict[str, Any]]:
    """从 ``{parameter}`` 片段提取必填路径参数。"""

    parameters: list[dict[str, Any]] = []
    for segment in path.split("/"):
        if segment.startswith("{") and segment.endswith("}"):
            name = segment[1:-1]
            parameters.append(
                {
                    "name": name,
                    "in": "path",
                    "required": True,
                    "schema": {"type": "string"},
                }
            )
    return parameters
