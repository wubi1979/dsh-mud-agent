#!/usr/bin/env node
// typert 宿主工件生成器 (对应官方 tsdown --env.DSH_BUILD_FACE host 的独立脚本形态)。
//
// 产出 (写入 packages/mud-core/lib/):
//   typert.host.js/.d.ts          — TYPERT 贡献: 严格 descriptor + zod schema (assemble 注册进 ctx.typert)
//   typert.remote-client.js/.d.ts — TYPERT_REMOTE 描述符: webui 侧 ctx.remote.$mount 消费
//
// 前置: 依赖协议包镜像 packages/typert-protocol (生成器的 Remote 符号识别要求协议包
// 真实存在于 <workspace>/packages 内, realPath 判定)。协议解析经根 tsconfig.host.json
// 的 paths 直达镜像 src/, 无需先构建镜像。
//
// 用法: pnpm --dir packages/mud-core gen:typert
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PACKAGE = '@deepseek-ai/dsh-mud-core'
const packageRoot = resolve(root, 'packages/mud-core')
const libRoot = resolve(packageRoot, 'lib')

// 生成器是 mud-core 的 devDep (只在包内 node_modules 链接), 脚本本身在仓库根
// scripts/ 下 — 挂 mud-core 的 require 作解析基准
const requireFromMudCore = createRequire(resolve(packageRoot, 'package.json'))
const { WorkspaceTypertGenerator } = await import(pathToFileURL(requireFromMudCore.resolve('@deepseek-ai/dsh-typert-generator')).href)

const generator = new WorkspaceTypertGenerator(root)
const artifacts = generator.generate([PACKAGE], ['host'])
if (artifacts.length === 0) throw new Error(`gen-typert: 未发现 ${PACKAGE} 的宿主 face 产物`)

for (const artifact of artifacts) {
  const files = [
    [`typert.${artifact.face}.js`, artifact.js],
    [`typert.${artifact.face}.d.ts`, artifact.dts],
  ]
  if (artifact.remote !== undefined) {
    files.push(
      ['typert.remote-client.js', artifact.remote.js],
      ['typert.remote-client.d.ts', artifact.remote.dts],
    )
  }
  mkdirSync(libRoot, { recursive: true })
  for (const [name, content] of files) {
    if (content === undefined) continue
    writeFileSync(resolve(libRoot, name), content)
  }
  const sizes = files.map(([name, content]) => `${name} (${content?.length ?? 0}B)`).join(' + ')
  console.log(`gen-typert: ${artifact.package} [${artifact.face}] ${sizes}`)
}
