/**
 * mud-commands — 命令判据总表（T28 拆包）：五分组条目 + 装配器 + 解析单点。
 * 构建期装配（DEC-18 fail-loud），运行期零注册面；`resolveAwaitPlan` 为工具面
 * 与流程缝共用的唯一解析单点（DEC-21）。T29：条目 `capture` 字段（捕获契约归
 * define.ts、六套格式随条目就地定义于分组文件），装配汇出 COMMAND_CAPTURE_RULES
 * 供 tracker 只引用。
 */
export * from './define.ts'
export * from './assembler.ts'
export { STD_COMMANDS } from './std.ts'
export { SKILL_COMMANDS } from './skill.ts'
export { USR_COMMANDS } from './usr.ts'
export { STUNT_COMMANDS } from './stunt.ts'
export { PROFESSION_COMMANDS } from './profession.ts'
export { TASK_COMMANDS } from './task.ts'
