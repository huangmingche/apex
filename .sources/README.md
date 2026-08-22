# .sources

上游源码存放约定的说明目录，当前只保留说明文件。完整 OpenHarmony 源码保存在项目目录之外，不放入这里，也不作为根 workspace 的包。

- 官方来源及版本由 `openharmony-source.lock.json` 与 `manifests/openharmony-7.0.xml` 记录；`dsh-source.lock.json` 只记录 DeepSeek Harness。
- 外部源码目录通过命令参数指定，个人路径不写入版本锁。
- 上游代码的许可与版权归上游所有，不修改其内容。
- 获取、校验和复用步骤见 [OpenHarmony 源码说明](../docs/openharmony.md)。
