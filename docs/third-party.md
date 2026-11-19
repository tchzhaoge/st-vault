# 第三方组件声明

**简体中文** · [English](third-party.en.md)

ST-Vault 原创源码采用 Apache-2.0。依赖和系统组件仍适用其各自许可，本仓库不重新授予或改变这些许可。以下说明不替代上游 LICENSE/NOTICE 原文。

- Node.js 与 npm：遵循官方 Node 镜像随附的上游声明。
- Fastify、React、Vite、Zod、Prettier、i18next、react-i18next：MIT。
- 时区计算使用 `@date-fns/tz`（MIT），随应用保留[上游许可](../licenses/date-fns-tz.txt)。
- node-postgres（pg）及其运行依赖：保留安装包内的上游声明。PostgreSQL 内置于运行和 QA 镜像，采用 PostgreSQL License；重新分发数据库镜像或二进制时保留 `/usr/share/doc` 中的声明。
- Hls.js、Playwright、TypeScript：Apache-2.0。
- Chromium（仅 QA）：来自 Debian 软件包，重新分发镜像时保留发行版组件声明并遵循各自许可。
- 运行时 FFmpeg：使用 Debian 修补的源码构建，禁用 GPL/nonfree 组件，采用原生解码器与 libdav1d，仅启用本地 MP4/JPEG 处理链。对应源码包、许可证和 configure 日志随镜像置于 `/usr/local/share/doc/ffmpeg`；可通过 Docker media-build 阶段的 `deploy/build-ffmpeg.sh` 重建。QA 使用 Debian 完整 FFmpeg，可能包含 GPL 组件。本项目不改变两者的许可。

第三方产品名称与 API 引用只说明兼容性，不代表隶属或背书。应用标识沿用原有 ST-Vault 项目资产；新增资产须确认权利后再提交。

准确版本见 package-lock.json；完整条款见各安装包的 LICENSE/NOTICE 及镜像中的 /usr/share/doc。
