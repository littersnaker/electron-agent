import type { MessageAttachment } from "@/app/const/pageConst";
import { completeWithLlm } from "@/app/lib/llm/gateway";
import type { LlmCredentials, LlmTokenUsage } from "@/app/lib/llm/types";
import type { MediaAttachmentInput } from "./types";

export interface ImageEditQualityAssessment {
  checked: boolean;
  passed: boolean;
  ghostingDetected: boolean;
  unrelatedChangesDetected: boolean;
  reason?: string;
  usage: LlmTokenUsage;
}

const EMPTY_USAGE: LlmTokenUsage = {
  prompt: 0,
  completion: 0,
  total: 0,
};

function parseDataUrl(
  value: string | undefined,
): { mimeType: string; data: string } | null {
  if (!value) return null;
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    mimeType: match[1] || "image/png",
    data: match[2].replace(/\s+/gu, ""),
  };
}

function extractJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * 使用视觉模型比较原图与编辑结果。
 *
 * 该检查只关注生产场景中最常见的失败：重影、重复元素、无关区域被重绘。
 * 它不是像素级鉴定，因此失败时不会阻断结果，而是交给调用方决定是否重试。
 */
export async function assessImageEditQuality(options: {
  credentials: LlmCredentials;
  original: MediaAttachmentInput;
  generated: MessageAttachment;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<ImageEditQualityAssessment> {
  const generatedImage = parseDataUrl(options.generated.dataUrl);
  if (!generatedImage) {
    return {
      checked: false,
      passed: true,
      ghostingDetected: false,
      unrelatedChangesDetected: false,
      reason: "生成结果不是可检查的 Data URL。",
      usage: EMPTY_USAGE,
    };
  }

  try {
    const response = await completeWithLlm({
      task: "reviewer",
      credentials: options.credentials,
      requiredCapabilities: ["vision"],
      signal: options.signal,
      messages: [
        {
          role: "system",
          content:
            "你是严格的图片编辑质量检查员。比较原图和编辑结果，只输出 JSON，不要输出 Markdown。",
        },
        {
          role: "user",
          content:
            "图一是原图，图二是编辑结果。请判断图二是否出现重影/重复元素/双层边缘，或是否修改了用户没有要求修改的区域。",
          parts: [
            {
              type: "text",
              text: [
                `用户编辑要求：${options.userPrompt}`,
                "检查标准：",
                "1. 任何主体、按钮、卡片、图标或边框出现两份、半透明副本、错位轮廓，ghosting=true。",
                "2. 非目标区域的布局、颜色、光影、比例或数量明显变化，unrelated_changes=true。",
                "3. 只有在没有上述明显问题时 pass=true。",
                '仅输出：{"pass":true,"ghosting":false,"unrelated_changes":false,"reason":"..."}',
              ].join("\n"),
            },
            {
              type: "image",
              mimeType: options.original.mimeType,
              data: options.original.data,
              name: "original-image",
            },
            {
              type: "image",
              mimeType: generatedImage.mimeType,
              data: generatedImage.data,
              name: "edited-image",
            },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message.content || "";
    const parsed = extractJsonObject(raw);
    if (!parsed) {
      return {
        checked: false,
        passed: true,
        ghostingDetected: false,
        unrelatedChangesDetected: false,
        reason: "质量检查模型没有返回可解析 JSON。",
        usage: EMPTY_USAGE,
      };
    }

    const ghostingDetected = readBoolean(parsed.ghosting);
    const unrelatedChangesDetected = readBoolean(parsed.unrelated_changes);
    const passed =
      "pass" in parsed
        ? readBoolean(parsed.pass)
        : !ghostingDetected && !unrelatedChangesDetected;

    return {
      checked: true,
      passed,
      ghostingDetected,
      unrelatedChangesDetected,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
      usage: {
        prompt: response.usage?.prompt_tokens || 0,
        completion: response.usage?.completion_tokens || 0,
        total: response.usage?.total_tokens || 0,
      },
    };
  } catch (error) {
    return {
      checked: false,
      passed: true,
      ghostingDetected: false,
      unrelatedChangesDetected: false,
      reason:
        error instanceof Error
          ? `质量检查已跳过：${error.message}`
          : "质量检查已跳过。",
      usage: EMPTY_USAGE,
    };
  }
}
