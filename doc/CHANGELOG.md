# mud-core3 变更记录

> 只追加，不回改历史行。仅正式实施的里程碑登记新条目；设计修订的最终结果并入对应条目，不单列。

## [v0.0.1]core2 作废，core3基线建立 (2026-09-28 10:10:13)
> 总结：确立初步计划

- core2 整体作废归档：文档移入 `doc/mud-core2/`（archived，仅追溯，不作实现/验收依据）
- 代码包 `packages/mud-core2` 原位退役：保留 workspace、不再演进；根 `package.json` 的 `test`/`dev:core2` 脚本仍指向它（遗留接线，core3 开工时一并调整）
- core3 最简版设计基线建立（§1–§5，见 `architecture/00-core.md`），未实施，待作者审阅后开工。基线最终口径（三轮审阅修订后）：
  - 实体：服务器 = 工作区 + 服务器字段（页面呈现沿用 mud-webui v1 不改，roster 键 = workspaceId）；账号只能建在服务器下
  - 会话 = 建账号时自动创建并绑定（sessionId = accountId）；使用者只见「服务器→账号」两级实体，无独立会话操作面
  - 连接：每会话独立 MUD 输入源；第一期手工 connect/disconnect；自动重连后置（热状态自动、冷启动不自动，前置 = 先实现真实心跳）
  - 一期目标 = MUD 信息进入 agent（等同人工提问）+ agent 回答：行流按静默窗口聚合后以用户消息投递进本会话（宿主 followup/steer 通道，与人工提问同路），触发回合产生回答；工具与流程全部后置（第一期零 MUD 工具，回答不回流 MUD）
  - 接入闸门：接入为显式动作、缺省未接入、水位 = 接入时刻不回放；停止接入 = MUD 信息不再进入 agent（投递停，行流照常积累 = 录制）；与 connect 正交（连接 + 未接入 = 录制/挂机模式）
  - 归属 = roster 判定（preset 退回纯账号属性，任选 preset 的账号均有 MUD 源）

## [v0.0.2]C1 骨架落地 (2026-09-28 12:40)
> 总结：link/ 移植完成，测试全绿

- 创建 `packages/mud-core3` 包骨架（package.json/tsconfig/vitest.config）
- 从 mud-core2 移植 `link/ansi.ts`（流式 ANSI/行解析器）、`link/telnet.ts`（telnet 协议层）、`link/corpus.ts`（JSONL 语料）——三文件零宿主依赖，原样移植
- `link/mud.ts` 从 core2 瘦身：去掉 read 竞速机（Holder/WaitOpts/ReadResult/read/abortWait/有界缓冲/判定序），只保留连接管理 + 行流分发（onLine 推送式）——竞速机是工具面依赖，第一期无工具面
- 回放用例：ansi 34 项、telnet 12 项、mud 9 项、corpus 3 项，共 58 项全绿；tsc + build 通过
- 根 `package.json` 的 `test` 脚本从 `mud-core2` 切换到 `mud-core3`

> AI生成
