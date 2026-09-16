// 生成工件的编译期兜底声明。
//
// gen:typert 产物 (lib/typert.host.d.ts) 生成后, 包导出 './typert' 自带精确类型;
// 但全新克隆的构建顺序是 先 build 后 gen — 产物尚不存在时, 此 ambient 声明保证
// assemble.ts 的动态导入可过编译 (仅 mud-core 自身程序内生效, 不外泄给 webui,
// webui 消费的 './remote' 走生成产物自带类型)。
declare module '@deepseek-ai/dsh-mud-core/typert' {
  // dsh-typert-registry 的注册贡献 (严格 descriptor + zod schema), 形状由生成器保证
  export const TYPERT: unknown
}
