import type {
  ImageEditFidelity,
  TypographyPolicy,
} from "@/app/const/pageConst";

export type ImageEditIntent =
  | "text-only"
  | "localized"
  | "background"
  | "style-transfer"
  | "general";

interface BuildEditPolicyOptions {
  prompt: string;
  fidelity: ImageEditFidelity;
  typographyPolicy: TypographyPolicy;
  retryReason?: string;
}

export interface ImageEditPolicy {
  intent: ImageEditIntent;
  prompt: string;
  negativePrompt: string;
  promptExtend: boolean;
}

const TEXT_EDIT_PATTERN =
  /(标题|文字|文案|字体|字样|logo|标语|价格|按钮文字|替换.*字|把.*改成|改为|rename|replace.*text|change.*title)/iu;
const LOCAL_EDIT_PATTERN =
  /(只改|仅修改|局部|某个|这一处|该区域|右上角|左上角|右下角|左下角|标题栏|按钮|图标|remove|delete|replace|only change|local)/iu;
const BACKGROUND_EDIT_PATTERN =
  /(背景|场景|环境|摄影棚|纯白底|换底|background|scene)/iu;
const STYLE_EDIT_PATTERN =
  /(风格|重构|重新设计|改成.*风|赛博朋克|水彩|油画|动漫|卡通|style|redesign|transform)/iu;
const STRUCTURED_IMAGE_PATTERN =
  /(ui|界面|截图|网页|app|软件|dashboard|后台|电商|商品|详情页|海报|banner|包装|产品图)/iu;

/**
 * 根据用户指令判断编辑范围。
 *
 * 该判断只用于选择保护策略，不会修改用户真正的编辑目标。
 */
export function inferImageEditIntent(prompt: string): ImageEditIntent {
  const normalized = prompt.trim();
  if (TEXT_EDIT_PATTERN.test(normalized)) return "text-only";
  if (STYLE_EDIT_PATTERN.test(normalized)) return "style-transfer";
  if (BACKGROUND_EDIT_PATTERN.test(normalized)) return "background";
  if (LOCAL_EDIT_PATTERN.test(normalized)) return "localized";
  return "general";
}

function buildPreservationRules(
  intent: ImageEditIntent,
  fidelity: ImageEditFidelity,
): string[] {
  if (fidelity === "creative") {
    return [
      "这是图像编辑任务。可以按要求进行明显重构，但不要生成重复主体、双层边缘或重影。",
      "保持主体身份和用户未要求删除的关键元素可辨认。",
    ];
  }

  const common = [
    "这是单张原图上的编辑任务，不是重新生成相似图片，也不是前后对比拼图。",
    "只输出一张完整结果图。不得复制、叠加或重复原图中的任何主体、卡片、按钮、图标、边框和阴影。",
    "所有未被用户明确点名的区域必须保持原始位置、数量、比例、透视、颜色、光线、纹理和清晰度。",
    "禁止出现双层轮廓、半透明副本、残影、重影、拖影、错位叠加和重复 UI 元素。",
  ];

  if (fidelity === "precise") {
    common.push(
      "采用最小修改原则：把修改范围限制在完成指令所必需的最小区域，其余像素视觉上应与原图一致。",
      "不要重新设计版式，不要重绘背景，不要改变画布比例，不要增加装饰元素。",
    );
  } else {
    common.push(
      "保留原图主要结构与主体，仅允许对目标附近做自然衔接和必要的局部重绘。",
    );
  }

  if (intent === "text-only") {
    common.push(
      "这是文字替换任务：只修改用户指定的文字区域。保持文字框的位置、尺寸、对齐方式、背景、按钮、图标与其他内容不变。",
      "不要在旧文字上再次叠字；应先干净移除目标旧文字，再在同一区域写入新文字，避免双字、残留笔画和重影。",
    );
  } else if (intent === "localized") {
    common.push(
      "这是局部编辑：仅修改被描述的对象或区域，边界之外不得发生变化。",
    );
  } else if (intent === "background") {
    common.push(
      "只替换背景，前景主体的轮廓、数量、尺寸、姿态、材质和细节必须保持一致，不得复制主体。",
    );
  }

  return common;
}

function buildTypographyRules(
  intent: ImageEditIntent,
  typographyPolicy: TypographyPolicy,
): string[] {
  if (intent === "text-only") {
    return [
      "文字必须水平、清晰、无乱码、无错别字、无多余字符、无透视扭曲，并且只出现一次。",
    ];
  }

  if (typographyPolicy === "avoid-generated-text") {
    return [
      "除原图已有且未要求修改的文字外，不得新增任何文字、字母、数字、Logo、水印或伪文字。",
    ];
  }

  if (typographyPolicy === "strict-short-text") {
    return [
      "只允许出现用户明确提供的短文案，不得自行补充文字；文字不得重复、扭曲或产生乱码。",
    ];
  }

  return [];
}

/**
 * 构建图像编辑专用提示词和反向提示词。
 *
 * 精准模式会关闭 prompt_extend，避免模型自动润色后扩大编辑范围；
 * 创意模式保留智能扩写，以便获得更丰富的重构结果。
 */
export function buildImageEditPolicy({
  prompt,
  fidelity,
  typographyPolicy,
  retryReason,
}: BuildEditPolicyOptions): ImageEditPolicy {
  const normalizedPrompt = prompt.trim() || "请按要求编辑上传图片";
  const intent = inferImageEditIntent(normalizedPrompt);
  const isStructuredImage = STRUCTURED_IMAGE_PATTERN.test(normalizedPrompt);
  const rules = [
    ...buildPreservationRules(intent, fidelity),
    ...buildTypographyRules(intent, typographyPolicy),
  ];

  if (isStructuredImage && fidelity !== "creative") {
    rules.push(
      "原图属于 UI、商品图或排版类结构化画面：必须保持网格、卡片、边框、按钮、间距和对齐关系，不得生成第二套界面。",
    );
  }

  if (retryReason) {
    rules.push(
      `上一版未通过质量检查，问题是：${retryReason.slice(0, 240)}。本次必须彻底避免该问题。`,
    );
  }

  return {
    intent,
    prompt: [
      "请严格执行以下图片编辑任务：",
      normalizedPrompt,
      "",
      "编辑保护规则：",
      ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    ].join("\n"),
    negativePrompt: [
      "重影",
      "残影",
      "双重曝光",
      "重复主体",
      "重复物体",
      "重复按钮",
      "重复卡片",
      "重复图标",
      "双层边缘",
      "轮廓错位",
      "半透明副本",
      "拖影",
      "模糊",
      "背景被重绘",
      "布局改变",
      "多余装饰",
      "前后对比拼图",
      "画中画",
      "乱码",
      "文字重叠",
      "多余文字",
      "低画质",
    ].join("，"),
    promptExtend: fidelity === "creative",
  };
}
