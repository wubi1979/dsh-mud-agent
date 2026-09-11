# MUD Agent Preset 化重构计划

## Context（为什么改）

现架构中 mud-core 自建 agent（`ensureAgent`/`createMudAgent`，resume 同一 sessionId），与 webui 走官方 `sessions.create`/engage 流程创建的原生 agent 争抢同一会话的所有权——DSH 的写租约（防会话日志双写）使后到者失败，这正是"点击连接卡死、`判类注入暂缓 (agent 未创建)`"的根因。

用户拍板的架构原则：**agent 生命周期 100% 走原生官方流程**——创建用户=创建会话、点击用户=切换会话、重启后自动打开=原生恢复、点击连接=纯通网。mud-core 不再创建/持有 agent，改为官方 **agent preset** 机制（`mud-player`）把 mud 工具与人设挂到原生 agent 上；mud-core 只做感知判类注入（动态查 `ctx.agents.get(sid)`）。

已逐行验证的机制事实（deepseek-harness）：
- `SessionCreateRequest.agentPreset` host 侧已支持（[types.ts L264-276](file:///D:/Code/deepseek-harness/packages/api/session-controller/src/types.ts#L264-L276)、[commands.ts L81-124](file:///D:/Code/deepseek-harness/packages/api/session-controller/src/commands.ts#L81-L124)），但浏览器 client 三层（contract/service/manager）未透传——需补 3 处。
- 重启后 resume/adopt 均按**会话内存储的 preset** 重新挂载（[agent.ts L424, L459-461](file:///D:/Code/deepseek-harness/packages/api/session-controller/src/agent.ts#L424-L461)），`assertPresetUnchanged` 仅在"请求≠存储"时抛冲突。
- preset 的 agent.cordis.yml 中**只注册工具/section、不 provide 服务的 row 无需 isolate realm**，且可 `ctx.get` 宿主服务（standard preset 模板注释明确此模式）。
- `section()` 同名重复注册会抛错，但可先 dispose 再重注册（动态 skills 文本更新可行）。
- `agentPresets.composedPreset(agent.ctx)`（[agent-presets/src/index.ts L497](file:///D:/Code/deepseek-harness/packages/preset/agent-presets/src/index.ts#L497)）可用于 `agent/request` 监听器判断该 agent 是否 mud preset——修复"监听器劫持所有会话到 T1"的现存 bug。
- preset 行加载支持 `file:///` 绝对路径（`specifier.ts` 分类 + `PresetTree.import`）；mud-core bundle 行已用同模式。
- agent-presets `Config.roots` 为 `z.array(z.object({path, trust: 'system'|'user'}))`，profile patch 按 id 覆盖 config 即可追加 root。
- 现有 mud-core 测试不引用 `ensureAgent`/`createMudAgent`/`prepareAgent`，测试影响面小。

## 改动清单

### 1. mud-core 新增 agent-plane 插件：`src/preset-agent.ts`（新建）

导出插件 `mud-agent-tools`（agent realm 内 apply），镜像 [agent-bridge.ts createMudAgent setup L204-242](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/agent/agent-bridge.ts#L204-L242) 的注册逻辑：

```ts
export const name = 'mud-agent-tools'
export const apply = (ctx: Context) => {
  const kit = ctx.get('mud')!.agentKit()          // 宿主服务解析（standard preset 同款模式）
  for (const tool of Object.values(kit.tools)) {   // 与现 createMudAgent 相同的 defineTool 包装 + kit.onAgentTool 补记
    ctx.tools.register(defineTool({ ... }))
  }
  if (kit.persona) ctx.systemPrompt.section({ name: 'mud-persona', order: -100, text: kit.persona })
  if (kit.commands) ctx.systemPrompt.section({ name: 'mud-commands', order: -40, text: kit.commands })
  let skillsDisposer = kit.skillsText() ? ctx.systemPrompt.section({ name: 'mud-skills', order: -50, text: kit.skillsText() }) : null
  const unsub = kit.onSkillsChanged(() => {        // 动态技能目录: 先 dispose 再重注册（同名重复注册会抛错）
    skillsDisposer?.()
    skillsDisposer = kit.skillsText() ? ctx.systemPrompt.section({ name: 'mud-skills', order: -50, text: kit.skillsText() }) : null
  })
  ctx.effect(() => { unsub(); skillsDisposer?.() }, 'mud-agent-tools')
}
```

### 2. mud-core 新增 preset 目录：`presets/mud-player/`（新建）

- `preset.yml`：`name: MUD 玩家` / `description` / `order: 10`（对齐 standard preset 格式）。
- `agent.cordis.yml`：单行 `- id: mud-agent-tools` + `name: 'file:///D:/Code/dsh-mud-agent/packages/mud-core/dist/preset-agent.js'`。无需 isolate realm、不含 standard 编码工具。

### 3. mud-core `package.json`

- `exports` 增加 `"./preset-agent": { types: "./dist/preset-agent.d.ts", default: "./dist/preset-agent.js" }`。
- `files` 增加 `"presets"`（tsc 构建自动产出 dist/preset-agent.js，无需改 build 脚本）。

### 4. mud-core `src/agent/agent-bridge.ts`

- **删除** `createMudAgent` + `CreateMudAgentOptions`（L166-267）；`sendGameOutput` 若无引用一并删。
- `sendOwnedOutput`（L277-280）改签名：接收裸 Agent（`agent.id` / `agent.send`），不再要 AgentHandle。
- `registerTriggerProvider` 的 `agent/request` 监听器加 preset 门：`ctx.get('agentPresets')?.composedPreset(payload.agent.ctx) !== 'mud-player'` → 原样 `return config`（普通聊天会话不再被劫持到 T1）。新增常量 `MUD_PRESET_ID = 'mud-player'`。

### 5. mud-core `src/index.ts`（核心删改）

- **删除** `let agent: AgentHandle | null`（L169）及全部读写点；新增 `liveAgent()` 动态查找：`activeSessionId ? ctx.agents.get(activeSessionId) ?? null : null`。
- **删除** `ensureAgent`（L791-830，含 `[SYS] agent 创建开始/失败` 诊断日志）、`prepareAgent`（L874-883）、`/mud/prepare` HTTP 路由（L1071-1088）、`connect()` 内 `void ensureAgent(...)` 调用（L714-718）及相关注释（L189、L375、L714-716、L827）。
- `judgeAndInject`（L433-468）、`requestAgent`（L626-636）、`armLoginWatchdog`、`flushObserve` 门、`diag.agentReady`：全部改用 `liveAgent()`；注入暂缓日志语义不变。
- `skillService.onChange`（L536-553）：**删除 dispose agent 块**，改为通知订阅者列表（`skillsListeners`），供 preset 插件刷新 mud-skills section。
- 服务面（`ctx.provide('mud', service)`，L986）新增 `agentKit()`：
  ```ts
  interface MudAgentKit {
    tools: MudTools                       // 现 L496 buildMudTools 产物
    persona: string                       // config.persona
    commands: string                      // commandsTextForAgent()
    skillsText(): string                  // skillService.textForAgent()
    onSkillsChanged(cb: () => void): () => void
    onAgentTool(name: string, args: Record<string, unknown>): void   // 现 onAgentTool 回调逻辑
  }
  ```

### 6. mud-core `src/service.ts`

- 接口删 `prepareAgent`（L81）与相关注释（L75）；新增 `agentKit(): MudAgentKit`；`diag` 注释同步。

### 7. harness client 透传 agentPreset（D:\Code\deepseek-harness\packages\api\session-controller，3 处小改）

- [client/contract/sessions.ts L30-39](file:///D:/Code/deepseek-harness/packages/api/session-controller/src/client/contract/sessions.ts#L30-L39)：create opts 类型加 `agentPreset?: string`。
- [client/sessions/service.ts L394-410](file:///D:/Code/deepseek-harness/packages/api/session-controller/src/client/sessions/service.ts#L394-L410)：透传。
- [client/sessions/manager.ts L546-565](file:///D:/Code/deepseek-harness/packages/api/session-controller/src/client/sessions/manager.ts#L546-L565)：payload 加 `agentPreset`。

### 8. mud-webui `src/client/index.ts`

- L163 `sessions.create({...})` 增加 `agentPreset: 'mud-player'`。
- 删除 `addUser` 内 `fetch('/mud/prepare', ...)`（L203-207）并更新注释（L197-200：host 侧无需物化，preset 随会话创建）。

### 9. 部署 profile：`c:\Users\vicrly\.dsh\profiles\web\cordis.patch.yml`（现为 `[]`，替换为）

```yaml
- id: agent-presets
  config:
    default: standard
    roots:
      - path: 'file:///D:/Code/dsh-mud-agent/packages/mud-core/presets'
        trust: user
```

（id 定向覆盖 web-app bundle 的 agent-presets 行；`default: standard` 显式重述以兼容替换式合并；`includeShippedRoot`/`includeUserRoot` 走 schema 默认 true。）

## 验证

1. 构建：`pnpm --dir D:/Code/dsh-mud-agent -r build`；mud-core `npx tsc --noEmit` + `pnpm exec vitest run tests`（现有测试应全绿）。
2. harness client：构建 `@deepseek-ai/dsh-session-controller` 包（tsc）确认类型通过。
3. 运行时清单（用户执行）：
   - 重启 host → profile patch 生效（preset root 被发现）。
   - **新建** mud 用户 → 会话带 `mud-player` preset 创建（`agent-preset/selected` 事件）→ 点击用户 open+engage 占位回合 → T1 拒答收束（不耗真实 API）。
   - 点击连接 → 纯 telnet；登录流程 → `feedParsed` → 判类注入 → `liveAgent()` 命中 → T1 反射 / T2 推理（此前"agent 未创建"循环消失）。
   - **重启 host** → 点击用户 → resume 按存储 preset 重新挂载 mud 工具。
   - 普通聊天会话不受影响（preset 门：非 mud-player → 官方默认模型）。

## 迁移与风险

- **旧 mud 用户**（会话无存储 preset）：点击时 create 带 preset 会撞 `ApiSessionPresetConflict` → 走现有 catch 回退 open（agent 以 standard preset resume，无 mud 工具）。**迁移方式：删除旧用户后重新添加**（新用户生成新 sessionId，干净无冲突）。
- preset 行用绝对 `file:///` 路径，仓库挪动/换机器需同步改 agent.cordis.yml 与 profile patch（与现有 bundle 行同模式的既有取舍）。
- 动态 skills 刷新依赖 section dispose/重注册（同名重复注册抛错已规避）；若 `onSkillsChanged` 在 agent 已销毁后触发，disposer 调用需 try-catch 兜底。
