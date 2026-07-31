"""FastAPI 迁移版核心功能冒烟测试。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.core.config import get_settings
from backend.main import app
from backend.services.agent.classifier import classify_request
from backend.services.commerce.analytics import calculate_metrics, resolve_category


def _read_sse_packets(raw_text: str) -> list[dict[str, object]]:
    """把测试响应中的 SSE ``data:`` 行解析成字典列表。"""

    packets: list[dict[str, object]] = []
    for line in raw_text.splitlines():
        if line.startswith("data:"):
            packets.append(json.loads(line[5:].strip()))
    return packets


def test_request_classifier() -> None:
    """验证 Code Agent 能区分只读问题和文件修改请求。"""

    assert classify_request("解释一下这个项目的入口") == "read_only"
    assert classify_request("请修改 main.py 并增加日志") == "code_change"


def test_commerce_analytics_is_deterministic() -> None:
    """验证市场指标使用确定性代码计算，而不是随机模型输出。"""

    category = resolve_category("portable espresso maker for camping")
    observations = [
        {
            "price": 29.9,
            "reviewCount": 120,
            "rating": 4.5,
            "domain": "example.com",
            "resultType": "shopping",
        },
        {
            "price": 39.9,
            "reviewCount": 80,
            "rating": 4.2,
            "domain": "shop.example",
            "resultType": "shopping",
        },
    ]
    first = calculate_metrics(observations, [], "USD")
    second = calculate_metrics(observations, [], "USD")
    assert category["keywords"]
    assert first == second
    assert first["medianPrice"] == 34.9


def test_fastapi_workspace_and_commerce(tmp_path: Path, monkeypatch) -> None:
    """验证健康检查、工作区、索引和 Commerce SSE 的完整最短路径。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("FRONTEND_DIR", raising=False)
    # 设置为空字符串可阻止 dotenv 再次从 .env.local 恢复真实密钥，
    # 从而保证冒烟测试完全离线、稳定且不会产生外部 API 费用。
    monkeypatch.setenv("TALORDATA_API_TOKEN", "")
    monkeypatch.setenv("SERPAPI_API_KEY", "")
    get_settings.cache_clear()
    project_root = tmp_path / "demo-project"
    project_root.mkdir()
    (project_root / "hello.py").write_text("def hello():\n    return 'world'\n", "utf-8")

    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True

        created = client.post(
            "/api/workspace",
            json={"action": "createProject", "rootPath": str(project_root)},
        )
        assert created.status_code == 200
        project_id = created.json()["project"]["id"]

        indexed = client.post(f"/api/projects/{project_id}/index")
        assert indexed.status_code == 200
        assert indexed.json()["indexedFileCount"] == 1

        mcp_status = client.get("/api/mcp/status", params={"projectId": project_id})
        assert mcp_status.status_code == 200
        assert mcp_status.json()["projectId"] == project_id

        blocked_download = client.get(
            "/api/media/download",
            params={"url": "http://127.0.0.1:9999/private"},
        )
        assert blocked_download.status_code == 400

        listing = client.post(
            "/api/commerce/listing",
            json={"query": "compact travel kettle", "marketplace": "US"},
        )
        listing_packets = _read_sse_packets(listing.text)
        assert any(packet.get("type") == "COMMERCE_LISTING" for packet in listing_packets)

        research = client.post(
            "/api/commerce/research",
            json={"query": "compact travel kettle", "marketplace": "US"},
        )
        research_packets = _read_sse_packets(research.text)
        report_packet = next(
            packet for packet in research_packets if packet.get("type") == "COMMERCE_REPORT"
        )
        assert report_packet["payload"]["runMode"] == "demo"  # type: ignore[index]
