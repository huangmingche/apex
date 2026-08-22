# Apex 自有包

**简体中文** | [English](README.en.md)

此目录按官方仓库的 `packages/<group>/<pkg>/` 结构组织 Apex 自有插件、服务和组合包。目前只有目录说明，尚无实际自有包；运行入口使用锁定的官方 DeepSeek Harness。

每个分组是纯容器，只包含包目录和 Markdown 说明，不放 `package.json` 或源码。每个包有自己的 `package.json`，包名描述其职责，使用自有名称，不复用官方 `@deepseek-ai/*` 名称。

源码插件的典型布局如下；组合包也可以提供配置或资源，入口由包本身声明：

```text
packages/
└── <group>/
    └── <pkg>/
        ├── package.json
        ├── src/index.ts
        ├── README.md
        └── README.en.md
```

本目录只放 Apex 自有内容，不复制或链接 `.submodules/`、`.sources/` 中的上游包。`pnpm run verify` 检查目录分层、包名，以及 `packages/`、分组和包目录的符号链接；它不能代替对代码来源的人工审查。

目录存在不会自动构建或加载其中的包，插件需要通过 Harness 的扩展接口接入。构建与运行方式见[开发说明](../docs/development.md)，目录规范参考官方的[包布局](../.submodules/deepseek-harness/packages/README.md#hierarchy)和[添加 workspace 包](../.submodules/deepseek-harness/docs/cookbook/adding-a-package.zh.md)。
