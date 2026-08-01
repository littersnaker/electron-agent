# Auto Router 智能降级与百炼 API Host 修复说明

## 一、截图中的错误代表什么

截图里并不是 Router 只调用了 Qwen 3.7 Max。旧版已经继续尝试了 Plus、Flash 和
Gemini，但它们都返回了 `ConnectError: All connection attempts failed`。

这个错误发生在 HTTP 连接建立阶段，服务端甚至还没有收到模型名。因此它与
“Max 是否向下兼容 Plus/Flash”无关。若同一个百炼 API Host 无法连接，继续用同一
Host 请求十个模型也会全部失败。

常见原因包括：

- 百炼 Key 属于业务空间，但应用仍调用旧公共域名；
- 业务空间地域和 API Host 不匹配；
- Windows 系统代理没有转换成 Python 可读取的 `HTTPS_PROXY`；
- DNS、防火墙、企业网关或安全软件阻断 Python 后端；
- Base URL 少了 `/compatible-mode/v1`，或误填了控制台网页地址；
- 系统时间严重不准确，导致 TLS 握手失败。

## 二、本次 Router 的实际规则

### 1. 模型级错误才在百炼内部向下兼容

当供应商返回模型不存在、当前账号未开通模型或模型级限流时，Auto 按以下顺序继续：

1. `qwen3.7-max`
2. `qwen3.7-plus`
3. `qwen3.7-flash`
4. 已登记的百炼托管后备模型
5. 其他已配置供应商

例如 Max 返回 HTTP 404 时，Router 会继续尝试 Plus；Plus 成功后，当前请求立即使用
Plus，且后续 30 分钟优先使用这个最近成功模型。

### 2. 端点级错误不再重复请求同一供应商

网络、DNS、TLS、401/403 鉴权错误和供应商 5xx 会影响同一 Key/Host 下的所有模型。
Router 只记录一次百炼端点失败，然后跳过其余 Qwen 候选，继续尝试 Kimi、OpenAI、
DeepSeek、GLM 或 Gemini。这样不会重复等待 Max、Plus、Flash 的连接超时。

### 3. 手动选择模型不偷换

用户明确选择某个模型时，只调用该模型。失败会返回真实错误，不会在后台换成其他
模型，以免回答质量和计费来源与界面选择不一致。

## 三、设置百炼业务空间 API Host

设置页的 Qwen 区域新增了“API Base URL（可选）”。从百炼控制台复制当前业务空间
提供的 API Host，并填到 OpenAI-compatible Base URL，例如：

```text
https://<业务空间域名>/compatible-mode/v1
```

也可以填写完整聊天地址：

```text
https://<业务空间域名>/compatible-mode/v1/chat/completions
```

Python 后端会自动规范化路径。保存后该地址会与 API Key 一起持久化，但只发送给
本机 Python 后端，不会写入聊天请求正文。

端点优先级为：

1. 用户在设置页填写的 Base URL；
2. Python 运行环境中的 `DASHSCOPE_BASE_URL`；
3. 构建时嵌入的 Base URL；
4. 项目注册表中的公共兼容端点。

## 四、验证方式

1. 打开“服务与数据源”；
2. 在 Qwen 区域填写个人 Key，或留空使用内置百炼兜底；
3. 业务空间账号填写对应 API Base URL；
4. 点击“验证”；
5. 验证成功消息会显示实际可用的模型；
6. 回到聊天选择 Auto，再发送一次最小问题；
7. 后续请求应优先复用刚才成功的模型。

若验证仍显示“无法连接接口主机”，应先检查网络和 Host，而不是继续修改模型名。
