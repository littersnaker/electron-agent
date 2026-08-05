"""复盘结果的 SQLite 持久化：去重、容量、淘汰与审批门。"""

from __future__ import annotations

import hashlib
import logging
from typing import Any
from uuid import uuid4

from backend.memory.semantic import SemanticMemoryStore
from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    rebuild_memory_fts,
    utc_now_iso,
)

LOGGER = logging.getLogger(__name__)

MAX_SEMANTIC_ENTRIES_PER_SCOPE = 200


def digest_hash(value: str) -> str:
    """生成复盘材料的稳定去重指纹。"""

    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()[:32]


async def record_review_artifact(
    *,
    work_id: str,
    agent_kind: str,
    scope_id: str,
    model: str,
    digest_hash_value: str,
    output: dict[str, Any],
    status: str = "pending",
    error_message: str = "",
) -> str:
    """写入一条复盘产物；返回 artifact id。"""

    identifier = f"rev_{uuid4().hex}"
    now = utc_now_iso()
    async with open_database() as connection:
        await connection.execute(
            """
            INSERT INTO review_artifacts(
                id, work_id, agent_kind, scope_id, model, status,
                digest_hash, output_json, error_message,
                created_at, updated_at, reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                identifier,
                work_id,
                agent_kind,
                scope_id,
                model,
                status,
                digest_hash_value,
                dumps_json(output),
                error_message,
                now,
                now,
                now if status in {"approved", "rejected", "discarded"} else None,
            ),
        )
    return identifier


async def find_duplicate_review(
    *,
    work_id: str,
    digest_hash_value: str,
) -> dict[str, Any] | None:
    """同 Work 相同指纹的复盘已处理过则跳过，避免重复沉淀。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT * FROM review_artifacts
            WHERE work_id = ? AND digest_hash = ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (work_id, digest_hash_value),
        )
        row = await cursor.fetchone()
    if not row:
        return None
    return {"id": str(row["id"]), "status": str(row["status"])}


async def list_review_artifacts(
    *,
    status: str | None = None,
    agent_kind: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """列出复盘产物（默认 pending，供审批门使用）。"""

    clauses: list[str] = []
    parameters: list[object] = []
    if status:
        clauses.append("status = ?")
        parameters.append(status)
    if agent_kind:
        clauses.append("agent_kind = ?")
        parameters.append(agent_kind)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    parameters.append(max(1, min(limit, 200)))
    async with open_database() as connection:
        cursor = await connection.execute(
            f"""
            SELECT * FROM review_artifacts
            {where}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            tuple(parameters),
        )
        rows = await cursor.fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        output = loads_json(str(row["output_json"]), {})
        result.append(
            {
                "id": str(row["id"]),
                "workId": str(row["work_id"]),
                "agentKind": str(row["agent_kind"]),
                "scopeId": str(row["scope_id"]),
                "model": str(row["model"]),
                "status": str(row["status"]),
                "output": output if isinstance(output, dict) else {},
                "errorMessage": str(row["error_message"]),
                "createdAt": str(row["created_at"]),
                "reviewedAt": str(row["reviewed_at"]) if row["reviewed_at"] else None,
            }
        )
    return result


async def get_review_artifact(artifact_id: str) -> dict[str, Any] | None:
    """按 id 读取单条复盘产物。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT * FROM review_artifacts WHERE id = ?",
            (artifact_id,),
        )
        row = await cursor.fetchone()
    if not row:
        return None
    output = loads_json(str(row["output_json"]), {})
    return {
        "id": str(row["id"]),
        "workId": str(row["work_id"]),
        "agentKind": str(row["agent_kind"]),
        "scopeId": str(row["scope_id"]),
        "model": str(row["model"]),
        "status": str(row["status"]),
        "output": output if isinstance(output, dict) else {},
        "errorMessage": str(row["error_message"]),
        "createdAt": str(row["created_at"]),
        "reviewedAt": str(row["reviewed_at"]) if row["reviewed_at"] else None,
    }


async def update_review_artifact_status(artifact_id: str, status: str) -> bool:
    """审批/驳回复盘产物。"""

    now = utc_now_iso()
    async with open_database() as connection:
        cursor = await connection.execute(
            """
            UPDATE review_artifacts
            SET status = ?, updated_at = ?, reviewed_at = ?
            WHERE id = ?
            """,
            (status, now, now, artifact_id),
        )
    return cursor.rowcount > 0


async def write_semantic_knowledge(
    *,
    scope_id: str,
    kind: str,
    content: str,
    work_id: str,
    confidence: str,
    trigger: str = "",
) -> bool:
    """写入一条 semantic 记忆（fact/lesson）；内容完全重复时跳过。"""

    store = SemanticMemoryStore()
    existing = await store.search(
        query=content[:200],
        scope_ids=(scope_id,),
        top_k=5,
    )
    normalized = content.strip()
    for record in existing:
        if record.content.strip() == normalized:
            return False
    await store.save(
        scope_id=scope_id,
        content=normalized,
        metadata={
            "kind": kind,
            "sourceWork": work_id,
            "confidence": confidence,
            "trigger": trigger,
        },
    )
    return True


async def enforce_semantic_capacity(scope_id: str) -> None:
    """容量管理：超出上限时淘汰最旧的 semantic 记忆（自动遗忘）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT id FROM agent_memories
            WHERE memory_type = 'semantic' AND scope_id = ?
            ORDER BY updated_at DESC
            """,
            (scope_id,),
        )
        rows = await cursor.fetchall()
    if len(rows) <= MAX_SEMANTIC_ENTRIES_PER_SCOPE:
        return
    overflow = rows[MAX_SEMANTIC_ENTRIES_PER_SCOPE:]
    async with open_database() as connection:
        for row in overflow:
            await connection.execute(
                "DELETE FROM agent_memories WHERE id = ? AND memory_type = 'semantic'",
                (str(row["id"]),),
            )
    try:
        await rebuild_memory_fts()
    except Exception:
        LOGGER.warning("容量淘汰后 FTS 索引重建失败")
    LOGGER.info(
        "复盘容量淘汰：scope=%s 淘汰 %s 条最旧 semantic 记忆",
        scope_id,
        len(overflow),
    )
