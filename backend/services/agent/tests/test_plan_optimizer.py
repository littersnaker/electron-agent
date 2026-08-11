"""Planner 后处理器的 Work 粒度与依赖测试。"""

from __future__ import annotations

from backend.services.agent.plan_optimizer import optimize_work_granularity
from backend.services.agent.work_models import WorkItem


def test_medium_commerce_work_keeps_single_work() -> None:
    """两个功能域、少量文件的电商 Work 不应被拆碎。"""

    works = [
        WorkItem(
            id="W003",
            title="购物车与结算模块",
            objective="实现购物车加购、数量修改、结算地址和提交模拟订单",
            target_files=[
                "src/pages/cart/index.tsx",
                "src/store/cart.ts",
                "src/pages/checkout/index.tsx",
                "src/services/order.ts",
            ],
            execution_type="coding",
        ),
        WorkItem(
            id="W005",
            title="质量验证",
            objective="验证全部业务模块",
            dependencies=["W003"],
            execution_type="validation",
        ),
    ]

    optimized = optimize_work_granularity("完善电商小程序商城", works)

    assert len(optimized) == 2
    coding = [item for item in optimized if item.execution_type == "coding"]
    assert len(coding) == 1
    assert coding[0].id == "W003"
    assert coding[0].target_files == [
        "src/pages/cart/index.tsx",
        "src/store/cart.ts",
        "src/pages/checkout/index.tsx",
        "src/services/order.ts",
    ]
    validation = next(item for item in optimized if item.id == "W005")
    assert validation.dependencies == ["W003"]


def test_large_multi_domain_work_is_split_with_cap() -> None:
    """同时覆盖 4 个功能域且目标文件很多的超大 Work 才拆分，且不超过 6 个子项。"""

    work = WorkItem(
        id="W001",
        title="完整实现电商商城全部模块",
        objective="实现商品分类、商品详情、购物车、结算、订单和个人中心的完整商城功能",
        target_files=[
            f"src/pages/catalog{i}/index.tsx" for i in range(3)
        ]
        + [
            f"src/pages/cart{i}/index.tsx" for i in range(3)
        ]
        + [
            f"src/pages/checkout{i}/index.tsx" for i in range(3)
        ]
        + [
            f"src/pages/order{i}/index.tsx" for i in range(3)
        ],
        execution_type="coding",
    )

    optimized = optimize_work_granularity("完善电商小程序商城", [work])

    assert 1 < len(optimized) <= 6
    ids = {item.id for item in optimized}
    assert "W001" not in ids
    by_key = {item.title: item for item in optimized}
    assert "结算与订单提交" in by_key
    assert "购物车状态与交互" in by_key
    assert by_key["购物车状态与交互"].id in by_key["结算与订单提交"].dependencies


def test_non_commerce_work_keeps_original_shape() -> None:
    """普通代码任务不得被电商规则误拆。"""

    work = WorkItem("W001", "修复登录", "修复登录重定向与错误提示")

    assert optimize_work_granularity("修复登录错误", [work]) == [work]
