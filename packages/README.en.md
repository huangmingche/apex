# Apex packages

[简体中文](README.md) | **English**

This directory follows the official repository's `packages/<group>/<pkg>/` layout for Apex plugins, services, and bundles. It currently contains documentation only, with no implemented Apex packages. Runtime entry points use the pinned official DeepSeek Harness release.

Each group is a container for package directories and Markdown documentation, without its own `package.json` or source files. Each package has a `package.json` and a name describing its responsibility. Use independently owned names instead of official `@deepseek-ai/*` names.

A source plugin typically has the following layout. Bundles may instead provide configuration or resources, with entry points declared by the package:

```text
packages/
└── <group>/
    └── <pkg>/
        ├── package.json
        ├── src/index.ts
        ├── README.md
        └── README.en.md
```

Keep only Apex-owned content here; do not copy or link upstream packages from `.submodules/` or `.sources/`. `pnpm run verify` checks directory nesting, package names, and symlinks at the `packages/`, group, and package-directory levels. It does not replace manual review of code provenance.

Placing a package here does not automatically build or load it; plugins must be connected through Harness extension interfaces. See the [development guide](../docs/development.en.md), the official [package hierarchy](../.submodules/deepseek-harness/packages/README.md#hierarchy), and the [workspace package guide](../.submodules/deepseek-harness/docs/cookbook/adding-a-package.md).
