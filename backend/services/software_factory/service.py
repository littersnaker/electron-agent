"""Software Factory 的计划、生成和工作区校验服务。"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from backend.services.software_factory.artifacts import build_artifacts
from backend.services.software_factory.contracts import FactoryBlueprint, FactoryValidation
from backend.services.software_factory.domain import build_commerce_blueprint
from backend.services.software_factory.frontend import detect_frontend_profile
from backend.services.software_factory.validation import (
    validate_factory_artifacts,
    validate_workspace_integration,
)
from backend.utils.paths import resolve_inside

SUPPORTED_DOMAINS = {"commerce", "ecommerce", "commerce-miniapp"}


class SoftwareFactoryService:
    """以单一事实源生成领域、Mock、API 契约和前端数据层。"""

    def plan(
        self,
        *,
        root: Path,
        request_text: str,
        domain_id: str = "commerce-miniapp",
        output_root: str = "",
        mock_count: int = 12,
    ) -> dict[str, Any]:
        """分析项目技术栈并返回不写文件的生成计划。"""

        blueprint = self._build_blueprint(
            root=root,
            request_text=request_text,
            domain_id=domain_id,
            output_root=output_root,
            mock_count=mock_count,
        )
        mock_payload, artifacts = build_artifacts(blueprint)
        validation = validate_factory_artifacts(blueprint, mock_payload, artifacts)
        return {
            "blueprint": blueprint.to_json(),
            "artifacts": [artifact.to_json() for artifact in artifacts],
            "validation": validation.to_json(),
            "nextActions": [
                "确认生成目录不会覆盖已有业务实现",
                "调用 software_factory.generate 生成数据层",
                "读取真实页面并注入 createCommerceDataSource",
                "删除页面硬编码数组并补齐 loading/error/empty 状态",
                "调用 software_factory.validate 后运行项目质量命令",
            ],
        }

    def generate(
        self,
        *,
        root: Path,
        request_text: str,
        domain_id: str = "commerce-miniapp",
        output_root: str = "",
        mock_count: int = 12,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        """校验全部内容后事务式写入 Software Factory 生成文件。"""

        blueprint = self._build_blueprint(
            root=root,
            request_text=request_text,
            domain_id=domain_id,
            output_root=output_root,
            mock_count=mock_count,
        )
        mock_payload, artifacts = build_artifacts(blueprint)
        validation = validate_factory_artifacts(blueprint, mock_payload, artifacts)
        if not validation.ok:
            raise ValueError(
                "Software Factory 生成前校验失败：" + "；".join(validation.errors)
            )

        targets = [(resolve_inside(root, item.path), item.content) for item in artifacts]
        existing = [str(path.relative_to(root.resolve())) for path, _ in targets if path.exists()]
        if existing and not overwrite:
            raise FileExistsError(
                "生成目标已存在，请先读取确认后再设置 overwrite=true："
                + ", ".join(existing[:20])
            )

        self._transactional_write(targets)
        return {
            "changedFiles": [item.path for item in artifacts],
            "blueprint": blueprint.to_json(),
            "validation": validation.to_json(),
            "message": (
                "已生成领域契约、Mock、API Client 和可切换数据源。"
                "仍需由 Code Agent 读取真实页面完成最终注入。"
            ),
        }

    def validate(
        self,
        *,
        root: Path,
        output_root: str,
    ) -> dict[str, Any]:
        """根据生成清单检查文件缺失、内容漂移和基础契约一致性。"""

        normalized_root = self._normalize_output_root(output_root)
        manifest_path = resolve_inside(
            root,
            f"{normalized_root}/software-factory.manifest.json",
        )
        if not manifest_path.is_file():
            return FactoryValidation(
                False,
                errors=(f"找不到生成清单：{manifest_path.relative_to(root.resolve())}",),
            ).to_json()

        try:
            manifest = json.loads(manifest_path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return FactoryValidation(
                False,
                errors=(f"生成清单无法读取：{exc}",),
            ).to_json()

        errors: list[str] = []
        warnings: list[str] = []
        checks: list[str] = []
        files = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(files, list):
            return FactoryValidation(False, errors=("生成清单缺少 files 数组",)).to_json()

        for item in files:
            if not isinstance(item, dict):
                errors.append("生成清单包含无效文件记录")
                continue
            relative_path = str(item.get("path") or "")
            expected_hash = str(item.get("sha256") or "")
            try:
                target = resolve_inside(root, relative_path)
            except ValueError as exc:
                errors.append(str(exc))
                continue
            if not target.is_file():
                errors.append(f"生成文件缺失：{relative_path}")
                continue
            content = target.read_bytes()
            actual_hash = hashlib.sha256(content).hexdigest()
            if actual_hash != expected_hash:
                warnings.append(f"生成后文件已被修改：{relative_path}")

        checks.append("生成清单文件存在性与 SHA-256 漂移检查")
        domain = self._validate_json_relationships(
            root,
            normalized_root,
            errors,
            checks,
        )
        if domain is not None:
            integration = validate_workspace_integration(
                root=root,
                source_root=str(domain.get("sourceRoot") or "."),
                output_root=normalized_root,
            )
            errors.extend(integration.errors)
            warnings.extend(integration.warnings)
            checks.extend(integration.checks)
        return FactoryValidation(
            ok=not errors,
            errors=tuple(errors),
            warnings=tuple(warnings),
            checks=tuple(checks),
        ).to_json()

    def _build_blueprint(
        self,
        *,
        root: Path,
        request_text: str,
        domain_id: str,
        output_root: str,
        mock_count: int,
    ) -> FactoryBlueprint:
        """验证领域类型、检测技术栈并构建电商蓝图。"""

        normalized_domain = domain_id.strip().lower()
        if normalized_domain not in SUPPORTED_DOMAINS:
            raise ValueError(
                f"暂不支持领域 {domain_id}；当前支持 commerce-miniapp"
            )
        profile = detect_frontend_profile(root)
        normalized_output = self._normalize_output_root(
            output_root or self._default_output_root(profile.source_root)
        )
        return build_commerce_blueprint(
            request_text=request_text,
            profile=profile,
            output_root=normalized_output,
            mock_count=mock_count,
        )

    def _default_output_root(self, source_root: str) -> str:
        """根据源码根目录返回不侵入页面结构的默认 feature 目录。"""

        prefix = source_root.strip("./")
        return f"{prefix}/features/commerce" if prefix else "features/commerce"

    def _normalize_output_root(self, output_root: str) -> str:
        """规范化相对目录并拒绝空目录、绝对路径和上级跳转。"""

        normalized = output_root.replace("\\", "/").strip().strip("/")
        if not normalized or normalized == ".":
            raise ValueError("Software Factory outputRoot 不能为空")
        parts = [part for part in normalized.split("/") if part and part != "."]
        if any(part == ".." for part in parts):
            raise ValueError("Software Factory outputRoot 不能包含 ..")
        return "/".join(parts)

    def _transactional_write(self, targets: list[tuple[Path, str]]) -> None:
        """使用临时文件和备份内容实现可回滚的批量写入。"""

        backups: dict[Path, bytes | None] = {}
        temporary_files: list[Path] = []
        try:
            for target, content in targets:
                backups[target] = target.read_bytes() if target.is_file() else None
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(f".{target.name}.software-factory.tmp")
                temporary.write_text(content, encoding="utf-8", newline="")
                temporary_files.append(temporary)

            # 所有临时文件写入成功后再逐个原子替换，最大限度降低半成品概率。
            for (target, _), temporary in zip(targets, temporary_files, strict=True):
                os.replace(temporary, target)
        except Exception:
            for temporary in temporary_files:
                temporary.unlink(missing_ok=True)
            for target, original in backups.items():
                if original is None:
                    target.unlink(missing_ok=True)
                else:
                    target.write_bytes(original)
            raise

    def _validate_json_relationships(
        self,
        root: Path,
        output_root: str,
        errors: list[str],
        checks: list[str],
    ) -> dict[str, Any] | None:
        """读取领域、OpenAPI 和 Mock JSON，检查核心集合与 schema 对齐。"""

        try:
            domain = json.loads(
                resolve_inside(root, f"{output_root}/domain-schema.json").read_text("utf-8")
            )
            openapi = json.loads(
                resolve_inside(root, f"{output_root}/openapi.json").read_text("utf-8")
            )
            mock = json.loads(
                resolve_inside(root, f"{output_root}/mock-data.json").read_text("utf-8")
            )
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"领域、OpenAPI 或 Mock JSON 无法读取：{exc}")
            return None

        entity_names = {
            str(item.get("name"))
            for item in domain.get("entities", [])
            if isinstance(item, dict)
        }
        schema_names = set(
            dict(dict(openapi.get("components") or {}).get("schemas") or {})
        )
        if entity_names != schema_names:
            errors.append("domain-schema.json 与 openapi.json 的实体集合不一致")
        for key in ("products", "skus", "cartItems", "orders"):
            if not isinstance(mock.get(key), list):
                errors.append(f"mock-data.json 缺少数组 {key}")
        checks.append("领域 schema、OpenAPI components 与 Mock 核心集合一致性")
        return domain if isinstance(domain, dict) else None


SOFTWARE_FACTORY = SoftwareFactoryService()
