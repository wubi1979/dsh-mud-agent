/**
 * dsh-mud-core — 感知规则 (Perceptor rules) 默认配置。
 *
 * 感知器（Perceptor）的规则清单：每条规则对到达的行/窗口文本做确定性匹配
 * （流式游标模型，数据到达立即匹配），命中则发布 perception 事件并更新
 * WorldModel。想加/改规则，直接编辑本文件即可。
 *
 * 规则字段：
 *   id        感知单元 id（唯一，供决策规则 match.event 引用）
 *   eventType 命中时发布的语义事件类型（p:xxx）
 *   priority  优先级，数字大者先匹配（默认 10）
 *   contains  字面量数组：子串搜索（text.includes），命中任一即触发
 *   regex     正则数组：正则测试（re.test），命中任一即触发（与 contains 或关系）；
 *             登录等行首锚定场景用 ^ 防误触发
 *   multiline true 时对窗口连接文本整体匹配（跨行）；否则逐行匹配
 *   guard     (record) => boolean 可选的守门函数，返回 false 则跳过该规则
 *   extract   (record) => object 可选的命中数据提取，作为事件 data 附带
 * @module @deepseek-ai/dsh-mud-core/config/rules
 */

import type { PerceptionRule } from '../perception.ts'

/** 登录/战斗/死亡/房间 感知规则 (常驻)。 */
export default [
  // ── 登录提示 (常驻感知: 提示出现 → 决策规则发对应输入) ──
  {
    id: 'login:username',
    eventType: 'p:login:prompt',
    priority: 35,
    regex: [/^\s*您的英文名字（要注册新人物请输入new。）：/],
    extract: (record) => {
      const line = record.rows.map(r => r.text).find(t => /英文名字|注册新人物/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
  },
  {
    id: 'login:password',
    eventType: 'p:login:pass',
    priority: 35,
    regex: [/^\s*此ID档案已存在，请输入密码：/],
    extract: (record) => {
      const line = record.rows.map(r => r.text).find(t => /密码/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
  },
  {
    id: 'login:success',
    eventType: 'p:login:done',
    priority: 35,
    regex: [/^\s+欢迎来到北大侠客行！/, /^\s*重新连线完毕。/],
    extract: (record) => {
      const line = record.rows.map(r => r.text).find(t => /欢迎|重新连线/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
  },
  {
    id: 'login:replace',
    eventType: 'p:login:replace',
    priority: 35,
    regex: [/替换.*y\/n/],
    extract: (record) => {
      const line = record.rows.map(r => r.text).find(t => /替换/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
  },
  {
    id: 'login:failed',
    eventType: 'p:login:failed',
    priority: 35,
    regex: [/密码错误/],
    extract: (record) => {
      const line = record.rows.map(r => r.text).find(t => /密码错误/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
  },

  // ── 战斗 / 死亡 / 房间 (全局常驻) ──
  {
    id: 'combat:start',
    eventType: 'p:combat:start',
    priority: 20,
    contains: ['杀气', '向你扑来', '大喝道', '大喝一声', '喝道', '扑了上来'],
    extract: (record) => {
      const line = record.rows
        .map(r => r.text)
        .find(t => /杀气|扑来|大喝|喝道/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
  },
  {
    id: 'combat:end',
    eventType: 'p:combat:end',
    priority: 20,
    contains: ['战斗结束', '打斗结束', '你战胜了', '你打败了'],
    extract: (record) => {
      const line = record.rows
        .map(r => r.text)
        .find(t => /战斗结束|打斗结束|战胜了|打败了/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
  },
  {
    id: 'room:busy',
    eventType: 'p:room:busy',
    priority: 15,
    contains: ['这里的人很多', '热闹非凡', '人来人往', '熙熙攘攘'],
    extract: record => ({
      lines: record.rows.slice(0, 6).map(r => r.text),
    }),
  },
  {
    id: 'death',
    eventType: 'p:death',
    priority: 30,
    contains: ['你死了'],
    extract: (record) => {
      const line = record.rows.map(r => r.text).find(t => /你死了/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
  },
] satisfies readonly PerceptionRule[]
