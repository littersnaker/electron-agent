"""项目内置 GLM-4.6V Vision Skill 定义。

该 Skill 由 Runtime 直接注入，避免依赖用户项目中不同版本的 Skill 文件解析格式。
"""

from __future__ import annotations

from dataclasses import dataclass

GLM46V_SKILL_ID = "glm46v-vision"

GLM46V_SKILL_PROMPT = """你已启用 GLM-4.6V-Flash 视觉辅助 Skill。

行为规则：
1. 当 Runtime Context 中出现“Skill Tool Result · glm46v-vision”时，把它作为上传图片的辅助视觉证据；它不是用户原文，也不是绝对真相。
2. Code Agent 应把视觉证据转化为可执行的页面结构、组件、文字、间距、尺寸、颜色、状态和验收要求，再结合真实项目文件完成修改与验证。
3. QA Agent 应优先回答图片中可见的事实、OCR、表格、对象关系和不确定区域，明确区分“直接可见”“合理推断”“无法确认”。
4. 对文字、数量、坐标、尺寸和颜色等关键细节进行交叉检查；GLM 结果与原附件或项目证据冲突时，以可验证的原始证据为准。
5. 图片经 GLM 成功分析后，下游主模型只接收文字化视觉证据，不再接收原始图片；因此 DeepSeek 等文本模型也可以继续完成回答或代码任务。
6. 没有视觉结果时不要假装已经调用 GLM；应明确报告视觉分析失败，不能把图片继续发送给不支持视觉的模型。
7. 不得输出、记录或要求用户在提示词中粘贴任何 API Key。
"""


@dataclass(frozen=True, slots=True)
class BuiltinSkillDefinition:
    """与项目 SkillDefinition 保持鸭子类型兼容的内置 Skill。"""

    id: str
    version: str
    scope: str
    prompt: str
    requires_reasoning: bool
    description: str


GLM46V_SKILL = BuiltinSkillDefinition(
    id=GLM46V_SKILL_ID,
    version="1.1.0",
    scope="project",
    prompt=GLM46V_SKILL_PROMPT,
    requires_reasoning=True,
    description="使用 GLM-4.6V-Flash 为 Code Agent 与 QA Agent 提供自动图片理解和 OCR 证据。",
)

BUILTIN_SKILLS = {GLM46V_SKILL_ID: GLM46V_SKILL}


def split_registry_and_builtin_skill_ids(
    skill_ids: tuple[str, ...],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """把普通 Registry Skill 与本模块内置 Skill 分开。"""

    registry_ids: list[str] = []
    builtin_ids: list[str] = []
    for skill_id in skill_ids:
        if skill_id in BUILTIN_SKILLS:
            builtin_ids.append(skill_id)
        else:
            registry_ids.append(skill_id)
    return tuple(registry_ids), tuple(builtin_ids)


def resolve_builtin_skills(skill_ids: tuple[str, ...]) -> list[BuiltinSkillDefinition]:
    """按 Agent 配置顺序解析已启用的内置 Skill。"""

    return [BUILTIN_SKILLS[item] for item in skill_ids if item in BUILTIN_SKILLS]


def builtin_skill_catalog() -> list[dict[str, object]]:
    """返回不含密钥的诊断目录。"""

    return [
        {
            "id": skill.id,
            "version": skill.version,
            "scope": skill.scope,
            "description": skill.description,
            "requiresReasoning": skill.requires_reasoning,
            "builtin": True,
        }
        for skill in BUILTIN_SKILLS.values()
    ]
