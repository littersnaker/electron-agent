"""工作区中英文搜索词提取。

中文问题通常没有空格，不能把整句话直接当成一个精确关键词。本模块通过二至四字
n-gram 生成可命中文档、注释和变量附近文本的搜索词，供 SQLite 索引和磁盘搜索共用。
"""

from __future__ import annotations

import re

CHINESE_QUERY_STOPWORDS = {
    "目前",
    "这个",
    "项目",
    "已经",
    "是否",
    "可以",
    "能够",
    "怎么",
    "为什么",
    "功能",
    "一下",
    "进行",
    "需要",
    "还是",
    "没有",
    "不是",
    "一个",
    "什么",
}


def _chinese_ngrams(segment: str) -> list[str]:
    """把连续中文文本拆成二至四字的可搜索片段。"""

    values: list[str] = []
    for size in (2, 3, 4):
        for start in range(0, max(len(segment) - size + 1, 0)):
            value = segment[start : start + size]
            if value in CHINESE_QUERY_STOPWORDS:
                continue
            values.append(value)
    return values


def extract_search_terms(query: str, *, limit: int = 36) -> list[str]:
    """返回去重后的中英文搜索词，并限制单次评分成本。"""

    ascii_terms = re.findall(r"[A-Za-z_][A-Za-z0-9_./:-]{1,}", query)
    chinese_segments = re.findall(r"[\u4e00-\u9fff]{2,}", query)
    chinese_terms: list[str] = []
    for segment in chinese_segments:
        chinese_terms.extend(_chinese_ngrams(segment))
    ordered = [term.lower() for term in (*ascii_terms, *chinese_terms)]
    return list(dict.fromkeys(ordered))[:limit]
