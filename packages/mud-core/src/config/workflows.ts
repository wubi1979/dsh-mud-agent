/**
 * dsh-mud-core — 流程配置 (Workflows, config)。workerflow-agnostic 运行器
 * (flow.ts FlowRuntime) 读取本文件, 用纯函数声明每个确定性事务流程。
 *
 * skill 是声明式能力 (给 agent 看), workflow 是确定性执行体 (给运行时看)。
 * 本文件 = workflow 定义, 消费方是 flow.ts 的通用运行器, 不含运行时逻辑。
 *
 * 结构:
 *   id        workflow 名 (FlowService 注册键 / skill 绑定执行后端)
 *   owner     触发规则批量注销标识
 *   timeoutMs 默认超时 (宿主 loginTimeoutMs 可覆盖)
 *   triggers  激活期注册的感知触发规则 (纯数据: 正则锚定游戏提示)
 *   onPercept 感知事件 → 响应: 纯函数, 收到 (driver, e) 按事件类型分支, 用
 *             driver 声明要发什么命令 / 是否收尾 (done/failed)。不预设返回值
 *             形状, 由该 skill 业务需要决定。
 *   onTimeout 超时处理: 纯函数, 判断是否已成功 / 需交给 agent。
 * @module @deepseek-ai/dsh-mud-core/config/workflows
 */

import type { WorkflowConfig } from '../agent/flow.ts'

/** 登录流程 (确定性事务): "服务器提示 → 发对应输入 → 完成"。含 replace 旁路与
 * failed 提前终止 (分支, 非纯串行), 故用事件分发而非简单顺序步骤。 */
const loginWorkflow = {
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

  /** 感知事件分支处理: 提示 → 发对应命令; 成功/失败 → 收尾。返回值由 skill
   * 业务需要决定, 无需固定形状。 */
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
        driver.failed('登录失败 (密码错误等), 请修订登录策略。')
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
} satisfies WorkflowConfig

export default loginWorkflow
export type { WorkflowConfig } from '../agent/flow.ts'