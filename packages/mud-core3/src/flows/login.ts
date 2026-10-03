/**
 * flows/login — 登录流程实体（locked 预制，全系统唯一凭据流程）。
 *
 * 流程实体归 core3（2026-10-01 用户裁定：core 定义数据，mud-workflow 子包是
 * 纯架构——schema/注册表/解释器/工具面，不含任何具体流程）。core3 经
 * `ctx.provide('mudCore3', { builtinFlows: [login] })` 把实体交给 mud-workflow
 * 注册表挂载（registry.registerBuiltins，fail-loud 校验）。
 *
 * 本体 = JSON 声明式步骤表（TS 字面量承载——编译期类型检查 + lib/ 产物天然
 * 携带；语义与 .json 等价，agent 侧看到的 get/save 面是纯 JSON）。判据取自
 * [doc/flows/login.md](../../doc/flows/login.md)（7 步 + success 出口）与
 * [doc/appendices/A-capture-facts.md](../../doc/appendices/A-capture-facts.md) 实测定稿。
 * 实测勘误（2026-10-03 实机勘误见附录 A.1 硬约束 ③）：
 *   - 「欢迎来到」成功句**不可用**（与建连横幅「欢迎来到北大侠客行」撞车，
 *     登录前即到达会把横幅误判成成功）——成功句以「目前权限：(player)」
 *     「重新连线完毕」为准；
 *   - 判据一律 `^` 行首锚（防聊天语句误触发）⇒ 相关步 wait 必须 `flags: 'm'`
 *     （整窗按行 join 匹配，无 'm' 时 `^` = 窗首，提示行在横幅之后永不命中）；
 *   - need-new 实机整句内嵌**动态用户名**（`使用\S+创造`），`(yes)` 括号须转义。
 *
 * 步表（动作在路由前执行，条件发送 = 独立步骤）：
 *   prompt-name   等名字提示 → 发 {name}
 *   prompt-pass   等密码提示（failOn 用户名不存在/非法整句 → need-new 出口）→ 发 {pass}
 *   confirm       等「替换 | 成功句」（failOn 密码错误类 → bad-pass 出口）；
 *                 replace 命中 → replace 步，否则 → send-empty
 *   replace       发 y（login.md replace 步 action=y，默认应答）
 *   wait-success  等成功句
 *   send-empty    终态空命令（走凭据通道不进发送回显）
 *   wait-ga       空命令收 GA = 登录真的收尾了的确认 → success 出口
 *
 * 连接守卫不在本表：流程执行以已建立连接为前提（core3 workflowEnvFor 缝在
 * env 注入前拒绝未连接，等待以连接为前提——未连接时 driver 永远不会到达）。
 * 凭据占位 {name}/{pass} 由引擎注入替换，不经模型；结果行由解释器出口统一
 * 过 pass 掩码。验证码链路不进流程（流程不能等人工），人工环节留在 agent 层；
 * 失败不设恢复路径（用户名/密码是人工给的，流程不自作主张重试）。
 */

// 流程词汇表类型由 mud-workflow 提供（type-only import，编译后无运行时依赖；
// core3 devDep mud-workflow，依赖方向 = 数据侧引用架构侧的词汇表）。
import type { WorkflowRecord } from 'mud-workflow'

/** 步预算（login.md：流程级缺省步预算 30s，终态收尾 5s 兜底）。 */
const STEP_MS = 30_000
const SUCCESS_MS = 5_000

// ── 判据（login.md 定稿 + 实测勘误，见文件头）────────────────────────

/** 步 1 driver：英文名字提示（实机单形态；^ 行首锚防聊天误触发，配 flags 'm'）。 */
const NAME_SRC = '^您的英文名字（要注册新人物请输入new。）：'
/** 步 2 fail：用户名不存在/非法 → 实质失败（need-new；`\S+` = 实机整句内嵌的动态用户名，2026-10-03 实机勘误）。 */
const NEED_NEW_SRC = '^同意玩家须知并使用\\S+创造一个新的人物，您确定吗\\(yes\\)？|^对不起，你的英文名字只能用小写英文字母。'
/** 步 2 driver：密码提示（实机单形态；裸「请输入密码：」不作判据，防误触发）。 */
const PASS_SRC = '^此ID档案已存在，请输入密码：'
/** 步 3 fail：密码错误类（login.md 字面三条，'m' 多行锚；实测密码错常表现为服务器直接断连 → 走 timeout/断线路）。 */
const BAD_PASS_SRC = '^密码错误！|^密码不正确|^如果帐号用register命令注册过，并且密码已经忘记，请按照'
/** 步 3 分支 driver：替换在线人物提示（login.md 字面全句）。 */
const REPLACE_SRC = '您要将另一个连线中的相同人物赶出去，取而代之吗？\\(y\\/n\\)'
/** 步 3/5 成功句（两条定稿判据；「欢迎来到」勘误见文件头）。 */
const SUCCESS_SRC = '目前权限：\\(player\\)|重新连线完毕'

/** 登录流程（locked；经 mudCore3.builtinFlows 交 mud-workflow 注册表挂载，agent 拒改拒删）。 */
export const login: WorkflowRecord = {
  name: 'login',
  title: '登录（提示符驱动，凭据由系统注入）',
  locked: true,
  version: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  flow: {
    entry: 'prompt-name',
    steps: [
      {
        id: 'prompt-name',
        wait: { until: [NAME_SRC], flags: 'm', timeoutMs: STEP_MS },
        action: { sendCredential: '{name}' },
        next: { goto: 'prompt-pass' },
      },
      {
        id: 'prompt-pass',
        wait: { until: [PASS_SRC], failOn: [NEED_NEW_SRC], flags: 'm', timeoutMs: STEP_MS },
        onFailOn: { '0': { exit: { stage: 'need-new', ok: false } } },
        action: { sendCredential: '{pass}' },
        next: { goto: 'confirm' },
      },
      {
        id: 'confirm',
        wait: {
          until: [REPLACE_SRC, SUCCESS_SRC],
          failOn: [BAD_PASS_SRC],
          flags: 'm',
          timeoutMs: STEP_MS,
        },
        onFailOn: { '0': { exit: { stage: 'bad-pass', ok: false } } },
        branch: [{ goto: 'replace' }],
        next: { goto: 'send-empty' },
      },
      {
        id: 'replace',
        action: { send: 'y' },
        next: { goto: 'wait-success' },
      },
      {
        id: 'wait-success',
        wait: { until: [SUCCESS_SRC], timeoutMs: STEP_MS },
        next: { goto: 'send-empty' },
      },
      {
        id: 'send-empty',
        action: { sendCredential: '' },
        next: { goto: 'wait-ga' },
      },
      {
        id: 'wait-ga',
        wait: { gaCount: 1, timeoutMs: SUCCESS_MS },
        next: { exit: { stage: 'success', ok: true } },
      },
    ],
  },
}
