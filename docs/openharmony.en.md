# OpenHarmony source

[简体中文](openharmony.md) | **English**

This iteration uses the official `OpenHarmony-v7.0-Release` source baseline. Official repositories supply the code; Apex stores version locks and acquisition and verification entry points; complete source stays outside the project. Existing local source can be reused after verification, and a new machine can obtain it from upstream sources.

## Official baseline and timestamps

| Item | Pinned value |
| --- | --- |
| Official manifest repository | `https://gitcode.com/openharmony/manifest.git` |
| Release tag | `OpenHarmony-v7.0-Release` |
| Manifest commit | `2cf9dc1ee5c1738f1aa5ef31a96c4de705e8bd1f` |
| Tag object | `af9147402dd7f7ad1c0cd6e7adabf73bfe9cfcdf` |
| Recorded tag timestamp | `2026-08-21T17:06:02Z`, or **2026-08-22 01:06:02** in Beijing |
| Recorded manifest commit timestamp | `2026-08-21T17:03:30Z`, or **2026-08-22 01:03:30** in Beijing |

These timestamps are recorded in Git objects and do not establish the first push or release announcement time. The fixed tag object and commit define the baseline; dates are not used to select code from a moving branch. Check the [tag metadata](https://api.github.com/repos/openharmony/manifest/git/tags/af9147402dd7f7ad1c0cd6e7adabf73bfe9cfcdf) and [manifest commit](https://github.com/openharmony/manifest/commit/2cf9dc1ee5c1738f1aa5ef31a96c4de705e8bd1f). The official GitCode tag must identify the same objects.

## What this repository stores

| Location | Purpose |
| --- | --- |
| `.submodules/openharmony/` | Unmodified official manifest repository at a fixed commit |
| `openharmony-source.lock.json` | Official source, tag, commit, resolved manifest digest, and acquisition tool version |
| `manifests/openharmony-7.0.xml` | Expanded official manifest with pinned project commits, sources, and paths |
| `scripts/openharmony/` | Apex-owned acquisition and verification entry points and tests |
| `.sources/` | Documentation of source placement; complete source is not stored here |

The resolved manifest contains 518 projects and preserves official paths, groups, and required link rules. Parent gitlinks pin nested repository versions; the lock records sources and evidence for two upstream entries lacking `.gitmodules` mappings. Third-party submodules retain their upstream-declared sources. Download sources must follow the official manifest or verifiable upstream declarations, without relying on private paths on a developer's machine.

## Environment and commands

Use the root's `pnpm@11.7.0`, a supported Node.js version, Git 2.43 or later, and Python 3.10 or later. Acquisition also requires Git LFS and an executable official Repo launcher; the lock pins the actual Repo tool version. Scripts do not silently install or replace user tools. Python uses its standard library without installing dependencies in the project root.

The source directory must be outside the project on a case-sensitive filesystem. macOS can reuse an existing case-sensitive source volume; Linux can use a suitable external workspace. Replace the `<...>` path placeholders below before running commands.

```sh
# Check the repository's version lock and official manifest entry point only.
pnpm run oh:lock

# Verify an existing complete external checkout.
pnpm run oh:verify --source-dir <external-source-directory>

# Acquire pinned source into a new empty external directory, then verify it.
pnpm run oh:sync --source-dir <new-empty-external-directory>
```

pnpm provides the Apex command entry points; official Repo manifests, Git, and Git LFS still organize and obtain the source. Acquisition reads the static manifest stored in this repository and downloads from its upstream sources. Reading a local manifest file does not create a dependency on private local source.

## Reuse existing source

1. Mount the existing source volume outside the project. A read-only mount is recommended for the first verification; there is no need to copy source into the repository.
2. Run `pnpm run oh:verify --source-dir <external-source-directory>` against the mounted source root.
3. After verification passes, reuse that workspace for subsequent development. Personal mount paths are not stored in the lock and are not dependencies of other machines.

Verification checks the manifest and lock, project set and sources, commits, index, source contents, nested gitlinks, and LFS files. Differences fail the check and are reported. Verification does not synchronize, move refs, edit files, or repair source. Existing workspaces can retain their official manifest management mode and are not reinitialized to use the new acquisition entry point.

Official CRLF checkout rules are checked against attributes from the pinned Git tree; local attribute overrides cannot change the verification basis. When a fresh checkout contains an official LFS pointer without a checkout rule, acquisition adds a rule for that file only in the new workspace's private Git metadata. It does not change the official `.gitattributes` or the configuration of an existing source workspace.

## Acquire on a new machine

In a fresh checkout of this iteration's Apex commit, initialize the recorded official submodules and check the version lock:

```sh
git submodule update --init --recursive
pnpm run oh:lock
```

Use the launcher from [Google's official git-repo](https://gerrit.googlesource.com/git-repo/+/refs/tags/v2.54/README.md). This example places `v2.54` in an external tools directory. The destination must not already exist; do not overwrite an existing tools directory:

```sh
apex_repo_tool_dir="$HOME/.local/share/apex-tools/git-repo-v2.54"
git clone --depth 1 --branch v2.54 https://gerrit.googlesource.com/git-repo "$apex_repo_tool_dir"
git -C "$apex_repo_tool_dir" rev-parse HEAD
```

After cloning succeeds, confirm that the output is `97dc5c1bd9527c2abe2183b16a4b7ef037dc34a7`, then add the launcher to the current shell's search path:

```sh
export PATH="$apex_repo_tool_dir:$PATH"
command -v repo
git lfs version
```

`command -v repo` should resolve to the newly acquired tools directory. Git LFS must already be installed; otherwise, prepare it through the official package-management method for your system. These Git and tool-preparation commands bootstrap the environment; Apex development entry points continue to use pnpm.

Prepare an empty external directory on a case-sensitive filesystem, then run:

```sh
pnpm run oh:sync --source-dir <new-empty-external-directory>
```

Acquisition uses Repo's standalone manifest mode to synchronize fixed commits, obtain LFS content and upstream submodules, then verify the result. A directory containing files or Repo metadata is rejected and cannot be nested inside another Git or Repo workspace, avoiding reconfiguration of existing workspaces. Partial downloads remain outside the project for inspection; they are not automatically cleared or overwritten.

Standalone manifest initialization and enumeration of all 518 projects have been tested with the actual official Repo 2.54 tool. Downloads and disk usage are substantial; a complete new-machine source download has not been performed in this iteration. It is recorded separately from existing-source verification and cannot be established by script tests, manifest enumeration, or checking an existing checkout.

## Verification scope and remaining work

```sh
pnpm run verify
pnpm run test:oh
pnpm run oh:verify --source-dir <external-source-directory>
```

Ordinary CI checks the version lock, official manifest entry point, and script tests, and continues to build and run the Harness default tests without downloading complete OpenHarmony source. Complete source verification runs where source is already available; logs and reports stay outside the project.

This stage establishes the official release source baseline and its acquisition and verification entry points. Build-host and prebuilts preparation, build-toolchain pinning, target-board adaptation, system compilation and boot, Harness runtime compatibility, and Apex plugin integration remain future work. A source lock alone does not establish that an OS image can be built, booted, or reproduced.

Official references: [source acquisition](https://github.com/openharmony/docs/blob/OpenHarmony-v7.0-Release/zh-cn/device-dev/quick-start/quickstart-pkg-sourcecode.md), [Repo manifest format](https://gerrit.googlesource.com/git-repo/+/HEAD/docs/manifest-format.md). Mainline examples in upstream documentation must not replace this repository's pinned release baseline.
