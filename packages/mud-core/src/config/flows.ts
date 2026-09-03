/**
 * dsh-mud-core — 流程配置 (Flows, config)。通用运行器 (flow.ts FlowRuntime)
 * 读取本文件, 用纯函数声明每个确定性事务流程。
 *
 * skill 是 agent 的决策单元 (被动, 给 LLM 看), flow 是确定性执行体 (主动,
 * 唯一入口 flow.start)。本文件 = flow 定义, 消费方是 flow.ts 的通用运行器,
 * 不含运行时逻辑。
 *
 * 结构:
 *   id        flow 名 (FlowService 注册键 / skill 步骤指名的执行体)
 *   owner     事务触发器批量注销标识
 *   timeoutMs 默认超时 (宿主 FlowHost.timeoutMs 可覆盖)
 *   watch     常驻探测触发规则 (装配期注册, 命中 → 自动 flow.start 可携捕获
 *             数据); 适合"任意时间出现的意图信号" (如 fullme 验证码请求)
 *   triggers  激活期注册的感知触发规则 (start 时原子注册, 严格先于任何 send
 *             — "先捕获再执行"类流程靠这一不变式保证不漏关键回显)
 *   onPercept 感知事件 → 响应: 纯函数, 收到 (driver, e) 按事件类型分支, 用
 *             driver 声明要发什么命令 / 是否收尾 (done/failed)。不预设返回值
 *             形状, 由该流程业务需要决定。
 *   onTimeout 超时处理: 纯函数, 判断是否已成功 / 需交给 agent。
 * @module @deepseek-ai/dsh-mud-core/config/flows
 */

import type { FlowConfig } from '../agent/flow.ts'

/** 登录流程 (确定性事务): "服务器提示 → 发对应输入 → 完成"。含 replace 旁路与
 * failed 提前终止 (分支, 非纯串行), 故用事件分发而非简单顺序步骤。 */
const loginFlow: FlowConfig = {
  id: 'login',
  owner: 'flow:login',
  timeoutMs: 20000,
  triggers: [
    {
      id: 'login:username',
      eventType: 'p:login:prompt',
      priority: 35,
      regex: [/^\s*您的英文名字（要注册新人物请输入new。）：/],
    },
    {
      id: 'login:password',
      eventType: 'p:login:pass',
      priority: 35,
      regex: [/^\s*此ID档案已存在，请输入密码：/],
    },
    {
      id: 'login:success',
      eventType: 'p:login:done',
      priority: 35,
      regex: [/^\s+欢迎来到北大侠客行！/, /^\s*重新连线完毕。/],
    },
    {
      id: 'login:replace',
      eventType: 'p:login:replace',
      priority: 35,
      regex: [/替换.*y\/n/],
    },
    {
      id: 'login:failed',
      eventType: 'p:login:failed',
      priority: 35,
      regex: [/密码错误/],
    },
  ],

  /** 感知事件分支处理: 提示 → 发对应命令; 成功/失败 → 收尾。返回值由业务
   * 需要决定, 无需固定形状。 */
  onPercept(driver, e) {
    switch (e.type) {
      case 'p:login:prompt': {
        if (driver.handled('name')) return
        if (driver.world.flags.sent_name) return
        driver.markHandled('name')
        driver.patchWorld({ sent_name: true })
        driver.send(driver.account().name)
        driver.progress('收到用户名提示 → 发送账号')
        driver.event(e, '发送用户名')
        return
      }
      case 'p:login:pass': {
        if (driver.handled('pass')) return
        if (driver.world.flags.sent_pass) return
        driver.markHandled('pass')
        driver.patchWorld({ sent_pass: true })
        driver.send(driver.account().pass)
        driver.progress('收到密码提示 → 发送密码')
        driver.event(e, '发送密码')
        return
      }
      case 'p:login:replace': {
        if (driver.handled('replace')) return
        driver.markHandled('replace')
        driver.send('y')
        driver.progress('收到替换确认 → 发送y')
        driver.event(e, '确认替换 (y)')
        return
      }
      case 'p:login:done': {
        if (driver.handled('done')) return
        driver.markHandled('done')
        // 登录后服务器进入 MXP 检测模式: 先发空行退出检测, 再 look 观察环境。
        driver.send(['', 'look'])
        driver.progress('收到登录成功 → 发送look')
        driver.event(e, 'look 刷新房间')
        driver.done()
        return
      }
      case 'p:login:failed': {
        driver.failed('登录流程失败 (密码错误等), 请修订登录策略。')
        return
      }
      default:
        return
    }
  },

  /** 超时处理: 已登录 → 静默成功; 否则交给 agent。 */
  onTimeout(driver) {
    if (driver.world.flags.logged_in) {
      driver.markDone()
      return
    }
    driver.failed(
      '登录流程超时, 尚未登录。请按 \'登录流程\' 技能步骤, 用 mud_send 完成登录。',
    )
  },
}

