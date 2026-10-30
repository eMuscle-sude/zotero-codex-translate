# Zotero Codex PDF 翻译

在 Zotero 中选择 **Codex 账号登录**或 **OpenAI 兼容 API**，将有文字层的英文 PDF 翻译成中文 PDF、中英对照 PDF，并挂回原文献条目。BabelDOC 在本机保留页面结构和插图，原始 PDF 保留。

当前版本 **0.4.0**，支持 **Windows / Zotero 10.0.x**，本机验证版本为 Zotero 10.0.7。其他系统与 Zotero 版本尚未验证。

## 模型连接

打开「工具 → Codex PDF 翻译 → 设置」，在顶部选择连接方式。

### Codex 账号

- **使用本机已登录账号**：复用本机 Codex CLI 的登录状态，插件不读取或复制账号令牌。
- **浏览器登录 / 设备码登录**：调用 Codex CLI 官方授权流程。授权完成后自动更新状态；插件独立登录保存在本机单独目录。
- **退出独立登录**：仅退出插件独立账号。本机 Codex 登录不受影响。
- 模型名称留空使用 CLI 默认模型，也可填账号可用的名称。Codex 思考强度固定为 **中（medium）**。

### 其他 API

选择「＋ 添加 API 连接」，填写名称、服务地址、模型、API Key，点击「保存并使用 API」，然后「测试当前连接」。支持保存多组连接并切换。

接口要求：**OpenAI Chat Completions 兼容协议**，即 `POST <服务地址>/chat/completions`。支持 OpenAI、DeepSeek、硅基流动等兼容服务，也可连接本机 Ollama。预设仅填写服务地址等常用字段，实际可用模型及额度由服务商提供。Claude / Gemini 原生协议不在本版范围内；兼容网关可按兼容 API 配置。

API Key 使用 Windows 当前用户 DPAPI 加密保存。保存后输入框清空，仅显示已保存状态；留空保存表示保留原密钥。更改远程地址需填写对应的新密钥。API 模式可独立使用，不要求安装或登录 Codex。

切换连接只影响**新建任务**，正在执行和自动恢复的任务继续使用其创建时的连接。API 的思考参数由服务商默认值决定。

## 安装

