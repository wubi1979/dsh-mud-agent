/**
 * flows/login — 登录流程（impl §3.6；实录刻度承自旧实现
 * packages/mud-core/src/agent/flow/flows/login.ts，抓包字节实证 2026-09-10/11）。
 *
 * 步骤图（旧实录定案）：等名字提示 → {name} → 等密码提示 → {pass}
 *   → [替换询问 → y] → 成功句 → 空命令收尾。
 *
 * 失败口径（承旧定案）：用户名/密码是人工给的，T2/用户都补不了，不做恢复
 * 路径 —— 异常终态一律抛 FlowError（工具层转错误结果，失败不结束回合）。
 * 密码错误实测上常表现为服务器直接断连（disconnected → 抛错收束）。
 *
 * 凭据纪律：{name}/{pass} 只在 mud.send 调用瞬间使用，明文不进任何模型
 * 上下文（流程结果只含服务端应答原文）。
 */

import { FlowError, type Flow, type FlowCtx, type FlowResult } from './types.ts'
import type { Mud, ReadResult, WaitOpts } from '../../link/mud.ts'

/**
 * 单步兜底超时取 ctx.defaultTimeoutMs（Config → deps 注入；§3.5"必须显式给出
 * 或由工具注入缺省"，取值待 §6 校准）——本文件不设模块级超时常量。
 */

/**
 * 登录判据（实录刻度承旧实现；旧引擎逐行测故带 ^…$ 锚，本包 read 的 until 在
 * **累积文本**（各行以 \n 连接）上测 —— 锚一律配 m 标志，否则多行累积下失配）。
 */

/** 名字提示（实录两形：新连接入口 / 旧估计形态）。 */
const UNTIL_NAME = [/您的英文名字（要注册新人物请输入new。）：/, /您的英文名字[：:]/]
/** 密码提示（实录 2026-09-10, 8081 老号复登："此ID档案已存在，请输入密码："）。 */
const UNTIL_PASS = [/^(?:此ID档案已存在，|ID已存在，)?请输入密码[：:]\s*$/m]
/** 用户名不存在 → 实质失败（(估计) 原文待核对，承旧表）。 */
const FAIL_NAME = [/需要创建新人物/]
/** 密码错误提示（估计形态；实测密码错常直接断连，走 disconnected 收束）。 */
const FAIL_PASS = [/^密码错误/m, /^密码不正确/m, /^登录失败/m]
/** 替换询问（实录 2026-09-11 同名在线："您要将另一个连线中的相同人物赶出去，取而代之吗？"）。 */
const RE_PLACE = /您要将另一个连线中的相同人物赶出去/
/** 登录成功句（实录 + (估计) 备选形态）。 */
const UNTIL_SUCCESS = [/目前权限[：:]\s*[（(]?[pP]layer[)）]\s*$/m, /欢迎来到北大侠客行/, /重新连线完毕/]

/**
 * 单步等待：danger → 出口 3；timeout/disconnected/signal → 抛错（异常终态）；
 * failOn/f.done → 原样返回（由调用方按步语义判）。
 * （signal 经条件展开进入 opts：exactOptionalPropertyTypes 下可选字段不收
 * 显式 undefined。）
 */
async function step(mud: Mud, opts: Omit<WaitOpts, 'signal'>, signal: AbortSignal | undefined, what: string): Promise<ReadResult> {
  const r = await mud.read({ ...opts, ...(signal !== undefined ? { signal } : {}) })
  if (r.reason === 'danger') return r
  if (r.reason === 'timeout') throw new FlowError(`登录失败：${what}超时`)
  if (r.reason === 'disconnected') throw new FlowError(`登录失败：${what}期间连接断开`)
  if (r.reason === 'signal') throw new FlowError(`登录失败：${what}被中止`)
  return r
}

/** 登录流程。 */
export const LOGIN_FLOW: Flow = {
  id: 'login',
  description: '账号登录：名字 → 密码 → [替换在线同名 → y] → 成功句 → 空命令收尾',
  async run(ctx: FlowCtx): Promise<FlowResult> {
    const { mud, creds, holder, defaultTimeoutMs, signal } = ctx

    // 1. 等名字提示（连接横幅后的入口行）。
    await step(mud, { holder, until: UNTIL_NAME, timeoutMs: defaultTimeoutMs }, signal, '等名字提示')
    mud.send(creds.name)

    // 2. 等密码提示；用户名不存在（需要创建新人物）= 实质失败。
    const rPass = await step(
      mud,
      { holder, until: UNTIL_PASS, failOn: FAIL_NAME, timeoutMs: defaultTimeoutMs },
      signal,
      '等密码提示',
    )
    if (rPass.reason === 'failOn') throw new FlowError('登录失败：用户名不存在（需要创建新人物）')
    mud.send(creds.pass)

    // 3. 等替换询问或成功句（谁先到谁生效；密码错误 failOn）。
    const r3 = await step(
      mud,
      { holder, until: [RE_PLACE, ...UNTIL_SUCCESS], failOn: FAIL_PASS, timeoutMs: defaultTimeoutMs },
      signal,
      '等登录结果',
    )
    if (r3.reason === 'failOn') throw new FlowError('登录失败：密码错误或登录被拒')
    if (r3.reason === 'danger') return { reason: 'danger' }

    // 4. 替换询问分支：答 y 后不再回头要密码（旧实录定案），直接等成功句。
    if (r3.lines.some(l => RE_PLACE.test(l.text))) {
      mud.send('y')
      const r4 = await step(
        mud,
        { holder, until: UNTIL_SUCCESS, failOn: FAIL_PASS, timeoutMs: defaultTimeoutMs },
        signal,
        '等替换后的成功句',
      )
      if (r4.reason === 'failOn') throw new FlowError('登录失败：密码错误或登录被拒')
      if (r4.reason === 'danger') return { reason: 'danger' }
    }

    // 5. 成功句已见：发一个**空命令**收尾 —— 空行足以"顶"开服务端（登录后
    //    不发命令则输出要等约 5 分钟，实测），且任何命令都能跳过 MXP 检测；
    //    第一屏内容由 T2 自决（不替它 look）。
    mud.send('')

    // 6. 收尾收口：该命令的应答帧必须在此消费掉（旧实录 settle on ga:1），
    //    否则残留在直达缓冲，会被下一个 mud_send 的预取窗口无条件吞进它的
    //    结果 —— "登录完成"与"行流干净"要同时成立。收口超时**不算失败**
    //    （成功句已见，登录已完成）；只有危险中断仍走出口 3。
    const tail = await mud.read({
      holder,
      gaCount: 1,
      timeoutMs: defaultTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    })
    if (tail.reason === 'danger') return { reason: 'danger' }
    return { done: true }
  },
}
