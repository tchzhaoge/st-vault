# HTTP 接口参考

**简体中文** · [English](api.en.md)

这些接口服务于同仓库工作台，尚未承诺独立公共 API 的版本兼容。请求约束以 [api-schema](../packages/api-schema/src/index.ts) 和对应 HTTP 模块中的 Zod schema 为准。时间均为 UTC epoch 毫秒，ID 使用 `stripchat:<providerId>`；界面按 `/api/session` 返回的 `timeZone`（部署 `TZ`）显示；日历查询允许最多 8 个 UTC 日以覆盖夏令时回拨后的 7 个当地日。

除健康、静态资源和本地登录/初始化入口外，业务接口要求管理员会话。常规状态响应不返回地址密钥。管理员可通过 HTTPS 或受信任的本地连接使用 `GET /api/keys/current` 查看当前密钥，使用 `PUT /api/keys/current` 提交 `{name, value}` 以添加或更换。该接口响应禁用缓存。修改请求校验 Origin，敏感接口禁用缓存。

## 会话与账户

| 方法和路径                             | 行为                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/session`                     | 读取管理员认证与初始化阶段                                                                                                    |
| `POST /api/setup/session`              | 获取受限初始化许可；旧部署需验证原密码                                                                                        |
| `POST /api/setup`                      | 提交 `{pin}` 完成初始化，不要求账户连接                                                                                       |
| `POST /api/login` / `POST /api/logout` | PIN 解锁、撤销当前会话                                                                                                        |
| `GET /api/account-sync`                | 账户资料和同步状态，无凭据                                                                                                    |
| `PUT /api/account-sync`                | 导入 `{cookiesText, origin}`                                                                                                  |
| `DELETE /api/account-sync`             | 断开并返回 `{status, draft}`；draft 为原 `{cookiesText, origin}` 或 null，供浏览器保存站点绑定草稿；要求 HTTPS/回环且禁止缓存 |

初始化许可只用于完成 PIN，不可访问账户、录像或设置。没有原站账号密码登录、验证码任务或直接清单导入接口；账户仅通过粘贴 Cookies 接入。实现见 [http/app.ts](../apps/server/src/http/app.ts)。

账户接口仅允许已解锁的管理员会话，返回 `Cache-Control: no-store, private`。导入未提供来源时沿用当前来源，未连接则使用默认值；登录后绑定域名，不接受不同域名的更新（409 account_origin_locked）；退出后可重新选择。网站测速也受相同连接锁约束。退出通过持久化空清单提交归档全部主播并停录，重启后继续恢复，录像保留。

## 工作台与媒体

| 接口组 | 入口与契约                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| 主播   | `GET /api/subjects`；单主播/批量策略 PATCH；`PUT /api/subjects/recording-default` 保存 `{enabled}` 并应用到全部未归档主播 |
| 时间线 | `GET /api/workbench` 聚合可见行；单主播 timeline、coverage、recording-bounds                                              |
| 直播   | `POST /api/subjects/:id/live`；live-progress；会话 manifest/media；DELETE 关闭                                            |
| 回放   | `POST /api/playback`；会话 seek、close、manifest 和授权媒体读取                                                           |
| 图片   | preview/avatar JPEG、snapshot-pages、单元 JPEG                                                                            |
| 历史   | events、events/meta、events/runs、events/read                                                                             |
| 网络   | network/routes 读取/更新 HLS CDN；network/probe 手动测试 CDN 或登录候选站点                                               |
| 管理   | system、settings、keys、me/favorites                                                                                      |

`GET /api/network/routes` 返回可选节点 `cdnHosts`、已选节点 `preferences.cdnHost`、生产者已解析的节点 `activeCdns` 和手动测速状态 `cdnProbe`。保存不同节点后，各直播生产者立即取消旧节点请求并连接新节点。

`POST /api/network/probe` 接受 `{kind: "cdn", subjectId?: string}` 或 `{kind: "sites"}`，返回 202 后可通过统一刷新读取进度。CDN 测速可在未播放时运行。`sites` 仅在账户未连接且无同步任务时可用。绑定站点的实际访问状态由 `sites.access` 独立报告。

直播会话绑定管理员拥有者，回放读取受会话、范围及逻辑删除约束。图片按版本缓存；截图待生成时返回 202，不应解释为永久缺失。

`POST /api/playback` 的 `gapPolicy` 支持 report、next、previous 和 next-or-previous。删除后重建使用 next-or-previous：先根据现存完整单元收缩指定范围，在范围内优先后续画面，游标超出剩余尾部时定位到最后可用时刻；没有后续画面时允许前一段。指定 unitId 的读取仍严格按单元身份定位，不替换为其他单元。固定范围为空返回409 coverage_gap，客户端直接呈现原选区为空，不再查范围外的边界。普通 next 请求仍不回退，防止录像续播在末尾循环。

`GET /api/subjects/:id/snapshot-pages` 使用 `at`、`from`、`to`、`page`、`limit` 查询，`limit` 上限1000（界面固定30格），可选 `unitId` 返回精确的 `playbackUnitPage`；`follow=1` 表示直播尾部跟随，`page=last` 直接读取最后一页。响应的 `items` 是录像单元，`total` 是实际展示范围内可见的单元数，不要求 JPEG 已生成。`cells` 给出 `unit`、`gap` 或 `pending` 格位，`slotCount` 是压缩后的总格数，`pageOffset` 是本页起始格位；空档不计入总张数，也不能被喜欢或删除。小于一分钟空档不占格，一至两分钟一格、两至三分钟两格、更长最多三格，不生成全空页。`pages` 对应本次 `limit`，`occupiedPages` 和 `pageAnchors` 提供30格导航及时间定位，不能再用经过的分钟数推算页码。直播从尾部最多保留30格，去除起始空档，并将 `displayWindow.fromMs` 和 `session.selectionFromMs` 对齐到首个保留完整单元的起点；`displayWindow.toMs` 保留请求右边界。客户端展示与批量选择使用实际范围，不选中窗口外单元；回放仍保留整个请求范围的分页。普通与全屏共用相同直播边界、单元身份与30格分页读取，滚轮只切换当前页，不加载历史前缀。

响应必带 `deletionRevision`，直接使用该主播删除世代，覆盖删除接受和保留清理墓碑，不随普通录制分片增长。客户端不能混合不同删除世代的展示块；观测到较新世代后淘汰旧缓存，拒绝迟到旧包。范围操作与有界展示缓存分离。“取消所有喜欢”使用服务端冻结范围令牌；“删除所有非喜欢”直接提交持久范围意图。两者覆盖整个当前时间范围而非当前页，浏览器不下载完整目录、不维护多选成员；个人revision和删除世代过时返回409，不暗中重建令牌扩大操作范围。

实现入口：[直播](../apps/server/src/http/live.ts)、[图片](../apps/server/src/http/previews.ts)、[工作台](../apps/server/src/http/workbench.ts)、[历史](../apps/server/src/http/events.ts)、[网络](../apps/server/src/http/network-routing.ts)。

截图的 `unitId` 是完整源分片成员集合的稳定身份，`slotFromMs` / `slotToMs` 是该单元真实完整范围，`open` 表示尚可增长，`atMs` 是稳定的代表取样锚点。一个源分片即使跨过自然分钟也不拆分；视窗只决定哪些单元相交，不改写它们的边界。JPEG URL 的 `to` 是稳定解码搜索上限，实际解码仍限制在对应单元内；追加分片不反复换URL或重采样。`gridIndex` 是服务端布局位置，不能从 `atMs / 60000` 反算。

`recording-bounds` 把拖动选区向外吸附到首尾相交完整单元。直播当前时刻、实际播放游标和已落盘末端分离；开放单元回放的 `openUnitId` 用于继续等待同一单元的新成员，不把之后无关录像自动纳入已选范围。

覆盖桶在有媒体时附带 `mediaFromMs` / `mediaToMs`，表示桶内实际有画面的最早、最晚时间；空桶不带这两个字段。它们复用分钟覆盖索引与逻辑删除投影，供覆盖绘制和滑选即时反馈共用，不增加持久格式。桶内可能仍有碎片空隙，选区最终通过 `recording-bounds` 精确核验，不能用桶的首尾推断其内部全部连续。

悬浮预览使用 GET /api/subjects/:id/snapshot-point?at=<毫秒>，只返回一个单元或null；旧的全范围snapshots列表接口已移除。回放创建可带unitId，在相同PDT的多个单元中精确定位；显式单元不存在时拒绝，不退回猜测时间归属。普通录像覆盖读取不计算或返回 protectedSpans。只有未发布删除可见性版本的非喜欢删除任务，才通过工作台 protection 主播 ID 参数按需请求有界保护摘要；与 seenSpans 在同一读取快照返回，可复用按媒体版本与收藏版本区分的缓存。点击删除立即复用截图区已加载的收藏范围，无需等待该查询；任务发布版本或失败、结束后停止请求。服务端删除仍独立核验完整收藏关系，前端摘要不决定删除许可。不绘制独立喜欢标记，也不作为编辑边界。

## 后台运行状态

`GET /api/system` 保留原有健康、磁盘、录制和截图数据，并返回 `capturedAtMs`、`backgroundTasks` 与 `ingress`。任务项包含稳定 `id`、分组 `group`、状态 `state`，以及可选的最近执行/成功/下次调度时间、已处理量、总量、待处理量和失败量。没有总量时不能由客户端推算百分比。`target` 仅用于公开接入点的主机名及延迟，不包含凭据、媒体地址或本地路径。`ingress` 是共享直播入口的当前主播数、保留字节与内存预算。

状态读取不启动任务，不扫描整个录像或截图历史。某个观测源失败时保留其他源的结果，该任务以 `task_status_unavailable` 标记；同一失败周期只记录一次诊断及一次恢复事件。浏览器复用统一时钟和 SSE 失效更新，不为状态面板建立额外轮询。具体任务见[后台任务参考](architecture.md#并行与任务调度)。

## 批量喜欢与删除

`POST /api/subjects/:id/unit-seen` 接收 `{evidence:[{unitId,toMs}]}`（1–100 项），将该主播可见单元的 `seen_to` 单调推进到已展示边界，并截断至已提交媒体终点，返回 `{changed}`。截图区在加载开始时冻结边界，实际图片显示成功后合并上报；预取、悬浮预览不调用。增长和元数据刷新不扩大已看范围，旧请求不能回退边界。`unit_seen_ranges` 经媒体库持久日志保存，不修改喜欢 revision，不参与保留保护。覆盖响应增加 `seenSpans`，最多按查询桶数聚合，混合桶优先未看；仅供着色，不能作为选择或删除边界。客户端使用独立 `seen` 通知刷新时间线，避免重载截图目录；其他客户端沿统一心跳读取。

网页删除统一使用 `POST /api/subjects/:id/deletion-intents`，提交 `{commandId,target}`。`commandId` 为 UUID；target 共同包含 `fromMs,toMs`，并按 kind 指定 `units + unitIds`、`selection + selectionId/patch` 或 `range + mode(all/unliked)/baseSelectionId/patch`。202 表示意图已写入媒体库日志，准备和删除均由后台接手，逻辑隐藏即刻生效。相同键与同一目标返回原任务；不同目标复用键返回409。`GET /api/media-deletions` 同步 preparing/queued/running/retry/completed/failed、phase、scannedUnits、selectedUnits和删除版本，准备中不要求已知总量。见[持久命令](architecture.md#录像单元与前端一致性)。

以下精确集合与计划接口仍可用于程序化检查；网页不再等待其预览或统计：

1. `POST /api/subjects/:id/media-selection`：提交 `{fromMs,toMs,mode}`，mode为 `all`、`unliked` 或 `explicit`；可带baseSelectionId进行并集，及includeUnitIds/excludeUnitIds。后台每批256单元准备冻结集合，返回id、count、personalRevision和deletionRevision。准备取消不会提交修改。
2. `POST /api/subjects/:id/media-selection/:selectionId/favorites`：提交 `{liked,revision}` 和可选增删例外。持久接纳命令后立即返回；逻辑喜欢投影即时生效，物理标记每批256项整理，重启继续。每个非空接受命令只推进一次revision；count及旧removed字段表示请求目标数，不表示每项都发生物理变化。
3. `POST /api/subjects/:id/delete-selection/preview`：提交selectionId或unitIds，两者互斥；冻结完整单元身份，返回影响范围、计划和个人revision；旧ranges HTTP输入明确拒绝。大集合准备也分批让行。
4. `POST /api/subjects/:id/delete-selection`：提交 `{planId,personalRevision}`，202表示已接纳。逻辑隐藏立即生效，回收后台分批执行；`GET /api/media-deletions`读取进度和重试状态。
5. 当前页操作仍支持 `POST /api/subjects/:id/unit-favorites/query` 与 `POST /api/subjects/:id/unit-favorites`（unitIds、liked、revision），及 `DELETE /api/me/favorites/:id`。它们消费同一喜欢命令所有者，不绕过逻辑投影。

接受和保留清理在同主播写序列中协调；已接纳喜欢在物理整理之前就保护整个单元，包括后续追加成员。取消喜欢后重新适用保留规则，不立即删除录像。明确确认的手动删除仍可删除喜欢画面；逻辑已删除单元不继续出现在个人喜欢和覆盖摘要中。其他客户端改变个人revision或删除世代时返回409，必须重新确认，不能默默扩大原操作。

显式ID数组最多100000，作为HTTP载荷保护；服务端冻结选择不要求把整个选区编码为该数组。主体选择范围最多9天，以容纳界面7天视窗向完整单元外扩。确认删除时补入开放单元最新成员并封闭目标，后继新录像不进入旧计划。已接纳操作独立于浏览器继续；关闭页面不回滚持久意图。

实现：[媒体选择](../apps/server/src/http/media-selection.ts)、[选择存储](../apps/server/src/archive/media-selection-store.ts)、[喜欢命令](../apps/server/src/archive/favorite-commands.ts)、[删除](../apps/server/src/archive/deletion-store.ts)。

## 错误与取消

业务错误返回稳定错误码，由前端统一翻译。401 为会话失效，参数错误不应无限重试；429 按响应限流信息处理。网络/服务错误按各自任务边界有界重试。请求取消不能回滚已经持久接纳的删除任务。

较重元数据读取达到准入上限时，返回 503 `{error: 'archive_busy'}` 与 `Retry-After: 1`。客户端应保留已有内容并按提示有界重试；未向 worker 发送的读取可以拒绝，已接纳写入不会因该保护超时或取消。

修改接口时同步更新 schema、服务端、客户端和边界测试；不要让某个错误被解释为虚假的离线状态、无录像或成功删除。

浏览器统一将读取请求限定为 15 秒、修改提交限定为 30 秒。修改请求遇到传输失败或无法确认结果的服务错误时，不自动重放，也不把客户端超时解释为服务端回滚；先释放交互锁，再限时回读当前事实。截图喜欢按单元ID回读，删除通过已提交计划ID观察持久任务；未查到结果仍表示未知，不表示确定未执行。明确拒绝准入的 archive_busy 返回503，由界面提示稍后再试。

单张喜欢的单元保护查询有15秒准备预算；切换选区或卸载时取消准备，迟到读取不能继续提交。准备失败表示尚未提交写入；已提交POST独立使用修改预算，不继承准备阶段的取消信号，也不自动重放。

可重建播放会话通过请求选项 operation=session 显式保留原始传输/服务错误，沿用播放器已有的有界预备重试；该选项不会发送给服务器。会话请求中止与响应未完成时服务端负责回收，另有会话 TTL 和数量保护。持久收藏/删除不使用此策略，未知结果不会进入会话重试。
