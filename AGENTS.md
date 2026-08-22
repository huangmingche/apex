# AGENTS.md

顶点（Apex）是基于深度求索 Harness（DeepSeek Harness）、由开源鸿蒙（OpenHarmony）提供操作系统框架和平台能力，采用「一切皆插件」设计原则的开源智能操作系统。

本文件约束在本仓库内工作的 agent。

## 硬规则

1. **不改上游。** `.submodules/` 与 `.sources/` 是上游源码工作区，不是本仓库的根 workspace 包。上游代码的修改一律通过显式标注的 fork 或补丁目录进行，禁止就地改 `.submodules/`。
2. **不搬上游代码。** 仓库本体只放「上游版本锁 + 自有内容」，不把上游整棵树复制进根目录。
3. **不提交构建产物。** `node_modules/`、`.artifacts/`、`.dsh-build/`、`dist/`、`lib/`、`*.tsbuildinfo`、原生二进制一律不进版本库。
4. **不做不可逆操作。** 未经项目负责人逐条批准，禁止 `rm -rf`、`git reset --hard`、`git clean`、重拉仓库、更新 submodule 指针、`git commit`、`git push`。

## 上游版本锁

- 上游 harness 版本记录在 `dsh-source.lock.json` 与本仓库的 submodule 指针中。
- OpenHarmony 固定为官方 `OpenHarmony-v7.0-Release`。`openharmony-source.lock.json` 记录官方 manifest 子模块的 commit、tag 对象及解析清单摘要；`manifests/openharmony-7.0.xml` 固定各源码仓库的 commit。清单必须与官方来源核对，不以个人机器上的源码目录作为上游。
- `.submodules/openharmony` 只保存官方 manifest 仓库；完整 OpenHarmony 源码放在项目外的区分大小写文件系统。既有源码先只读校验再复用，不自动同步、覆盖或修复。
- 升级上游是一条独立变更：先对齐版本、跑通构建与测试，再单独提交，不与功能改动混在一起。

## 文档

- 简体中文为主，英文对照放在 `*.en.md`。

## 开发入口

- 所有开发入口统一使用根目录 `package.json` 的 `packageManager` 指定的 pnpm 版本，目前为 `pnpm@11.7.0`。
- 根 `pnpm-workspace.yaml` 仅包含根命令入口，并关闭运行脚本前的自动依赖安装，防止在根生成依赖；上游 workspace 在项目外的工作目录运行。
- Apex 自有包按 `packages/<分组>/<包名>/` 组织，分组只作容器，不放 `package.json` 或源码。包使用自有名称，不复用官方 `@deepseek-ai/*` 名称，详见 [自有包说明](packages/README.md)。
- `packages/` 只放 Apex 自有内容，不复制或链接上游包；生成和验证脚本保存在 `scripts/`。根目录不承载上游 workspace。
- `pnpm run prepare:runtime` 从锁定的官方源码原样生成项目外的工作目录。构建、测试和运行入口见 [开发说明](docs/development.md)。
- `pnpm run oh:lock` 检查 OpenHarmony 版本锁和清单入口；`pnpm run oh:verify --source-dir <外部源码目录>` 校验已有源码；`pnpm run oh:sync --source-dir <新的外部空目录>` 按锁定清单获取源码。pnpm 统一命令入口，源码获取仍使用官方 Repo、Git 和 Git LFS，详见 [OpenHarmony 源码说明](docs/openharmony.md)。
- Paper 以父仓库的 Git 指针固定版本，`pnpm run paper:verify` 校验来源和检出状态。CI 仅对现有 Paper 指针的单独更新执行轻量检查；其他改动、手动运行及无法判定的情况均执行完整检查，详见 [CI 检查范围](docs/development.md#ci-检查范围)。
