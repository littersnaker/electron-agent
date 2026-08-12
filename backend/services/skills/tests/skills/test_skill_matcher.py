"""Skill 打分匹配器：名称 / 标签 / 描述关键词的增强匹配测试。"""

from __future__ import annotations

from backend.services.skills.matcher import SkillMatcher


def _candidate(
    *,
    skill_id: str,
    name: str = "",
    description: str = "",
    tags: tuple[str, ...] = (),
) -> dict[str, object]:
    """构造最小候选 Skill 字典。"""

    return {
        "id": skill_id,
        "name": name or skill_id,
        "description": description,
        "tags": tags,
    }


def test_matcher_prefers_name_hit() -> None:
    """名称精确命中应排在标签命中之前。"""

    matcher = SkillMatcher()
    candidates = [
        _candidate(skill_id="gsap-react", tags=("animation",)),
        _candidate(skill_id="gsap-core", tags=("animation", "gsap")),
    ]
    matched = matcher.match(task_text="用 gsap-react 做动画", candidates=candidates)
    assert [item["id"] for item in matched] == ["gsap-react", "gsap-core"]


def test_matcher_matches_tags() -> None:
    """任务文本命中标签时应返回对应 Skill。"""

    matcher = SkillMatcher()
    candidates = [
        _candidate(skill_id="commerce-listing", tags=("listing", "amazon")),
        _candidate(skill_id="qa-assistant", tags=("问答",)),
    ]
    matched = matcher.match(task_text="帮我写 amazon listing", candidates=candidates)
    assert [item["id"] for item in matched] == ["commerce-listing"]


def test_matcher_matches_description_keyword() -> None:
    """没有 tags 时，描述中的英文专名命中任务文本也应匹配。"""

    matcher = SkillMatcher()
    candidates = [
        _candidate(
            skill_id="gsap-scrolltrigger",
            description="Official GSAP skill for ScrollTrigger animations and pinning.",
        ),
        _candidate(
            skill_id="taro-adapt",
            description="Taro 移动端尺寸适配与全局配置说明。",
        ),
    ]
    matched = matcher.match(task_text="用 ScrollTrigger 实现滚动固定", candidates=candidates)
    assert [item["id"] for item in matched] == ["gsap-scrolltrigger"]


def test_matcher_matches_chinese_segment() -> None:
    """描述中的中文短句出现在任务文本时应命中。"""

    matcher = SkillMatcher()
    candidates = [
        _candidate(
            skill_id="taro-adapt",
            description="Taro 移动端尺寸适配与全局配置说明。",
        ),
    ]
    matched = matcher.match(task_text="帮我做移动端尺寸适配", candidates=candidates)
    assert [item["id"] for item in matched] == ["taro-adapt"]


def test_matcher_ignores_stop_words_and_empty() -> None:
    """停用词与完全无关的候选不应命中。"""

    matcher = SkillMatcher()
    candidates = [
        _candidate(
            skill_id="gsap-core",
            description="Use this skill for web animation and timeline.",
        ),
        _candidate(skill_id="unrelated", description="Database migration guide."),
    ]
    matched = matcher.match(task_text="今天有什么安排", candidates=candidates)
    assert matched == []
