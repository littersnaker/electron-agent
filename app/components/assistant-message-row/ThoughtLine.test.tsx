// 模块说明：ThoughtLine 的历史计时、可访问折叠及助手消息接入。
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import ThoughtLine from "./ThoughtLine";
import { AssistantMessageRow } from "./assistant-message-row";

it("历史计时使用已保存时长，完成后详情折叠并退出键盘导航", () => {
  const html = renderToStaticMarkup(
    <ThoughtLine working={false} elapsed={42} doneLabel="已完成" steps={["真实步骤"]} />,
  );
  expect(html).toContain("42.0 秒");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-hidden="true" inert=""');
  expect(html).toContain("真实步骤");
});

it("支持受控展开；等待回复与已结束思考使用同一组件", () => {
  const html = renderToStaticMarkup(
    <ThoughtLine working={false} open showTimer={false} steps={["保留的详情"]} />,
  );
  expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain('class="thought-line__timer"');
  const waiting = renderToStaticMarkup(<AssistantMessageRow content="" isStreaming />);
  expect(waiting).toContain("正在思考…");
  expect(waiting).toContain("thought-line");
  const settled = renderToStaticMarkup(
    <AssistantMessageRow content="<INTERNAL_THINK_START>已有思考概要<INTERNAL_THINK_END>正式回复" />,
  );
  expect(settled).toContain("思考完成");
  expect(settled).toContain("正式回复");
  expect(settled).not.toContain("已有思考概要");
});
