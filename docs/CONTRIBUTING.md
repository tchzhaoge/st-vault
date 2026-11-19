# 开发与维护

**简体中文** · [English](CONTRIBUTING.en.md)

本指南介绍构建、测试、发布与恢复。使用方法和接口见[使用手册](../README.md)、[架构](architecture.md)和 [API](api.md)。

参与修改时请附复现、相关测试及风险说明，行为变更同步修改对应文档。安全问题按 [SECURITY.md](SECURITY.md)私密反馈。两份文件集中在 docs，并沿用 [GitHub 支持的标准命名和位置](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)，不在根目录保留重复入口。

## 仓库结构

| 路径                      | 内容                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/server`、`apps/ui`  | 服务端与前端；测试与所属模块相邻                                                         |
| `packages/api-schema`     | 共用类型与请求约束                                                                       |
| `deploy`                  | 唯一部署环境模板、Compose、Dockerfile、FFmpeg 构建                                       |
| `scripts`                 | 构建/检查入口；benchmarks 为性能实验，diagnostics 为显式网络诊断，maintenance 为历史迁移 |
| `tests`                   | e2e 合成浏览器场景、runtime 运行探针、deployment 生命周期验证                            |
| `docs`                    | 全部说明文档，无按开发阶段划分的子目录                                                   |
| `licenses`、`LICENSE`     | 必须保留的法律声明，不属于可丢弃开发产物                                                 |
| `.github`                 | CI 与按需浏览器回归工作流                                                                |
| `data`、`media`、`.local` | 忽略提交的正式状态、媒体和本机验证产物；不混入源码                                       |

根目录保留 npm/workspace 锁文件、TypeScript/ESLint/Prettier 配置、Git/Docker/editor 约束，避免为表面整洁增加自定义路径和工具参数。依赖只装在容器；构建输出 `build/`、`apps/ui/dist/` 不提交。

## 构建与检查

从仓库根执行，不挂载生产 data/media：

```sh
docker build --target qa -t st-vault:qa -f deploy/Dockerfile .
docker run --rm st-vault:qa npm run check
docker run --rm st-vault:qa npm run test:browser
```

`check` 包括格式、lint、文档链接与源码依赖边界、类型、工具/工作区测试和发布构建。QA 镜像内置临时 PostgreSQL，启用真实数据库集成测试；runtime 不带 npm、编译器或 Chromium。定向测试：

```sh
docker run --rm st-vault:qa npm test --workspace @st-vault/ui -- src/features/timeline/track-loader.test.ts
docker run --rm st-vault:qa npm test --workspace @st-vault/server -- src/database/postgres.test.ts
docker run --rm st-vault:qa node scripts/run-browser-tests.mjs onboarding snapshot-seek player-disconnect
```

浏览器 fixture 在独立端口生成合成 HLS/JPEG，禁止外部网站请求；产物在 `.local/qa/`，临时状态正常结束后清理。`STV_QA_KEEP_STATE=1` 仅用于显式保留排障状态。不要将私人数据库、Cookies 或录像放进测试。UI、删除、媒体和持久层变更须覆盖相关浏览器、取消、迟到响应、中断及重启场景。

只迭代源码时可将对应 `src` 只读挂进 QA，不能挂载整个 apps 目录覆盖镜像内 workspace 依赖。依赖或构建配置变化后重新构建。直接运行编译后的业务入口不负责启动数据库；正式启动使用 `apps/server/src/deploy/start.js`（发布目录内路径）。构建标识 `STV_BUILD_REVISION` 仅接受 40–64 位小写十六进制，发布时传真实提交 SHA。

本地候选镜像通过独立数据环境启动检查后，才用开发 override 部署：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.build.yml up -d --build
```

生产镜像生命周期验证使用 [lifecycle.ps1](../tests/deployment/lifecycle.ps1)，不连接正式数据。清理仅限已确认不用的验证产物和 Docker 资源；正式 data/media、必要回退备份与匹配镜像不能作为缓存删除。

