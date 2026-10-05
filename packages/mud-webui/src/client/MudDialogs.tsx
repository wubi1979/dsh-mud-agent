/**
 * dsh-mud-webui — roster dialogs (client half, core3).
 *
 * ServerDialog: 添加服务器（name/host/port/cwd）——v1 原样保留。
 * UserDialog: 添加用户（name/pass/preset）——新增 preset 下拉。
 * CaptchaDialog: 人工验证码弹窗（T13.3，D7 呈现：图片 / 提示行+刷新 /
 *   输入框 / 中止+提交）；MudCaptchaDialog 为它的全局绑定层（watchCaptcha
 *   订阅 + 挂起呈现 + 收束关窗），挂载于全局侧栏，与画面 tab 无关。
 * @module @deepseek-ai/dsh-mud-webui/client/MudDialogs
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, IconRefreshOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { MudCaptchaController } from './mud-captcha.ts'
import type { MudCaptchaRow, MudRemoteController } from './mud-remote.ts'

const FIELD_STYLE: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px',
  borderRadius: 6, border: '1px solid var(--dsw-alias-interactive-bg-hover)',
  background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 13,
}
const LABEL_STYLE: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '10px 0 4px',
}
const ERROR_STYLE: React.CSSProperties = { fontSize: 12, color: '#d85f5f', marginTop: 10 }

function useEnterSubmit(submit: () => void): {
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  composing: React.MutableRefObject<boolean>
} {
  const composing = useRef(false)
  return {
    composing,
    onKeyDown: (e) => {
      if (e.key !== 'Enter' || composing.current) return
      e.preventDefault()
      submit()
    },
  }
}

/** Add-server dialog: name, host, port, workspace directory. */
export function ServerDialog({ open, onClose, onAdd }: {
  open: boolean
  onClose: () => void
  onAdd: (input: { name: string; host: string; port: number; cwd: string }) => void
}) {
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('8081')
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)

  const close = (): void => { setName(''); setHost(''); setPort('8081'); setCwd(''); setError(null); onClose() }
  const submit = (): void => {
    const trimmedHost = host.trim()
    const portNum = Number(port)
    if (trimmedHost === '') { setError('请输入服务器地址'); return }
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) { setError('端口必须是 1-65535 的整数'); return }
    onAdd({ name, host: trimmedHost, port: portNum, cwd })
    close()
  }
  const enter = useEnterSubmit(submit)

  return (
    <Modal open={open} onClose={close} title="添加服务器" closeLabel="关闭"
      footer={<><Button variant="outline" onClick={close}>取消</Button><Button variant="primary" onClick={submit}>添加</Button></>}
    >
      <label style={LABEL_STYLE}>名称（可选）</label>
      <input style={FIELD_STYLE} value={name} autoFocus placeholder="例如 北大侠客行"
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setName(e.target.value); setError(null) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>服务器地址</label>
      <input style={FIELD_STYLE} value={host} placeholder="mud.example.com" spellCheck={false}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setHost(e.target.value); setError(null) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>端口</label>
      <input style={FIELD_STYLE} value={port} inputMode="numeric"
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setPort(e.target.value); setError(null) }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>工作目录（可选，绑定会话历史归属）</label>
      <input style={FIELD_STYLE} value={cwd} placeholder="例如 D:\code" spellCheck={false}
        onChange={(e) => { setCwd(e.target.value); setError(null) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
    </Modal>
  )
}

/** 可选 preset 列表（core3 第一期：mud-player + 宿主 standard）。 */
const PRESET_OPTIONS = [
  { value: 'mud-player', label: 'MUD 玩家（mud-player）' },
  { value: 'standard', label: '标准（standard）' },
]

/** 用户对话框提交值（edit 模式 pass = '' 表示不改密码）。 */
export interface UserDialogSubmit {
  name: string
  pass: string
  preset: string
}

