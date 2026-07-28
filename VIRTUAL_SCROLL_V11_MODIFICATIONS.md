# Multi-agent项目：虚拟聊天列表切换定位修复（v11）

## 问题

切换到包含较多历史消息的其他聊天后，虚拟列表会停留在最旧消息的位置，而不是直接显示最新消息。

## 原因

`ChatList` 使用 `react-virtuoso` 渲染消息，并由父组件通过 `activeSessionId` 作为 React `key` 在切换会话时重新挂载。

原实现只有：

- `alignToBottom`：只会让内容高度不足一个视口的短会话贴底；
- `followOutput="smooth"`：主要跟随挂载后的新增内容；
- 流式输出期间调用 `scrollToIndex`：仅在 `isStreaming` 为 `true` 时生效。

因此，切换到一个已经存在的长会话时，Virtuoso 首次挂载仍会从索引 `0` 开始。

## 修改

在 `app/component/ChatList.tsx` 中为 Virtuoso 增加：

```tsx
initialTopMostItemIndex={{
  index: messages.length - 1,
  align: "end",
}}
```

实际代码对空消息数组进行了保护。切换会话后，列表首次绘制即把最后一条消息对齐到视口底部，不需要先从顶部渲染再滚动。

该设置只控制组件首次挂载的位置，不会持续强制用户回到底部，因此用户在当前会话内向上查看历史消息时不会被打断。原有流式输出自动跟随逻辑保持不变。

## 替换文件

- `app/component/ChatList.tsx`

## 本地验证说明

当前执行环境没有项目依赖目录，且无法连接 npm registry，因此未运行项目级 `pnpm lint` / `pnpm build`。已完成以下静态核对：

- 修改符合项目现有 TypeScript/React 写法；
- 使用项目锁定的 `react-virtuoso@4.18.10` 支持的 `initialTopMostItemIndex` 对象参数；
- 空消息数组不会传入负数索引；
- 未修改会话数据、SSE、Electron 或 Commerce 链路。
