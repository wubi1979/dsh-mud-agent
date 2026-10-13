# mud 组

MUD 域包容器（T28 拆包，对齐宿主官方插件组织规则：组=纯容器，无 package.json、无源码，包恰在本目录下一层）。

| 包 | 角色 |
|---|---|
| `mud/` | 会话引擎核心（编排：service/runtime/accounts/store/deliver/llm-gate/log/screen） |
| `mud-link/` | 连接协议 Provider（叶子） |
| `mud-sense/` | 行流感知纯层（T28.2） |
| `mud-commands/` | 命令判据总表 · 库（T28.2） |
| `mud-combat/` | 战斗 Provider（T28.3） |
| `mud-nav/` | 导航 Provider（T28.3） |
| `mud-flows/` | 流程 Provider（T28.3） |
| `tool-mud/` | 组合根 + 工具面 Consumer · 唯一 bundle（T28.5） |

依赖单向：`tool-mud → mud* `；providers 零 mud 依赖（PLAN.md T28 D9/3.2）。实施进度见 `doc/PLAN.md` T28 计划。