/**
 * 用户对话框（create 添加 / edit 编辑双模式）。
 * - create：用户名 + 密码 + preset。
 * - edit：改名 + 可选改密码（留空不改，新密码按原凭据引用覆盖写入，下次
 *   连接/登录流程即生效）；preset 建会话时已绑定装配，只读。
 */
export function UserDialog({ open, mode, serverName, initial, onClose, onSubmit }: {
  open: boolean
  mode: 'create' | 'edit'
  serverName: string
  /** edit 模式初始值（name/preset；pass 恒留空 = 不修改）。 */
  initial?: { name: string; preset: string } | undefined
  onClose: () => void
  onSubmit: (input: UserDialogSubmit) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [preset, setPreset] = useState('mud-player')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const editing = mode === 'edit'

  // 打开时按模式重置（edit 预填账号属性；pass 恒空 = 不修改密码）。
  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setPass('')
    setPreset(initial?.preset ?? 'mud-player')
    setError(null)
    setBusy(false)
  }, [open, initial?.name, initial?.preset])

  const close = (): void => { setError(null); setBusy(false); onClose() }
  const submit = (): void => {
    if (busy) return
    if (name.trim() === '') { setError('请输入用户名'); return }
    if (!editing && pass === '') { setError('请输入密码'); return }
    setBusy(true)
    setError(null)
    void onSubmit({ name, pass, preset })
      .then(() => { close() })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); setBusy(false) })
  }
  const enter = useEnterSubmit(submit)

  return (
    <Modal open={open} onClose={close} title={`${editing ? '编辑' : '添加'}用户 — ${serverName}`} closeLabel="关闭"
      footer={<><Button variant="outline" onClick={close}>取消</Button><Button variant="primary" onClick={submit}>{busy ? (editing ? '保存中…' : '添加中…') : (editing ? '保存' : '添加')}</Button></>}
    >
      <label style={LABEL_STYLE}>用户名</label>
      <input style={FIELD_STYLE} value={name} autoFocus placeholder="游戏账号"
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setName(e.target.value); setError(null) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>密码</label>
      <input style={FIELD_STYLE} type="password" value={pass}
        placeholder={editing ? '留空 = 不修改密码（覆盖写入原凭据引用）' : '登录密码 (写入 host 凭据存储, 不进浏览器名单)'}
        onChange={(e) => { setPass(e.target.value); setError(null) }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>Preset（Agent 装配）</label>
      <select style={FIELD_STYLE} value={preset} disabled={editing}
        onChange={(e) => { setPreset(e.target.value) }}
      >
        {PRESET_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {editing && (
        <div style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 }}>
          preset 在建会话时已绑定装配，修改需删除账号后重建
        </div>
      )}
      {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
    </Modal>
  )
}

/** 验证码图片呈现样式（自上而下首元素，D7）。 */
const CAPTCHA_IMAGE_STYLE: React.CSSProperties = {
  display: 'block', maxWidth: '100%', margin: '12px auto 0',
  borderRadius: 6, border: '1px solid var(--dsw-alias-interactive-bg-hover)',
}

/** 刷新图标钮样式（提示行内联小钮）。 */
const REFRESH_BUTTON_STYLE: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, padding: 0, borderRadius: 5, cursor: 'pointer',
  border: '1px solid var(--dsw-alias-interactive-bg-hover)',
  background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
}

/**
 * 人工验证码弹窗（T13.3 D7 呈现面，纯 props 驱动）：
 * 自上而下 = 图片 / 提示行（来源账号名）+ 刷新图标（本轮已用即置灰）/
 * 输入框（Enter 提交）/ 中止 + 提交。收束关窗由服务端推清除帧驱动
 * （提交/中止后不清本地窗——等服务端收束，答错重入推新帧重现）。
 */
