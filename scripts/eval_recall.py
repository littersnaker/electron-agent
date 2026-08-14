"""候选数调参脚本：对比 RECALL_K 不同取值下的检索命中质量。

用法示例：
    python scripts/eval_recall.py --project project_xxx \
        --questions "登录超时|session expire" --expect "auth.py"

未提供 ``--expect`` 时只输出每个候选数命中的文件路径，供人工判断。
"""

from __future__ import annotations

import argparse
import asyncio

from backend.services.embeddings.retrieval import hybrid_search_project


async def _run_one(
    project_id: str,
    question: str,
    expect: str,
) -> None:
    """对单个问题跑三档候选数并打印命中情况。"""

    print(f"\n问题：{question}")
    for recall_k in (10, 20, 30):
        top_k = 5
        results = await hybrid_search_project(project_id, question, recall_k=recall_k, top_k=top_k)
        paths = [str(item.get("path") or "") for item in results]
        hit = any(expect and expect.lower() in path.lower() for path in paths)
        marker = "✔ 命中" if hit else "✘ 未命中"
        print(f"  RECALL_K={recall_k:>2} TOP_K={top_k} -> {marker}")
        for path in paths:
            print(f"    - {path}")


def main() -> None:
    """解析命令行参数并逐题评估。"""

    parser = argparse.ArgumentParser(description="候选数调参评估")
    parser.add_argument("--project", required=True, help="项目 ID")
    parser.add_argument("--questions", required=True, help="用 | 分隔的多个问题")
    parser.add_argument("--expect", default="", help="期望命中的路径片段")
    args = parser.parse_args()
    questions = [item.strip() for item in args.questions.split("|") if item.strip()]
    if not questions:
        print("未提供有效问题。")
        return
    for question in questions:
        asyncio.run(_run_one(args.project, question, args.expect))


if __name__ == "__main__":
    main()