## CI 与发布

项目从 `0.1.0` 起步。推送到 `main` 后，[CI](../.github/workflows/container-release.yml) 检查格式、类型、测试、构建、依赖和 Compose 配置。日常提交不用递增版本。

- **本地开发，集中推送**。所有改动直接在本地 `main` 完成并验证。日常小修可在本地分次提交，等维护者确认这一阶段的改动可以交付时，再集中推送到 GitHub 并确认 CI 通过。重大改动在本地对受影响功能做回归验证。
- **更新本地测试镜像**。改动运行代码、界面或镜像配置后，用当前代码重建并更新本地测试容器。构建时传入 `STV_BUILD_REVISION`，切换后核对实际运行的镜像提交和服务健康状态。继续使用测试实例既有的 Compose 参数与数据目录。仅改文档或 GitHub 工作流时，可直接验证文件。
- **推送即确认发布**。一次推送只验证该次推送后 `main` 的最终提交，历史中的中间提交随同上传。通过检查后，工作流以运行编号减一作为 `0.1.N` 的末位，将两个已验证的 Docker 架构合并到同一镜像标签。发布版本写入构建产物，源码版本文件无需逐次修改。仅需验证时，可在最终提交消息中加上 `[no release]`。
- **失败与重跑**。检查或镜像构建失败的运行可能留下版本号空档。重跑同一次 GitHub Actions 运行沿用该版本号。日常回退用 `git revert`，准备好后随下一次推送发布。

容器镜像及版本标签在 GHCR 的 Packages 中查看。镜像包公开后，用户可匿名拉取。GitHub Actions 展示自动检查和发布结果。

浏览器回归维持独立按需工作流，未改为自动发布门槛。不要将历史通过数量当作新提交的验收结果。改动说明应包含实际测试与未覆盖风险；凭据及真实业务数据不进提交或反馈。

## 旧部署升级

当前支持格式 1、业务元数据格式 5 的双目录 SQLite 库一次性导入 PostgreSQL。先正常停止旧应用，备份完整 data、media 和旧镜像；新镜像首次启动恢复已确认日志、冻结源库、导入校验并发布格式 2 检查点。冻结副本位于 `data/backups/postgresql-<库UUID>/<代际>/`，不能代替视频备份。需为旧库、副本、新集群、暂存表和 WAL 留足空间，不要在大库首次导入时反复强制重启。

旧单目录布局必须先使用匹配历史镜像中的 [migrate-library.mjs](../scripts/maintenance/migrate-library.mjs) 转成两个独立目录；不要直接用当前 latest 操作不匹配的旧库。工具要求正常关闭的格式 5 源，目标彼此独立且不在源内；同盘硬链接、跨盘复制校验，中断可重跑，保留源用于回退。

旧镜像不能读取新格式或反向接纳新版本写入。跨格式回退须恢复同一停写时点的双目录与配套镜像，仅换镜像不够，元数据也不能恢复已经释放的媒体。已有密码的实例须验证原密码一次后设 PIN，不重新开放无验证初始化。

## 性能边界与诊断

使用 `scripts/benchmarks` 的合成数据，记录 CPU/内存、存储、样本量、预热与测量范围。日志将数据库池等待、SQL 执行和 RPC 往返分开，不能把所有等待归因于 SQL。真实网络诊断在 `scripts/diagnostics`，显式启用，不进入默认离线 CI。

仍需量化的边界：运行中 RPC/SQL 不随浏览器取消即时中止；控制类录制前置读有独立准入语义，不能直接挪入普通 UI 限流；历史截图发现速率、精确播放订阅、全高网格与 SSE 重复失效仍可能有成本。当前只读 SQL 期限不是整请求期限。密集时间线在软件渲染环境仍可能产生长任务，软件浏览器实验不能换算为真实硬件加速设备的帧率。
