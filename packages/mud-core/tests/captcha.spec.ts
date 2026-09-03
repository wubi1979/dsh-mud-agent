/**
 * dsh-mud-core 验证码图片解析测试 — resolveCaptchaImage。
 *
 * 覆盖: 真实 pkuxkx 页面结构 (相对 ./ 路径、单引号、仅一个图) → 归一为绝对 jpg;
 * 绝对/斜杠开头/双引号/多图取首个; 无图 / fetch 失败 / 非 2xx → 抛错。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { resolveCaptchaImage } from '../src/net/captcha.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 构造一个返回给定 HTML 的全局 fetch 桩。 */
function stubFetch(html: string, ok = true, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status,
    text: async () => html,
  })))
}

/** 真实 pkuxkx robot.php 页面结构 (用户实测): 仅一个图, 相对 ./ 路径、单引号。 */
const REAL_ROBOT_HTML =
  '<html><head></head><body><img src="./b2evo_captcha_tmp/' +
  'b2evo_captcha_9F93033096244D7B97D24A2B35B51D98.jpg" alt="This is a captcha-picture. ' +
  'It is used to prevent robots." title=""><br>' +
  '<h3>If you can not read the image, please refresh the page to genenrate new.</h3>' +
  '</body></html>'

describe('resolveCaptchaImage', () => {
  it('真实页面结构: 相对 ./ 路径、单引号 → 归一为绝对 jpg', async () => {
    stubFetch(REAL_ROBOT_HTML)
    const base = 'http://fullme.pkuxkx.net/robot.php?filename=1788425144529435'
    const url = await resolveCaptchaImage(base)
    expect(url).toBe(
      'http://fullme.pkuxkx.net/b2evo_captcha_tmp/b2evo_captcha_9F93033096244D7B97D24A2B35B51D98.jpg',
    )
  })

  it('绝对 src (http://) → 原样返回', async () => {
    stubFetch('<img src="http://fullme.pkuxkx.net/b2evo_captcha_tmp/a.jpg">')
    expect(await resolveCaptchaImage('http://fullme.pkuxkx.net/robot.php')).toBe(
      'http://fullme.pkuxkx.net/b2evo_captcha_tmp/a.jpg',
    )
  })

  it('斜杠开头 /b2evo_... → 基于 host 归一', async () => {
    stubFetch('<img src="/b2evo_captcha_tmp/b.png">')
    expect(await resolveCaptchaImage('http://fullme.pkuxkx.net/robot.php')).toBe(
      'http://fullme.pkuxkx.net/b2evo_captcha_tmp/b.png',
    )
  })

  it('多图 → 取第一个图片 src', async () => {
    stubFetch('<img src="a.gif"><img src="b.jpg">')
    expect(await resolveCaptchaImage('http://host/robot.php')).toBe('http://host/a.gif')
  })

  it('页面无图片 → 抛错', async () => {
    stubFetch('<html><body>no image here</body></html>')
    await expect(resolveCaptchaImage('http://host/robot.php')).rejects.toThrow()
  })

  it('fetch 网络异常 → 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(resolveCaptchaImage('http://host/robot.php')).rejects.toThrow()
  })

  it('HTTP 非 2xx → 抛错', async () => {
    stubFetch('forbidden', false, 403)
    await expect(resolveCaptchaImage('http://host/robot.php')).rejects.toThrow()
  })
})
