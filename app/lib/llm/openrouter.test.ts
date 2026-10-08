// 模块说明：验证 OpenRouter 配置展示、凭证往返与聊天请求头。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LlmProviderSettings } from "../../components/api-key-modal/llm-provider-settings";
import { credentialStoreToSnapshot, snapshotToCredentialStore } from "../local-credentials";
import { buildLlmRequestHeaders } from "./client-request";
import { getDefaultModelForProvider } from "./registry/models";

it("OpenRouter 配置可展示、保存和传入独立的请求头", () => {
  const store = {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "https://router.example/v1",
  };
  const snapshot = credentialStoreToSnapshot(store);
  expect(snapshotToCredentialStore(snapshot.llm, snapshot.endpoints, {})).toEqual(store);
  const model = getDefaultModelForProvider("openrouter");
  expect(model?.model).toBe("openai/gpt-4o-mini");
  const headers = buildLlmRequestHeaders(snapshot.llm, model!.id, snapshot.endpoints);
  expect(headers["x-llm-key-openrouter"]).toBe("test-key");
  expect(headers["x-llm-base-url-openrouter"]).toBe(store.OPENROUTER_BASE_URL);
  expect(headers["x-llm-key-openai"]).toBeUndefined();
  const html = renderToStaticMarkup(
    createElement(LlmProviderSettings, {
      keys: {},
      endpoints: {},
      visibleFields: new Set<string>(),
      updateKey: () => {},
      updateEndpoint: () => {},
      toggleVisibility: () => {},
    }),
  );
  expect(html).toContain('aria-label="OpenRouter API Key"');
  expect(html).toContain('aria-label="OpenRouter API Base URL"');
  expect(html).toContain('placeholder="https://openrouter.ai/api/v1"');
});
