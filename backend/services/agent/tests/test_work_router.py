"""Work Router 测试。"""

from backend.services.agent.work_models import WorkItem, FileSystemOperation
from backend.services.agent.work_router import WorkRouter


class TestWorkRouter:
    def test_route_filesystem(self):
        """验证 test route filesystem 场景的输入、执行结果与兼容行为。"""
        router = WorkRouter()
        work = WorkItem(
            id="W001",
            title="重命名文件",
            objective="重命名文件",
            execution_type="filesystem",
            file_operations=[
                FileSystemOperation(type="rename", source_path="old.py", target_path="new.py")
            ],
        )
        result = router.route(work)
        assert result.handler_type == WorkRouter.HANDLER_FILESYSTEM

    def test_route_agent_coding(self):
        """验证 test route agent coding 场景的输入、执行结果与兼容行为。"""
        router = WorkRouter()
        work = WorkItem(id="W001", title="添加用户接口", objective="添加用户接口", execution_type="agent")
        result = router.route(work)
        assert result.handler_type == WorkRouter.HANDLER_CODING

    def test_route_validation(self):
        """验证 test route validation 场景的输入、执行结果与兼容行为。"""
        router = WorkRouter()
        work = WorkItem(id="W001", title="运行测试", objective="运行测试", execution_type="agent")
        result = router.route(work)
        assert result.handler_type == WorkRouter.HANDLER_VALIDATION

    def test_route_artifact(self):
        """验证 test route artifact 场景的输入、执行结果与兼容行为。"""
        router = WorkRouter()
        work = WorkItem(
            id="W001",
            title="生成数据 schema",
            objective="生成数据 schema",
            execution_type="agent",
        )
        result = router.route(work)
        assert result.handler_type == WorkRouter.HANDLER_ARTIFACT

    def test_route_factory_audit_work(self):
        """数据层审查/补齐类 Work 应走单次审计通道，而不是多轮 Coding Worker。"""
        router = WorkRouter()
        work = WorkItem(
            id="W001",
            title="审查并补齐 Mock 数据与 Data Source 契约",
            objective="审计 mock 数据与 data source 契约一致性，补齐缺失字段",
            execution_type="coding",
        )
        result = router.route(work)
        assert result.handler_type == WorkRouter.HANDLER_FACTORY_AUDIT

    def test_route_factory_audit_skips_page_work(self):
        """涉及页面接入的 Work 不得误入审计通道。"""
        router = WorkRouter()
        work = WorkItem(
            id="W001",
            title="审查并补齐 Mock 数据并接入页面",
            objective="审计 mock 数据并绑定到页面组件",
            execution_type="coding",
        )
        result = router.route(work)
        assert result.handler_type == WorkRouter.HANDLER_CODING

    def test_route_infer_from_file_ops(self):
        """验证 test route infer from file ops 场景的输入、执行结果与兼容行为。"""
        router = WorkRouter()
        work = WorkItem(
            id="W001",
            title="移动文件",
            objective="移动文件",
            execution_type="agent",  # 错误标记，但有 file_operations
            file_operations=[
                FileSystemOperation(type="move", source_path="a.py", target_path="b.py")
            ],
        )
        result = router.route(work)
        assert result.handler_type == WorkRouter.HANDLER_FILESYSTEM

    def test_batch_route(self):
        """验证 test batch route 场景的输入、执行结果与兼容行为。"""
        router = WorkRouter()
        works = [
            WorkItem(id="W001", title="test", objective="test", execution_type="filesystem"),
            WorkItem(id="W002", title="code", objective="code", execution_type="agent"),
            WorkItem(id="W003", title="run tests", objective="run tests", execution_type="agent"),
        ]
        groups = router.batch_route(works)
        assert len(groups[WorkRouter.HANDLER_FILESYSTEM]) == 1
        assert len(groups[WorkRouter.HANDLER_CODING]) == 1
        assert len(groups[WorkRouter.HANDLER_VALIDATION]) == 1

    def test_register_handler(self):
        """验证 test register handler 场景的输入、执行结果与兼容行为。"""
        router = WorkRouter()

        async def dummy_handler(**kwargs):
            """验证 dummy handler 场景的输入、执行结果与兼容行为。"""
            return "ok"

        router.register(WorkRouter.HANDLER_CODING, dummy_handler)
        work = WorkItem(id="W001", title="code", objective="code", execution_type="agent")
        result = router.route(work)
        assert result.handler is dummy_handler