export function CaptchaDialog({ open, row, refetched, busy, error, onClose, onSubmit, onAbort, onRefresh }: {
  open: boolean
  /** 当前挂起行（含图片与来源账号名）。 */
  row: MudCaptchaRow
  /** 本轮刷新配额是否已用（D7：每轮挂起限 1 次）。 */
  refetched: boolean
  /** 提交/中止在途（按钮置灰防双击）。 */
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (value: string) => void
  onAbort: () => void
  onRefresh: () => void
}) {
  const [value, setValue] = useState('')
  // 换行（新一轮/换会话）重置输入；行未变（同轮重推帧）保留已输入值。
  const sessionIdRef = useRef(row.sessionId)
  if (sessionIdRef.current !== row.sessionId) {
    sessionIdRef.current = row.sessionId
    setValue('')
  }
  const submit = (): void => {
    if (busy || value.trim() === '') return
    onSubmit(value)
    setValue('')
  }
  const enter = useEnterSubmit(submit)

  return (
    <Modal open={open} onClose={onClose} title="人工验证码" closeLabel="关闭"
      footer={<>
        <Button variant="outline" disabled={busy} onClick={onAbort}>中止</Button>
        <Button variant="primary" disabled={busy || value.trim() === ''} onClick={submit}>
          {busy ? '提交中…' : '提交'}
        </Button>
      </>}
    >
      <img style={CAPTCHA_IMAGE_STYLE} src={row.image} alt="验证码图片" />
      <label style={{ ...LABEL_STYLE, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>请输入图片中的验证码（来源：{row.account}）</span>
        <Tooltip label={refetched ? '本轮已刷新' : '刷新图片（本轮限 1 次）'} delayMs={300}>
          <button type="button" style={REFRESH_BUTTON_STYLE} aria-label="刷新图片"
            disabled={refetched || busy} onClick={onRefresh}
          >
            <IconRefreshOutlineRegular size={14} />
          </button>
        </Tooltip>
      </label>
      <input style={FIELD_STYLE} value={value} autoFocus spellCheck={false}
        placeholder="输入验证码"
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setValue(e.target.value) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
    </Modal>
  )
}

/**
 * 全局验证码弹窗绑定层：持有 MudCaptchaController（订阅 watchCaptcha 流）
 * 并把快照画成 CaptchaDialog。全局模态——不属于任何会话视图，切换会话仍
 * 显示并标注来源账号名；Esc/遮罩 = 本地隐藏（不动流程，挂起照常等、服务端
 * 超时兜底），该行重现或换行时重新显示。
 */
export function MudCaptchaDialog({ remote }: { remote: MudRemoteController }) {
  const ref = useRef<MudCaptchaController | null>(null)
  if (ref.current === null) ref.current = new MudCaptchaController(remote)
  const controller = ref.current
  // 流生命周期跟组件：卸载即停（页面刷新 = 重挂载重新订阅，首帧补推恢复弹窗）。
  useEffect(() => controller.start(), [controller])
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  // Esc/遮罩隐藏的行：行重现（新一轮）或换行时重新显示。
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const row = snap.pending[0] ?? null
  const open = row !== null && row.sessionId !== dismissedFor
  return (
    <CaptchaDialog
      open={open}
      row={row !== null ? row : EMPTY_ROW}
      refetched={row !== null && snap.refetched.has(row.sessionId)}
      busy={row !== null && snap.busy.has(row.sessionId)}
      error={snap.error}
      onClose={() => { if (row !== null) setDismissedFor(row.sessionId) }}
      onSubmit={(value) => { if (row !== null) void controller.submit(row.sessionId, value) }}
      onAbort={() => { if (row !== null) void controller.abort(row.sessionId) }}
      onRefresh={() => { if (row !== null) void controller.refresh(row.sessionId) }}
    />
  )
}

/** CaptchaDialog 关闭态的空行占位（open=false 时不渲染内容，类型上仍需一值）。 */
const EMPTY_ROW: MudCaptchaRow = { sessionId: '', account: '', url: '', image: '' }
