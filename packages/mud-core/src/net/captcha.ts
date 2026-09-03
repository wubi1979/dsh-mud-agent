/**
 * dsh-mud-core — 验证码图片解析 (net/captcha), host half.
 *
 * pkuxkx 的 fullme 验证码交互中, 游戏回显的地址并非真实图片, 而是
 * robot.php 页面 (http://fullme.pkuxkx.net/robot.php?filename=<ts>), 页面
 * 内嵌一个真实验证码图片 <img>, 其 src 为服务器随机生成的相对路径:
 *
 *   <html><head></head><body><img src="./b2evo_captcha_tmp/...jpg" ...></body></html>
 *
 * 本模块负责: 请求 robot.php 页面 → 提取首个图片 src → 用 new URL 归一为绝对
 * 图片地址返回。纯函数、无框架依赖, 便于单测。
 *
 * 注意 (交互约束):
 *   - robot.php 可刷新 2 次, 每次刷新图片地址变化 (图片内容不变);
 *   - 图片生成 3 分钟后或刷新满 2 次后, 该 robot.php 地址不再给出图片。
 *   因此这里**单次抓取即取, 不做重试** (首次即有图, 重试会浪费有限的刷新次数)。
 * @module @deepseek-ai/dsh-mud-core/net/captcha
 */

/** HTML <img> 标签中 src 为图片 (jpg/jpeg/png/gif) 的匹配; 兼容单/双引号。 */
const IMG_SRC_RE = /<img[^>]*src=["']([^"']+\.(?:jpe?g|png|gif))["']/i

/**
 * 请求 robot.php 验证码页面, 解析出真实图片的绝对地址。
 * @param robotUrl 游戏回显的 robot.php 地址。
 * @returns 真实验证码图片的绝对 URL。
 * @throws 网络异常或页面中未匹配到图片时抛出 (交由调用方兜底)。
 */
export async function resolveCaptchaImage(robotUrl: string): Promise<string> {
  const res = await fetch(robotUrl)
  if (!res.ok) {
    throw new Error(`验证码页面请求失败 (HTTP ${res.status})`)
  }
  const html = await res.text()
  const m = html.match(IMG_SRC_RE)
  if (m === null || m[1] === undefined) {
    throw new Error('验证码页面中未找到图片地址')
  }
  // new URL 原生处理相对路径 (含 "./")、"/" 开头与绝对 URL 三种形态。
  return new URL(m[1], robotUrl).href
}