从 [GitHub Releases](https://github.com/eMuscle-sude/zotero-codex-translate/releases/latest) 下载 `zotero-codex-translate-0.4.0-windows.zip` 并解压。压缩包包含 XPI、安装脚本及依赖清单；无需从源码构建。`SHA256SUMS.txt` 提供文件校验值。

需要 uv 或 Python 3.12；使用 Codex 模式时另需安装 Codex CLI。使用 API 模式时可不安装 CLI。

关闭 Zotero，在解压后的安装包目录打开 PowerShell，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -InstallPlugin
```

已有环境可指定：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -RuntimePath .venv -InstallPlugin
```

脚本安装 Python 依赖、配置运行路径并安装 XPI；替换前备份插件和必要配置，不直接修改 Zotero 数据库。也可只运行 setup.ps1 配置环境，再从 Zotero 的插件管理器选择 XPI 安装。仅复制 XPI 不包含 Python 运行环境。开发者使用源码时，先按下方步骤构建 dist 中的安装包。

## 翻译 PDF

1. 导入或选中英文原始 PDF / 文献条目。
2. 右键选择「用当前模型翻译 PDF（保留版式）」，或在阅读器顶部点击「译」。
3. 在右下角进度面板查看阶段、真实百分比、耗时和队列；可收起或取消。工具菜单可重新展开进度面板。
4. 完成后得到 `[Codex 中文]`、`[Codex 对照]` 附件。附件前缀为兼容旧版继续保留，实际模型以任务记录为准。

默认英译中，同时输出两种 PDF。设置页可填页码 `1-2` 先试译，留空翻译全文。首次运行会下载版式模型和字体，可能需要数分钟。「新增 PDF 附件后自动翻译」默认关闭。

### 去重、恢复与速度

按原 PDF 内容指纹、文献库、目标语言及页码检查译文。连续点击只提交一个任务；已有可读取译文直接复用，缺少一种输出时只补该种。导入中断后按输出文件内容核对恢复。部分页试译不会阻止全文翻译。

同一原稿已有译文时，切换模型也会优先复用，避免误点产生重复 PDF。测试新连接时请用尚未翻译的 PDF；若要重新生成已有译文，可先删除对应译文附件。原稿内容改变时视为新文档。

后台同时处理两批文本。Codex 每批最多合并 16 组 / 24000 字符；API 每批最多 8 组 / 12000 字符，以降低输出截断概率。成功译文缓存复用；API 缓存按服务地址和模型隔离。

临时错误每批额外重试最多 2 次，等待 5、15 秒；仍失败的任务最多再延后恢复 2 次，每次等待 60 秒。等待恢复期间暂停下一篇，可随时取消。额度、登录或权限错误直接显示失败。重开 Zotero 会检查可恢复任务和已有结果。

Windows 后台使用 pythonw 隐藏窗口启动。关闭 Zotero 不会停止已启动的翻译，重开后继续查看进度、导入结果；取消任务会终止该任务的排版和模型请求。

## 版式范围

- BabelDOC **0.6.4** 保留页面尺寸、分栏、插图与公式占位符，译文在原区域重新排版。
- 中文换行和字号可能调整，不承诺逐像素一致。图片内部文字、部分表格或页眉页脚可能保持原文。
- 密集表格与特殊公式需要检查；纯扫描件需先 OCR，本版不提供自动 OCR。
- 进度百分比来自版式引擎阶段，导入完成后才显示 100%，不是剩余耗时预测。

## 本机数据

状态位于 `%LOCALAPPDATA%\ZoteroCodexTranslate`，详情见 [SECURITY.md](SECURITY.md)。

| 路径 | 内容 |
| --- | --- |
| `config.json` | Python / Codex 路径 |
| `connections.json` | 已选连接、模型与不含密钥的凭据引用 |
| `credentials/` | Windows 用户绑定的加密 API Key |
| `codex-auth/` | CLI 管理的插件独立登录，禁止上传 |
| `translations.sqlite` | 成功译文缓存 |
| `jobs/<ID>/` | 任务状态、进度、日志和输出 PDF |
| `connection-tests/` | 小段文本连接测试结果 |

文档正文发送至选定的模型服务。版式在本机处理；原稿、译文和日志保存在本机，日志可能包含论文内容。源码、发布包不包含上述本机数据。

## 验证与开发

0.4.0 已验证本机 Codex 的真实中文测试；API 使用本机模拟接口验证保存、调用、切换和错误处理。具体第三方账号的在线连通性需用户填写自己的密钥验收。浏览器 / 设备码授权启动与独立凭据隔离有自动测试，账号授权步骤由用户亲自完成。

按 [ACCEPTANCE.md](ACCEPTANCE.md) 验收。运行自动检查和构建：

```powershell
python -X utf8 -m unittest discover -s tests -v
node --test tests/test_plugin.mjs
python scripts/build.py
python scripts/check_release.py
```

翻译引擎和模型连接控制器仅监听 `127.0.0.1`，分别使用随机令牌，拒绝来自网页 Origin 的控制请求，不向局域网提供服务。请求和任务文件不包含 API Key。每个翻译任务有进程独占锁。

Codex 调用使用只读沙箱与临时工作目录，并忽略开发 hooks、MCP 和插件配置；论文正文作为不可信翻译内容处理。官方资料：[Codex 授权](https://learn.chatgpt.com/docs/auth)、[Codex CLI](https://learn.chatgpt.com/docs/cli/reference)、[BabelDOC](https://github.com/funstory-ai/BabelDOC)。

AGPL-3.0-or-later；BabelDOC、Zotero、Codex CLI 为独立依赖。尚未部署在线更新服务，升级请手动安装 XPI。安装脚本首次启动临时允许加载复制的插件，随后恢复 Zotero 原有自动禁用设置。
