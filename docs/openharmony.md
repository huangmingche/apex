# OpenHarmony 源码

**简体中文** | [English](openharmony.en.md)

本期使用官方 `OpenHarmony-v7.0-Release` 源码基线。官方仓库是代码来源；Apex 保存版本锁和获取、校验入口；完整源码保存在项目外。现有本机源码通过校验后可以复用，新机器可以从官方来源重新获取。

## 官方基线与时间

| 项目 | 固定值 |
| --- | --- |
| 官方 manifest 仓库 | `https://gitcode.com/openharmony/manifest.git` |
| 正式版标签 | `OpenHarmony-v7.0-Release` |
| manifest commit | `2cf9dc1ee5c1738f1aa5ef31a96c4de705e8bd1f` |
| tag 对象 | `af9147402dd7f7ad1c0cd6e7adabf73bfe9cfcdf` |
| 标签记录时间 | `2026-08-21T17:06:02Z`，即北京时间 **2026-08-22 01:06:02** |
| manifest 提交记录时间 | `2026-08-21T17:03:30Z`，即北京时间 **2026-08-22 01:03:30** |

以上为 Git 对象记录的时间，不等同于首次推送或发布公告时间。版本依据是固定的 tag 对象和 commit，不以日期筛选分支上的代码，也不跟随后续分支更新。可核对[标签元数据](https://api.github.com/repos/openharmony/manifest/git/tags/af9147402dd7f7ad1c0cd6e7adabf73bfe9cfcdf)及[manifest 提交](https://github.com/openharmony/manifest/commit/2cf9dc1ee5c1738f1aa5ef31a96c4de705e8bd1f)；GitCode 官方仓库的标签对象应与之相同。

## 仓库内保存什么

| 位置 | 作用 |
| --- | --- |
| `.submodules/openharmony/` | 官方 manifest 仓库，保持原样并固定 commit |
| `openharmony-source.lock.json` | 官方来源、tag、commit、解析清单摘要及获取工具版本 |
| `manifests/openharmony-7.0.xml` | 按官方 manifest 展开的源码清单，固定每个项目的 commit、地址和目录 |
| `scripts/openharmony/` | Apex 自有的获取、校验入口和测试 |
| `.sources/` | 源码存放约定的说明文件，完整源码不放在这里 |

解析清单包含 518 个项目，保留官方的路径、分组和必要的链接规则。嵌套仓库的版本以父仓库的 gitlink 为准；两个缺少 `.gitmodules` 映射的上游条目在版本锁中记录来源和依据。第三方子模块沿用上游声明的地址。所有下载地址都必须来自官方清单或可核验的上游声明，不能依赖个人机器上的私有路径。

## 环境与命令

使用根目录指定的 `pnpm@11.7.0` 和受支持的 Node.js，以及 Git 2.43 或更高版本、Python 3.10 或更高版本。源码获取还需要 Git LFS 和可执行的官方 Repo 启动器；实际 Repo 工具版本由版本锁固定。脚本不会静默安装或替换用户的工具。Python 使用标准库，不在项目根目录安装依赖。

源码目录必须在项目外，并位于区分大小写的文件系统。macOS 可以复用已有的区分大小写源码卷；Linux 使用满足要求的外部工作区。以下 `<...>` 为需要替换的路径，不应原样执行。

```sh
# 只检查仓库内的版本锁和官方 manifest 入口
pnpm run oh:lock

# 校验已经存在的外部完整源码
pnpm run oh:verify --source-dir <外部源码目录>

# 在新的外部空目录获取锁定源码，再校验
pnpm run oh:sync --source-dir <新的外部空目录>
```

pnpm 统一 Apex 的命令入口，底层仍按官方 Repo 清单组织源码，并使用 Git 与 Git LFS。获取脚本读取仓库内的静态锁定清单，下载地址来自清单中的上游来源；读取本地清单文件不意味着依赖本机私有源码。

## 复用现有源码

1. 将已有源码卷挂载到项目外的路径。首次校验建议只读挂载；不需要把源码复制进仓库。
2. 对挂载后的源码根目录运行 `pnpm run oh:verify --source-dir <外部源码目录>`。
3. 校验通过后，可以在后续开发中继续使用该工作区。个人挂载路径不写入版本锁，也不是其他机器的依赖。

校验检查 manifest 与锁定清单、项目集合及来源、实际 commit、索引、源码内容、嵌套 gitlink 和 LFS 大文件；发现差异就失败并报告。校验不同步源码、不更新指针、不修改文件或自动修复。既有工作区可以保留官方 manifest 的管理方式，不会为了套用新的获取入口而重新初始化。

官方声明的 CRLF 换行按固定 Git 树中的属性校验，本机属性覆盖不能改变校验依据。新获取工作区遇到官方 LFS 指针缺少检出规则时，仅在该工作区的 Git 私有元数据中补充对应文件规则；不修改官方 `.gitattributes`，也不修改已有源码工作区的配置。

## 新机器获取

在克隆了本期 Apex 提交的新工作区根目录，初始化提交中记录的官方子模块并检查版本锁：

```sh
git submodule update --init --recursive
pnpm run oh:lock
```

Repo 启动器使用 [Google 官方 git-repo](https://gerrit.googlesource.com/git-repo/+/refs/tags/v2.54/README.md)。以下示例将 `v2.54` 放到项目外的工具目录；目标目录必须尚不存在，已有工具目录不应覆盖：

```sh
apex_repo_tool_dir="$HOME/.local/share/apex-tools/git-repo-v2.54"
git clone --depth 1 --branch v2.54 https://gerrit.googlesource.com/git-repo "$apex_repo_tool_dir"
git -C "$apex_repo_tool_dir" rev-parse HEAD
```

确认克隆成功，且输出为 `97dc5c1bd9527c2abe2183b16a4b7ef037dc34a7`，再将启动器加入当前 shell 的搜索路径：

```sh
export PATH="$apex_repo_tool_dir:$PATH"
command -v repo
git lfs version
```

`command -v repo` 应指向刚获取的工具目录。Git LFS 应已安装；需要安装时按所用系统的官方包管理方式准备。上述 Git 与工具准备命令用于引导环境；Apex 的开发入口仍统一使用 pnpm。

准备项目外、区分大小写的空目录后运行：

```sh
pnpm run oh:sync --source-dir <新的外部空目录>
```

获取过程使用 Repo 的静态 manifest 模式，按固定 commit 同步源码、下载 LFS 内容并获取上游子模块，最后运行完整校验。目标目录已有内容或 Repo 元数据时拒绝执行，也不能放在其他 Git 或 Repo 工作区内，避免重配已有工作区。失败留下的内容保存在外部目录供排查，不自动清空或覆盖。

已使用真实官方 Repo 2.54 验证静态 manifest 初始化与 518 个项目的清单解析。下载量和磁盘占用较大，本期未执行新机器完整源码下载。该项与已有源码校验分别记录，不能由脚本测试、清单解析或已有源码校验替代。

## 验证范围与后续工作

```sh
pnpm run verify
pnpm run test:oh
pnpm run oh:verify --source-dir <外部源码目录>
```

普通 CI 检查版本锁、官方 manifest 入口和脚本测试，继续运行 Harness 构建和默认测试，不下载完整 OpenHarmony 源码。完整源码校验在已有源码的环境执行，日志和报告保存在项目外。

本阶段建立 OpenHarmony 正式版源码基线及获取、校验入口。构建主机与 prebuilts 准备、构建工具链锁定、目标开发板适配、系统编译与启动、Harness 运行兼容性、Apex 插件集成仍待完成。源码版本锁不能单独证明系统镜像能够构建、启动或重复生成。

官方参考：[源码获取](https://github.com/openharmony/docs/blob/OpenHarmony-v7.0-Release/zh-cn/device-dev/quick-start/quickstart-pkg-sourcecode.md)、[Repo manifest 格式](https://gerrit.googlesource.com/git-repo/+/HEAD/docs/manifest-format.md)。官方文档中的主干获取示例不应替代本仓库锁定的正式版基线。
