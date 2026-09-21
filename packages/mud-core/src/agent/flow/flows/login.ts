/**
 * dsh-mud-core — 登录流程表 (flows/login)。`doc/ARCHITECTURE.md` §11 / `doc/flows/login.md`。
 * @module @deepseek-ai/dsh-mud-core/agent/flow/flows/login
 */

import type { FlowSpec } from '../flow-spec.ts'

/**
 * 登录流程（`doc/flows/login.md`）。
 *
 * 实录/待实录标注：`(估计)` = 按规则意图给的估计形，拿到实录原文后替换。
 */
export const LOGIN_FLOW: FlowSpec = {
  id: 'login',
  // 不可打断：没有任何规则的 interrupts 能高过 1000（§19.4）。
  priority: 1000,
  // 只在未登录时 arm 入口（已登录后同形文本不再触发登录流程）。
  when: world => world.flags.logged_in !== true,
  entry: 'name',
  timeoutMs: 30_000,
  // 失败一律**只留痕不唤醒 T2**（作者定案 2026-09-13）：用户名/密码是人工给的，T2/用户都补不了；
  // 服务器异常（成功句不来 / 断线）也不是模型能处理的。因此不做恢复路径，只写日志 + 决策记录。
  failPolicy: { notify: 'none' },
  steps: [
    {
      id: 'name',
      driver: {
        kind: 'regex',
        patterns: [
          /^您的英文名字（要注册新人物请输入new。）：$/,
          /^您的英文名字[：:]\s*$/,
        ],
      },
      action: { tool: 'mud_send', args: { cmd: '{name}' } },
      // **本步不写 `ok`**（作者定案 2026-09-13）：本步的结果就是**下一步的新文本** ——
      // "此ID档案已存在，请输入密码："既是 `pass` 的进入判据（driver），也就是 `name` 的成功判据
      // （§19.2：命中后继 driver ⇒ 本步成功 + 走该分支）。判据只写一份，不在这里重复声明；
      // 写成 `ok:[GA]` 反而会让"命令被接受"抢先判定，把密码提示行消费掉、走不到 pass。
      fail: [{ kind: 'text', includes: ['需要创建新人物'] }],   // (估计) 用户名不存在 → 实质失败, 中断流程
      next: ['pass'],
    },
    {
      id: 'pass',
      driver: {
        kind: 'regex',
        // 抓包字节实证 (2026-09-10, 8081 老号复登): "此ID档案已存在，请输入密码："；
        // 兼容旧估计前缀 "ID已存在，" 与裸形态 (三者都收)。
        patterns: [/^(?:此ID档案已存在，|ID已存在，)?请输入密码[：:]\s*$/],
      },
      action: { tool: 'mud_send', args: { cmd: '{pass}' } },
      fail: [
        // 密码错误提示 (估计形态, 原文待作者核对)。实测上密码错常表现为**服务器直接断连**，
        // 那条路走桥的 `error`（写失败/连接断开）→ 同样失败收束，不依赖这里的文本。
        { kind: 'regex', patterns: [/^密码错误[^]*$/, /^密码不正确[^]*$/, /^登录失败[^]*$/] },
      ],
      // 本步同样**不写 `ok`**：它的结果就是下一步的新文本 —— "替换人物"句 → `replace`，
      // "目前权限：(player)"/"重新连线完毕" → `success`。两个后继都带 driver ⇒ 都是条件分支，
      // 谁的行先到谁生效；两条都不来则本步超时失败收束（不静默）。
      next: ['replace', 'success'],
    },
    {
      id: 'replace',
      driver: {
        kind: 'regex',
        // 实录 (2026-09-11, 同名在线): "您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)"
        // —— 旧关键词集 (同名/覆盖/替换/已被占用) 全不在该句里；以实录句为准，
        // 且不要求同行 y/n（服务器可能把 "(y/n)" 折到下一行）。
        patterns: [/^您要将另一个连线中的相同人物赶出去，取而代之吗？\s*(?:[（(]\s*[yY]\s*[/／]\s*[nN]\s*[）)]\s*)?$/],
      },
      action: { tool: 'mud_send', args: { cmd: 'y' } },
      // 作者定案 2026-09-13：答完 `y` **不再回头要密码**，直接等"已进入游戏"的成功句。
      next: ['success'],
    },
    {
      // 终态步（作者定案 2026-09-13：login 精简为 4 步）：**看见"已进入游戏"的成功句**才算登录完成
      // （与旧设计同一判据，只是判据从"判定节点"挪到本步 driver）→ 置位已登录 + **发一个空命令**收尾。
      //
      // 为什么发空命令而不是 `look`：① 空行足以"顶"开服务端（登录后不发命令则输出要等约 5 分钟，
      // 实测）；② MXP 检测模式**发任何命令都能跳过**，空行同样有效（不再需要单独的 `mxp` 步）；
      // ③ 模型接管后的第一屏由 T2 自己决定（不必我们替它 `look`）。
      // 到达路径（作者定案 2026-09-13 的步骤图）：`name → pass → [replace | success]`，
      // `replace → success` —— 即"成功句"是 `pass` 与 `replace` 的条件分支后继。
      id: 'success',
      driver: {
        kind: 'regex',
        patterns: [
          /^目前权限[：:]\s*[（(]?[pP]layer[)）]\s*$/,
          /^欢迎来到北大侠客行[^]*$/,   // (估计) 备选形态
          /^重新连线完毕[^]*$/,          // (估计) 备选形态
        ],
      },
      action: { tool: 'mud_send', args: { cmd: '' } },
      // 命令被接受即成功；next 空 = 终态 ⇒ `finishFlow`（§19.2）。
      ok: [{ kind: 'ga' }],
      timeoutMs: 5_000,
      onEnter: { patch: { logged_in: true } },
    },
  ],
}
