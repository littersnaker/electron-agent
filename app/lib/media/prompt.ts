import type { MediaMode, TypographyPolicy } from "@/app/const/pageConst";

interface BuildMediaPromptOptions {
  prompt: string;
  mode: MediaMode;
  typographyPolicy: TypographyPolicy;
}

function isImageMode(mode: MediaMode): boolean {
  return mode === "text-to-image" || mode === "image-edit";
}

/**
 * 给图片生成补充文字排版约束。
 *
 * 注意：生成图里的文字已经变成像素，前端 CSS 无法把歪字“修正回来”。
 * 商业海报最稳定的方案是先生成无字底图，再用真实字体做二次排版。
 */
export function buildMediaPrompt({
  prompt,
  mode,
  typographyPolicy,
}: BuildMediaPromptOptions): string {
  const normalizedPrompt = prompt.trim() || "请生成高质量商业视觉内容";
  if (!isImageMode(mode) || typographyPolicy === "model-default") {
    return normalizedPrompt;
  }

  if (typographyPolicy === "avoid-generated-text") {
    return [
      normalizedPrompt,
      "排版约束：画面中不要生成任何文字、字母、数字、Logo、水印、乱码或伪文字。",
      "如果构图需要标题或卖点，请预留干净、平整、正视角的留白区域，供后期用真实字体叠加。",
    ].join("\n");
  }

  return [
    normalizedPrompt,
    "文字约束：只允许绘制用户明确提供的短文案，不要自行补充任何文字。",
    "所有文字必须水平、正视角、字形完整、字距均匀、无透视扭曲、无错别字、无乱码。",
    "文字区域保持高对比度和干净背景；长段落请改为留白，不要强行生成。",
  ].join("\n");
}
