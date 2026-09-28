/**
 * mud-core3 link/index — link 层统一导出。
 *
 * 第一期（C1）只有 link 层：telnet/ansi/mud/corpus，零宿主依赖。
 * 后续切片（C2/C3）在此包内新增 roster、runtime、preset、remote 等。
 */

export { Mud } from './mud.ts'
export type { MudLine, StyleRun, StyleFlag } from './line.ts'
export { AnsiStreamParser, stripAnsi, isPromptText, MAX_SEQUENCE_BUF } from './line.ts'
export { TelnetClient } from './telnet.ts'
export type { TelnetClientOptions, GmcpMessage } from './telnet.ts'
export { CorpusWriter, readCorpus } from './corpus.ts'
export type { CorpusLineRecord, CorpusEventRecord, CorpusRecord } from './corpus.ts'
