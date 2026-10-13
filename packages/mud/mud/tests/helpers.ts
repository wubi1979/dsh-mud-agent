/**
 * 测试共享助手：剥离 IAC 序列。
 *
 * 客户端建连即发协商（WILL/DO、NAWS 等 SB 子协商），mock 服务端收数据时先
 * 剥离，命令行匹配才不被协商字节污染。
 */

/** 剥离 IAC 序列（协商 WILL/DO 3 字节、SB…SE 子协商整段、简单命令 2 字节）。 */
export function stripIac(buf: Buffer): string {
  const out: number[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]!
    if (b !== 255) { out.push(b); i += 1; continue }
    const cmd = buf[i + 1]
    if (cmd === undefined) break // 半截 IAC（测试流不出现跨 chunk 命令）
    if (cmd === 255) { out.push(255); i += 2; continue } // IAC IAC = 字面 255
    if (cmd === 250) { // IAC SB … IAC SE：子协商整段剥离（NAWS/MCCP2 等）
      let j = i + 2
      while (j + 1 < buf.length && !(buf[j] === 255 && buf[j + 1] === 240)) j += 1
      i = j + 2
      continue
    }
    i += cmd >= 251 && cmd <= 254 ? 3 : 2
  }
  return Buffer.from(out).toString('utf8')
}
