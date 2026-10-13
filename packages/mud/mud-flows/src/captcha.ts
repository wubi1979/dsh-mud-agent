/**
 * captcha — 验证码取图纯层（T13 D3：Node fetch 抓 robot.php → 取 <img src> →
 * 下载 → base64 data URL）。
 *
 * v1 已验证路径（v1 §11：mud_captcha 工具 + network/captcha.ts 的
 * resolveCaptchaImage）；本层只保留最小面：
 *   - fetchCaptchaImage：抓页 → 取首个 `<img src>` → 相对地址归一为绝对 →
 *     下载 → `data:<type>;base64,…`。fetch 注入（纯层可单测）；
 *   - 内置 5s 请求超时（AbortSignal.timeout；无例证不加围栏/尺寸上限）。
 *
 * T14.2：URL 捕获上移为流程声明捕获槽（urlwait captures），原
 * extractCaptchaUrl + CAPTCHA_URL_RE 行流自取净删——调用方（service.awaitCaptcha）
 * 收 url 参数取图。
 */

/** HTML 页内首个 `<img src>`（v1 事实：robot.php 返回 HTML 页含 <img>）。 */
const IMG_SRC_RE = /<img[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/i

/** 单次请求超时毫秒（取图/下载共用；无例证不进 Config）。 */
const FETCH_TIMEOUT_MS = 5_000

/** fetch 的最小结构面（注入用；全局 fetch 结构兼容）。 */
export interface CaptchaResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
  readonly headers: { get(name: string): string | null }
}

/** 可注入的取图 fetch（D3；测试注入假实现，生产用全局 fetch）。 */
export type CaptchaFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<CaptchaResponse>

/**
 * 抓验证码图（D3）：robot.php 页 → `<img src>` → 下载 → data URL。
 * @param url - robot.php 页地址（MUD 行捕获）。
 * @param fetchImpl - 注入的 fetch（生产传全局 fetch）。
 * @returns data URL（`data:<type>;base64,<…>`）。
 * @throws 页/图抓取失败（HTTP 非 2xx、无 img、下载失败）——可读错上抛。
 */
export async function fetchCaptchaImage(
  url: string,
  fetchImpl: CaptchaFetch,
): Promise<string> {
  const init = { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  const page = await fetchImpl(url, init)
  if (!page.ok) throw new Error(`抓取验证码页失败：HTTP ${page.status}（${url}）`)
  const html = await page.text()
  const src = html.match(IMG_SRC_RE)?.[1]
  if (src === undefined) throw new Error(`验证码页无 <img>（${url}）——语料或页面结构变化，请核对`)
  const imgUrl = new URL(src, url).toString()
  const img = await fetchImpl(imgUrl, init)
  if (!img.ok) throw new Error(`下载验证码图失败：HTTP ${img.status}（${imgUrl}）`)
  const bytes = await img.arrayBuffer()
  const type = (img.headers.get('content-type') ?? 'image/png').split(';')[0] ?? 'image/png'
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
}