/**
 * fullme 验证码流程 (确定性事务, 短命一次性): watch 常驻探测验证码请求 →
 * 发送 fullme → 捕获图片地址 → 推送 WebUI 确认框 (tuiCaptcha) + 后台 OCR →
 * done。用户确认发送走 mud/command 并行路径, flow 不等待人类 (与任意流程并行)。
 * 识别错误时游戏会再次要求验证 → watch 重新命中 → 新一轮替换对话框。
 *
 * 异常处理流程:
 * 1. 检测到验证码请求 → 发送 fullme
 * 2a. 正常: 捕获图片地址 → 推送确认框
 * 2b. 冷却期: 服务器返回"你刚刚用过这个命令不久，还要X分钟Y秒才能再用。"
 *     → 本轮无中间环节, 直接短路结束 (markDone)
 * 2c. 未完成: 服务器返回"你之前请求的fullme还没有完成"
 *     → 之前有未完成的 fullme, 需发送 fullme 1 三次来放弃 (故意输错)
 *     → 每次服务器提示"好像什么都没有发生..."，最后一次"太遗憾了"结束本轮
 *     → (进入15分钟冷却期由服务器自行计时)
 */
const fullmeFlow: FlowConfig = {
  id: 'fullme',
  owner: 'flow:fullme',
  timeoutMs: 60000,
  /** 常驻探测: 严格整句锚定 "5M后长时间不使用fullme，会被系统判定为机器人。"
   *  仅当游戏输出这一整句时才发起 fullme; 其它任何含 "fullme" 的文本
   *  (冷却提示/未完成提示/fullme 1/图片URL/日志) 一律不再触发。
   *  ^\s*$ 容忍行首尾空白 (MudLine.text 已无 ANSI)。
   */
  watch: [
    {
      id: 'fullme:request',
      eventType: 'p:fullme:request',
      priority: 30,
      regex: [/^\s*5M后长时间不使用fullme，会被系统判定为机器人。\s*$/],
      extract: (record) => {
        const line = record.rows.map(r => r.text).find(t => t.includes('fullme'))
        return { line: line ? line.slice(0, 120) : null }
      },
    },
  ],
  /** 激活期注册 (先于 send('fullme')): 捕获回显中的验证码图片地址。
   *  URL 终止于空白/尖括号/引号/中英文标点 (实测地址
   *  http://fullme.pkuxkx.net/robot.php?filename=<ts>, 后跟逗号或句号会被
   *  过宽的正则吞进 URL); 提取前剥 ANSI 颜色码防拆行。 */
  triggers: [
    {
      id: 'fullme:image',
      eventType: 'p:fullme:image',
      priority: 35,
      regex: [/https?:\/\/[^\s<>"'，。；：！？、（）【】《》]+/i],
      extract: (record) => {
        // 剥 ANSI SGR 序列 (telnet 回显可能带颜色码, 会把 URL 劈成两截)。
        const line = record.rows
          .map(r => r.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
          .find(t => /https?:\/\//i.test(t))
        const m = line?.match(/https?:\/\/[^\s<>"'，。；：！？、（）【】《》]+/i)
        return m ? { url: m[0].replace(/[)\]}'".,;:!]+$/, '') } : null
      },
    },
    // 检测"你刚刚用过这个命令不久，还要X分钟Y秒才能再用。"提示 (冷却期短路)
    {
      id: 'fullme:cooldown',
      eventType: 'p:fullme:cooldown',
      priority: 36,
      regex: [/你刚刚用过这个命令不久/],
      extract: (record) => {
        const line = record.rows.map(r => r.text).find(t => /你刚刚用过这个命令不久/i.test(t))
        return { line: line ? line.slice(0, 200) : null }
      },
    },
    // 检测"你之前请求的fullme还没有完成"提示
    {
      id: 'fullme:not-completed',
      eventType: 'p:fullme:not-completed',
      priority: 36,
      regex: [/你之前请求的fullme还没有完成/],
      extract: (record) => {
        const line = record.rows.map(r => r.text).find(t => /你之前请求的fullme还没有完成/i.test(t))
        return { line: line ? line.slice(0, 200) : null }
      },
    },
    // 检测"好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！"提示
    {
      id: 'fullme:wrong-input',
      eventType: 'p:fullme:wrong-input',
      priority: 37,
      regex: [/好像什么都没有发生/],
      extract: (record) => {
        const line = record.rows.map(r => r.text).find(t => /好像什么都没有发生/i.test(t))
        return { line: line ? line.slice(0, 200) : null }
      },
    },
    // 检测"太遗憾了"提示（最终失败）
    {
      id: 'fullme:final-failure',
      eventType: 'p:fullme:final-failure',
      priority: 38,
      regex: [/太遗憾了/],
      extract: (record) => {
        const line = record.rows.map(r => r.text).find(t => /太遗憾了/i.test(t))
        return { line: line ? line.slice(0, 200) : null }
      },
    },
  ],

  onPercept(driver, e) {
    switch (e.type) {
      case 'p:fullme:request': {
        if (driver.handled('requested')) return
        driver.markHandled('requested')
        // 不暂停调度: fullme 命令插入发送队列, 与任意流程/行为并行。
        driver.send('fullme')
        driver.progress('检测到验证码请求 → 发送 fullme')
        driver.event(e, '发送 fullme')
        return
      }
      case 'p:fullme:image': {
        if (driver.handled('image')) return
        driver.markHandled('image')
        const url = String((e.data as { url?: unknown } | null)?.url ?? '')
        if (url === '') return
        driver.progress('捕获验证码图片 → 推送 WebUI 确认框')
        driver.event(e, '推送验证码图片')
        driver.captcha(url)
        driver.markDone()
        return
      }
      case 'p:fullme:cooldown': {
        // 冷却期: 系统提示"你刚刚用过这个命令不久，还要X分钟Y秒才能再用。"
        // 本轮没有中间环节, 直接短路正常结束 (markDone), 等系统自行计时。
        if (driver.handled('cooldown')) return
        driver.markHandled('cooldown')
        driver.progress('检测到冷却期提示 → 本轮短路结束 (等待系统计时)')
        driver.event(e, 'fullme 冷却期, 本轮直接结束')
        driver.markDone()
        return
      }
      case 'p:fullme:not-completed': {
        // 检测到"你之前请求的fullme还没有完成"，需要发送 fullme 1 三次来放弃
        if (driver.handled('not-completed')) return
        driver.markHandled('not-completed')
        driver.progress('检测到未完成的fullme → 开始放弃流程')
        driver.event(e, '开始放弃未完成的fullme')
        // 已发送 fullme 1 的次数 = 1 (本次发出第1发)
        driver.patchWorld({ fullme放弃次数: 1 })
        driver.send('fullme 1')
        driver.progress('发送 fullme 1 (第1次/共3次)')
        return
      }
      case 'p:fullme:wrong-input': {
        // 检测到"好像什么都没有发生...再来一次试试！" → 继续发送下一发 fullme 1
        const 已发次数 = Number(driver.world.flags?.fullme放弃次数 ?? 0)
        if (已发次数 >= 3) return // 已达3次上限, 等待"太遗憾了"收尾
        // 第2发/intermediate: 服务器对第3发会回"太遗憾了", 不会再有本事件
        const 下一次 = 已发次数 + 1
        driver.patchWorld({ fullme放弃次数: 下一次 })
        driver.progress(`发送 fullme 1 (第${下一次}次/共3次)`)
        driver.send('fullme 1')
        return
      }
      case 'p:fullme:final-failure': {
        // 检测到"太遗憾了"，本轮fullme验证失败结束(系统进入计时冷却)
        if (driver.handled('final-failure')) return
        driver.markHandled('final-failure')
        driver.progress('本轮fullme验证失败 → 结束 (系统进入冷却计时)')
        driver.event(e, 'fullme验证失败, 本轮结束')
        driver.failed('本轮fullme验证失败 (放弃未完成的fullme), 系统进入冷却计时, 冷却期结束后会再次提醒。')
        return
      }
      default:
        return
    }
  },

  /** 超时 (未捕获到图片回显): 失败收尾, 交宿主记录/通知。 */
  onTimeout(driver) {
    driver.failed('fullme 流程超时 (未捕获到图片回显), 请手动输入 fullme 验证码。')
  },
}

/** 流程注册表 (装配期逐个 FlowService.register)。 */
export const defaultFlows: readonly FlowConfig[] = [loginFlow, fullmeFlow]

export { loginFlow, fullmeFlow }
export default defaultFlows
