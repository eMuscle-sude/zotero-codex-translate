# Zotero Codex PDF 翻译

在 Zotero 中选择 **Codex 账号登录**或 **OpenAI 兼容 API**，将有文字层的英文 PDF 翻译成中文 PDF 和中英对照 PDF。通过工作台可翻译 Zotero 附件，也可直接拖入本机 PDF。BabelDOC 在本机保留页面结构和插图，原始 PDF 保留。

当前版本 **0.6.2**，支持 **Windows / Zotero 10.0.x**，本机验证版本为 Zotero 10.0.8。其他系统与 Zotero 版本尚未验证。

## 翻译工作台

- **Zotero 文献和附件**：右键选择「打开工作台并翻译 PDF」，工作台打开并提交所选文件。完成后，译文挂回对应的 Zotero 条目。
- **桌面和下载目录**：从「工具 → Codex PDF 翻译 → 打开 PDF 翻译工作台」进入。拖入一个或多个本机 PDF，也可点击「选择文件」。选定输出格式和页码后点击「开始翻译」。原稿和译文无需导入 Zotero。完成后可直接打开译文，或从该任务的「更多」中另存副本。
- 工作台是独立窗口，可以和 Zotero 主窗口同时使用。左侧用于添加 PDF 和查看任务，右侧用于设置模型和思考强度。任务列表按文献标题显示，可筛选并查看该任务保存的档位。旧的右键直接翻译、阅读器按钮和标题摘要翻译也可继续使用。

## 模型连接

打开工作台右侧的「模型连接」，也可从「工具 → Codex PDF 翻译 → 设置」进入。

### Codex 账号

- **使用本机 CLI 登录**：复用本机 Codex CLI 的登录状态，插件不读取或复制账号令牌。
- **浏览器登录 / 设备码登录**：调用 Codex CLI 官方授权流程。授权完成后自动更新状态；插件独立登录保存在本机单独目录。
- **访问令牌 / OpenAI API Key**：在「登录选项与 Codex 模型」中选择凭据类型，然后点击「登录并使用」。访问令牌使用 Codex 官方支持的类型，资格和生成方式见 [Codex 授权文档](https://learn.chatgpt.com/docs/auth)。这两种方式都使用插件独立登录，可随时切回本机账号。
- **退出独立登录**：仅退出插件独立账号。本机 Codex 登录不受影响。
- 模型名称留空使用 CLI 默认模型，也可填账号可用的名称。思考强度可选低、中、高、极高，旧设置默认沿用中。选择后点击「保存模型设置」。档位支持情况取决于模型和 CLI 版本。

### 其他 API

选择「＋ 添加 API 连接」，选服务预设或填写自定义地址，选择模型并输入 API Key，然后点击「保存并使用 API」。可用预设模型，也可在填入密钥后点「获取可用模型」读取服务端列表。服务未提供模型列表时可手动填写模型 ID。可保存多组连接、随时切换并测试当前连接。

接口要求：**OpenAI Chat Completions 兼容协议**，即 `POST <服务地址>/chat/completions`。支持 OpenAI、DeepSeek、硅基流动等兼容服务，也可连接本机 Ollama。预设仅填写服务地址等常用字段，实际可用模型及额度由服务商提供。Claude / Gemini 原生协议不在本版范围内；兼容网关可按兼容 API 配置。

API Key 使用 Windows 当前用户 DPAPI 加密保存。保存后输入框清空，仅显示已保存状态；留空保存表示保留原密钥。更改远程地址需填写对应的新密钥。API 模式可独立使用，不要求安装或登录 Codex。

API 默认沿用服务商设置。服务支持 `reasoning_effort` 时可选择档位并保存。官方 OpenAI 的 GPT-6.2 Sol 可选低、中、高、极高、最高，GPT-4.1 系列没有可调档位。更改模型或思考强度只影响**新建任务**，已提交和自动恢复的任务继续使用创建时保存的连接和档位。各模型支持的档位见 [OpenAI 模型文档](https://developers.openai.com/api/docs/models)。

## 安装

从 [GitHub Releases](https://github.com/eMuscle-sude/zotero-codex-translate/releases/latest) 下载 Windows 安装压缩包并解压。压缩包包含 XPI、安装脚本及依赖清单。`SHA256SUMS.txt` 提供文件校验值。0.6.2 的 Windows 安装包为 `zotero-codex-translate-0.6.2-windows.zip`。

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

插件兼容旧安装脚本生成的带 BOM 配置。Python 偏好为空或路径失效时，会尝试安装配置及标准运行环境目录；每次启动任务重新读取配置。Codex 桌面应用升级导致旧 bin 路径失效时，会自动寻找当前 CLI。启动失败只通知一次，失败任务会显示失败状态。

## 翻译标题与摘要

在右侧标题或摘要的可编辑文字中选中一段，右键选择「翻译所选文字」。没有选区时，可以选择「翻译整个标题 / 摘要」。使用设置中当前连接的模型与目标语言，不调用 PDF 排版引擎。

译文显示在右下角约 360 像素宽的小浮窗中，可修改后点击「替换选区」或「复制」。浮窗可拖动、收起；原文和模型默认折叠。没有全屏遮罩或键盘焦点限制，可以继续切换文献和操作 Zotero。替换只影响原选区；预览、取消和失败不修改题录。只读字段支持预览与复制。保存后可以通过 Zotero 的「编辑 → 撤销」恢复。

如果翻译时条目或原字段已变化，插件会拒绝覆盖并提示重新选择。一次最多 8000 字符，全局最多两项文字翻译。关闭预览会取消尚未结束的请求。窗口中的复制、粘贴和其他原菜单操作保留。

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
| `text-translations/` | 标题 / 摘要翻译调用状态与译文日志，不进入 PDF 队列 |

文档正文发送至选定的模型服务。版式在本机处理；原稿、译文和日志保存在本机，日志可能包含论文内容。源码、发布包不包含上述本机数据。

## 验证与开发

工作台在 Zotero 10.0.8 的隔离配置中验证。本机 Codex CLI 连接完成了在线试译。本机模拟 API 验证了模型列表、文件拖入、队列去重、PDF 排版和 Zotero 附件导入。34 项 Python 测试与 27 项插件测试覆盖凭据传递、思考强度、连接切换和任务状态。实际第三方模型和 Codex 新账号登录须使用相应账号授权。

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
