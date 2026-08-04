"""Artifact Memory 模块测试。"""

from backend.services.artifact_memory import (
    ArtifactMemory,
    ArtifactMemoryStore,
    compute_content_hash,
)


class TestArtifactMemory:
    def test_creation(self):
        """验证 test creation 场景的输入、执行结果与兼容行为。"""
        mem = ArtifactMemory(
            artifact_id="A001",
            hash="abc123",
            type="schema",
            source_work="W001",
        )
        assert mem.artifact_id == "A001"
        assert mem.type == "schema"

    def test_to_json(self):
        """验证 test to json 场景的输入、执行结果与兼容行为。"""
        mem = ArtifactMemory(artifact_id="A001", hash="h", type="t", source_work="W001")
        data = mem.to_json()
        assert data["artifactId"] == "A001"
        assert data["hash"] == "h"

    def test_from_json(self):
        """验证 test from json 场景的输入、执行结果与兼容行为。"""
        data = {
            "artifactId": "A002",
            "hash": "hash2",
            "type": "json",
            "sourceWork": "W002",
            "dependencies": ["dep1"],
            "createdAt": "2024-01-01",
        }
        mem = ArtifactMemory.from_json(data)
        assert mem.artifact_id == "A002"
        assert mem.dependencies == ["dep1"]


class TestArtifactMemoryStore:
    def test_save_and_get(self):
        """验证 test save and get 场景的输入、执行结果与兼容行为。"""
        store = ArtifactMemoryStore()
        artifact = ArtifactMemory(
            artifact_id="A001",
            hash="hash1",
            type="schema",
            source_work="W001",
        )
        assert store.save(artifact) is True
        assert store.get("A001") is artifact

    def test_deduplicate_by_hash(self):
        """验证 test deduplicate by hash 场景的输入、执行结果与兼容行为。"""
        store = ArtifactMemoryStore()
        store.save(
            ArtifactMemory(
                artifact_id="A001",
                hash="hash1",
                type="schema",
                source_work="W001",
            )
        )
        result = store.save(
            ArtifactMemory(artifact_id="A002", hash="hash1", type="schema", source_work="W002")
        )
        assert result is False

    def test_find_by_hash(self):
        """验证 test find by hash 场景的输入、执行结果与兼容行为。"""
        store = ArtifactMemoryStore()
        store.save(
            ArtifactMemory(
                artifact_id="A001",
                hash="hash1",
                type="schema",
                source_work="W001",
            )
        )
        found = store.find_by_hash("hash1")
        assert found is not None
        assert found.artifact_id == "A001"

    def test_find_by_type(self):
        """验证 test find by type 场景的输入、执行结果与兼容行为。"""
        store = ArtifactMemoryStore()
        store.save(ArtifactMemory(artifact_id="A001", hash="h1", type="schema", source_work="W001"))
        store.save(ArtifactMemory(artifact_id="A002", hash="h2", type="schema", source_work="W002"))
        store.save(ArtifactMemory(artifact_id="A003", hash="h3", type="other", source_work="W003"))
        results = store.find_by_type("schema")
        assert len(results) == 2

    def test_find_reusable(self):
        """验证 test find reusable 场景的输入、执行结果与兼容行为。"""
        store = ArtifactMemoryStore()
        store.save(
            ArtifactMemory(
                artifact_id="A001",
                hash="h1",
                type="schema",
                source_work="W001",
                dependencies=["dep1", "dep2"],
            )
        )
        # 依赖是子集，应该复用
        result = store.find_reusable(artifact_type="schema", dependencies=["dep1"])
        assert result is not None
        assert result.artifact_id == "A001"

        # 依赖不是子集，不应复用
        result = store.find_reusable(artifact_type="schema", dependencies=["dep1", "dep2", "dep3"])
        assert result is None

    def test_delete(self):
        """验证 test delete 场景的输入、执行结果与兼容行为。"""
        store = ArtifactMemoryStore()
        store.save(ArtifactMemory(artifact_id="A001", hash="h1", type="schema", source_work="W001"))
        assert store.delete("A001") is True
        assert store.delete("A001") is False

    def test_snapshot_and_restore(self):
        """验证 test snapshot and restore 场景的输入、执行结果与兼容行为。"""
        store = ArtifactMemoryStore()
        store.save(ArtifactMemory(artifact_id="A001", hash="h1", type="schema", source_work="W001"))
        snapshot = store.snapshot()
        assert snapshot["totalCount"] == 1

        new_store = ArtifactMemoryStore()
        new_store.restore(snapshot)
        assert new_store.get("A001") is not None

    def test_clear(self):
        """验证 test clear 场景的输入、执行结果与兼容行为。"""
        store = ArtifactMemoryStore()
        store.save(ArtifactMemory(artifact_id="A001", hash="h1", type="schema", source_work="W001"))
        store.clear()
        assert len(store.list_all()) == 0


class TestComputeContentHash:
    def test_hash_consistency(self):
        """验证 test hash consistency 场景的输入、执行结果与兼容行为。"""
        h1 = compute_content_hash("same content")
        h2 = compute_content_hash("same content")
        assert h1 == h2

    def test_hash_difference(self):
        """验证 test hash difference 场景的输入、执行结果与兼容行为。"""
        h1 = compute_content_hash("content a")
        h2 = compute_content_hash("content b")
        assert h1 != h2

    def test_hash_length(self):
        """验证 test hash length 场景的输入、执行结果与兼容行为。"""
        h = compute_content_hash("test")
        assert len(h) == 16
