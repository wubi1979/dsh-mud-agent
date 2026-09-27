---
sections: ["附录A", "附录B"]
status: active
note: 引用性材料（官方机制锚点、抓包事实）
---

## 附录 A：官方机制引用（文件锚点）

| 机制 | 位置 |
|---|---|
| `blank` 由首个 `turn/start` 翻转 | `packages/api/session-controller/src/list.ts:50` |
| `agent/request` 是"替换本次调用配置"的官方扩展点 | `packages/core/agent/src/runtime-types.ts`（JSDoc） |
| per-session 模型选择会覆盖请求 | `packages/core/agent/src/model-selection.ts:91-107` |
| `selectModel` 改写部署默认模型 | `packages/api/session-controller/src/commands.ts:151-158` |
| sessionController 可作宿主服务调用 | `packages/client/ui-deliverables/src/present-open.ts` |
| `agent/pre-step` payload 带认领消息 | `packages/core/agent-loop/src/agent.ts:250` |
| 请求上盖 `sessionId` | `packages/core/agent-loop/src/agent.ts:614` |
| client `ISessions` 无删除会话接口（只有 create/open/clear/fork） | `packages/api/session-controller/src/client/contract/sessions.ts:35-122` |
| 删除会话的官方替代：归档（界面隐藏，文件与记账保留） | `packages/api/workspace-controller/src/client/service.ts:114`、`packages/api/workspace-controller/src/commands.ts:153`、`packages/client/ui-workspace/src/client/navigation.ts:242` |
| waterfall 先注册者最后拍板 / `prepend` | `vendor/cordis/src/events.ts`、`core/scope/src/index.ts:170-185` |
| 审批与档位（approval/presets/sandbox） | `packages/interaction/user-approval`、`permission-presets`、`sandbox/*` |
| preset 组合与门控 | `packages/preset/agent-presets/src/index.ts`（`composedPreset`） |

## 附录 B：抓包事实（保留要点）

- 登录：`您的英文名字：`（短形态）/ `您的英文名字（要注册新人物请输入new。）：`；密码提示 **`此ID档案已存在，请输入密码：`**；同名在线确认 **`您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)`**（实录 2026-09-11 —— 该句不含"同名/覆盖/替换"，旧关键词集必然漏匹配）；完成 `目前权限：(player)`。
- GA 与命令 1:1（21/21），GA 延迟 1–602ms（≪ 2s 静默窗）。
- 长程命令（`dz`）：受理帧 GA + prompt 后 **56 批 / ~57s 无 GA 无 prompt**，完成句与末条推送同块。
- 分页：每页独立命令 + 独立 GA；页尾为 `== 未完继续 88% ==` 换行行，非 prompt。
- 服务器**不回显**命令（密码明文泄漏只在本机 echo/日志）。

