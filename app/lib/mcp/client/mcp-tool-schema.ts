/**
 * 模块职责：MCP 工具转换、查找和参数 Schema 校验。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { LlmFunctionTool } from "@/app/lib/llm/types";
import { MCP_TOOL_PREFIX, McpResolvedTool } from "./mcp-configuration";
export function toLlmMcpTools(
  resolvedTools: readonly McpResolvedTool[],
): LlmFunctionTool[] {
  return resolvedTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.llmName,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

export function findMcpTool(
  tools: readonly McpResolvedTool[],
  llmToolName: string,
): McpResolvedTool | null {
  return tools.find((tool) => tool.llmName === llmToolName) || null;
}

export function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

export function matchesJsonSchemaType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      );
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

/**
 * 校验 MCP Server 返回的 JSON Schema 常用子集。
 *
 * MCP 工具的 Schema 来自外部服务，不能像内置工具一样提前写死为 Zod。这里覆盖
 * object/array/string/number/integer/boolean、required、enum、长度和数值边界等
 * 高频约束。遇到 `$ref`、`oneOf` 等复杂关键字时保持保守：不擅自改写参数，交由
 * MCP Server 做最终校验并把错误返回模型。
 */
export function validateJsonSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  currentPath: string,
  errors: string[],
  depth = 0,
): void {
  if (depth > 8 || errors.length >= 20) return;

  const allowedTypes = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (
    allowedTypes.length > 0 &&
    !allowedTypes.some((expectedType) =>
      matchesJsonSchemaType(value, expectedType),
    )
  ) {
    errors.push(
      `${currentPath} 应为 ${allowedTypes.join("/")}，实际为 ${describeJsonType(value)}。`,
    );
    return;
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => Object.is(item, value))
  ) {
    errors.push(`${currentPath} 不在允许的枚举值中。`);
  }

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      errors.push(`${currentPath} 长度不能小于 ${schema.minLength}。`);
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      errors.push(`${currentPath} 长度不能大于 ${schema.maxLength}。`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) {
          errors.push(`${currentPath} 不符合格式约束 ${schema.pattern}。`);
        }
      } catch {
        // 远端 Schema 的正则若无法在当前 JS 运行时编译，则留给服务端最终校验。
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${currentPath} 不能小于 ${schema.minimum}。`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${currentPath} 不能大于 ${schema.maximum}。`);
    }
  }

  if (Array.isArray(value)) {
    if (
      typeof schema.minItems === "number" &&
      value.length < schema.minItems
    ) {
      errors.push(`${currentPath} 至少需要 ${schema.minItems} 项。`);
    }
    if (
      typeof schema.maxItems === "number" &&
      value.length > schema.maxItems
    ) {
      errors.push(`${currentPath} 最多允许 ${schema.maxItems} 项。`);
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => {
        validateJsonSchemaValue(
          item,
          schema.items as Record<string, unknown>,
          `${currentPath}[${index}]`,
          errors,
          depth + 1,
        );
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [];

    for (const requiredKey of required) {
      if (!(requiredKey in objectValue)) {
        errors.push(`${currentPath}.${requiredKey} 为必填参数。`);
      }
    }

    for (const [key, item] of Object.entries(objectValue)) {
      const propertySchema = properties[key];
      if (propertySchema && typeof propertySchema === "object") {
        validateJsonSchemaValue(
          item,
          propertySchema as Record<string, unknown>,
          `${currentPath}.${key}`,
          errors,
          depth + 1,
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${currentPath}.${key} 是未声明的额外参数。`);
      }
    }
  }
}

/** 在真正发出 MCP tools/call 前做本地参数校验，减少无效网络调用。 */
export function validateMcpToolArguments(
  tool: McpResolvedTool,
  args: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  validateJsonSchemaValue(args, tool.inputSchema, "arguments", errors);
  return errors;
}
