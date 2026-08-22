# Apex 开发

**简体中文** | [English](development.en.md)

仓库维护上游版本锁、Apex 自有包和启动脚本。官方 DeepSeek Harness 位于 `.submodules/deepseek-harness`，保持只读；[自有包目录](../packages/README.md)按 `packages/<分组>/<包名>/` 组织，目前只有说明，尚无实际自有包。

OpenHarmony 7.0 的官方 manifest 位于 `.submodules/openharmony`，完整源码在项目外获取或复用。版本基线、环境要求及校验步骤见 [OpenHarmony 源码说明](openharmony.md)。下文的构建和运行命令针对 Harness，不生成 OpenHarmony 系统镜像。

## 构建与运行

需要 Git、tar、Node.js 22.19 或更新的受支持版本、Python 3.10 或更高版本，以及初始化完成的官方子模块。先准备好根目录 `package.json` 的 `packageManager` 指定的 pnpm 版本，目前为 11.7.0；可用 `pnpm --version` 确认。所有开发入口统一使用 pnpm，依赖安装保持锁文件不变。

根 `pnpm-workspace.yaml` 仅包含根命令入口，关闭 `pnpm run` 前的自动依赖安装，避免在根生成依赖。上游 workspace 及其依赖由项目外的工作目录承载。

```sh
pnpm run verify
pnpm run install:runtime
pnpm run build
pnpm run dsh --help
pnpm run web --no-open
```

官方源码原样导出到项目外的 `~/.cache/apex/workspaces/`，依赖和构建产物也放在那里。`pnpm run prepare:runtime` 显示具体目录，并对照锁定的 Git tree 检查源码内容和文件模式。`APEX_WORKSPACE_DIR` 可以指定项目外的目录，已有的无关目录会被拒绝，源码有修改的工作目录不会被覆盖。

CLI 和 Web 保留调用时的项目目录，使用官方默认界面和 `~/.dsh` 用户数据目录，也可通过 `DSH_HOME` 指定其他位置。`pnpm run dev:web` 监听 Web 源码并重新构建，另运行 `pnpm run web` 提供页面；独立桌面应用不在当前构建范围。

## 验证与修改

```sh
pnpm run test --maxWorkers=4
pnpm run lint
pnpm run doc-sync
pnpm run verify
```

`pnpm run verify` 检查 Harness 和 OpenHarmony 的版本锁、上游入口、Paper 子模块及仓库布局。`pnpm run test:wrapper` 运行 Apex 启动脚本、Paper 校验、CI 分流及 OpenHarmony 获取、校验脚本的测试；`pnpm run test` 再运行官方 Harness 的默认测试，各部分只执行一次。普通 CI 不下载完整 OpenHarmony 源码，也不执行系统构建。校验外部完整源码请使用 `pnpm run oh:verify --source-dir <外部源码目录>`。

其他上游命令通过 `pnpm run runtime <命令> [参数]` 转发。构建、测试和文档检查在外部工作目录执行，使用锁定版本的原始测试。Apex 功能扩展在 `packages/<分组>/<包名>/` 中实现；分组仅作容器，源码和包配置放在包目录内，不复制或链接上游包。自有包的构建和加载需要单独接入；生成目录中的修改不会自动成为仓库修改。

## CI 检查范围

每次推送到 `main` / `master`、Pull Request 或手动运行仍触发 CI。`pnpm run ci:scope` 按本次事件的完整变更范围选择检查：只有现有 `.submodules/deepseek-harness-paper` 的 Git 提交指针单独更新，才执行轻量检查。

- 轻量检查运行 `pnpm run paper:verify` 和 `pnpm run test:ci`，核对 Paper 来源、Git 指针、实际检出版本与工作区状态，并测试 Paper 校验及 CI 分流逻辑；不安装 Harness 依赖，也不执行 Harness 构建和测试。
- 其他改动保留完整 CI，包括 Harness、OpenHarmony、Apex 代码、版本锁、`.gitmodules`、CI 配置和混合修改。新增或删除 Paper 子模块也执行完整检查。
- 首次推送、手动运行、比较基准不可用或无法确认变更范围时，执行完整检查。推送比较整个 `before..after`；Pull Request 只有在核实检出的合并提交与事件中的 base/head 一致后，才允许轻量检查。

Paper 版本由父仓库记录的 Git 指针决定，不另设重复的版本锁。`pnpm run paper:verify` 仅读取并核对指定的官方来源和本地检出，不切换版本或自动修复。轻量检查和完整检查都有各自的 CI 运行记录；运行摘要标明选用的范围。

## CI 中的 PowerShell

锁定版本的持久终端只转发 PTY 数据，不回应终端的光标位置查询。Linux 上的 PowerShell 会等待这个响应，导致初始化及后续命令超时。CI 的[环境准备步骤](../.github/workflows/ci.yml)在运行器临时目录生成一个启动入口：仅对官方默认的交互参数 `-NoLogo -NoProfile` 调整该 PTY 的输入行规，并将标准输出通过管道原样转回终端，使 .NET 使用输出重定向模式、避免光标查询。输入仍是真实 PTY，交互式控制台保持运行；关闭不支持输出重定向的 PSReadLine，避免每次输入都触发异常后回退到基本输入。其他 PowerShell 调用原样转发。输出转发使用非零文件描述符，避免被上游误判为正在等待用户输入。

启动时还会加载内置的 `Microsoft.PowerShell.Management` 与 `Microsoft.PowerShell.Utility` 模块，并在原目录执行一次 `Set-Location -LiteralPath $PWD.Path`，提前完成文件管理和普通输出的首次初始化。否则首次切换目录可能在加载模块期间静默超过上游测试的 300 毫秒空闲阈值，命令尚未结束就被判为 `inferred_idle`；预初始化保留原工作目录，不修改该阈值或伪造就绪状态。

此适配仅用于 CI 的无界面测试，不改官方源码或测试，也不排除失败用例。[真实终端检查](../scripts/ci/verify-pwsh.py)由 `pnpm run test:ci:pwsh` 执行，验证启动目录不变、交互输入、中文输出和非零退出码，然后以 2 个 worker 运行一次完整的默认测试，降低进程密集测试并发时对短就绪检测窗口的干扰；不修改原始测试的超时或断言。

备份和验证日志存放在项目目录之外。保留需要的备份，避免用清空仓库或恢复整棵上游源码的方式整理目录。上游版本升级与功能修改分开处理，提交和推送仍须获得明确授权。
