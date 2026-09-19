/**
 * dsh-mud-webui — roster dialogs (client half).
 *
 * Controlled Modal forms for adding a MUD server (host:port) and adding a
 * user account to a server, plus the self-driven fullme captcha dialog
 * (state lives in the MudSocketController captcha store — replacement
 * semantics, one dialog page-wide; confirm sends the prefilled command via
 * POST /mud/command, abort just closes). Plain controlled inputs; Enter
 * submits, Escape closes via the Modal. Product copy is Chinese, comments
 * are English.
 * @module @deepseek-ai/dsh-mud-webui/client/MudDialogs
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MudSocketController } from './mud-socket.ts'

const FIELD_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-interactive-bg-hover)',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
}

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  margin: '10px 0 4px',
}

const ERROR_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: '#d85f5f',
  marginTop: 10,
}

/** Submit on Enter unless an IME composition is in flight. */
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

/** Add-server dialog: name (optional), host, port, workspace directory. */
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

  const close = (): void => {
    setName('')
    setHost('')
    setPort('8081')
    setCwd('')
    setError(null)
    onClose()
  }
  const submit = (): void => {
    const trimmedHost = host.trim()
    const portNum = Number(port)
    if (trimmedHost === '') {
      setError('请输入服务器地址')
      return
    }
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      setError('端口必须是 1-65535 的整数')
      return
    }
    onAdd({ name, host: trimmedHost, port: portNum, cwd })
    close()
  }
  const enter = useEnterSubmit(submit)

  return (
    <Modal
      open={open}
      onClose={close}
      title="添加服务器"
      closeLabel="关闭"
      footer={(
        <>
          <Button variant="outline" onClick={close}>取消</Button>
          <Button variant="primary" onClick={submit}>添加</Button>
        </>
      )}
    >
      <label style={LABEL_STYLE}>名称（可选）</label>
      <input
        style={FIELD_STYLE}
        value={name}
        autoFocus
        placeholder="例如 北大侠客行"
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setName(e.target.value); setError(null) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>服务器地址</label>
      <input
        style={FIELD_STYLE}
        value={host}
        placeholder="mud.example.com"
        spellCheck={false}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setHost(e.target.value); setError(null) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>端口</label>
      <input
        style={FIELD_STYLE}
        value={port}
        inputMode="numeric"
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setPort(e.target.value); setError(null) }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>工作目录（可选，绑定会话历史归属）</label>
      <input
        style={FIELD_STYLE}
        value={cwd}
        placeholder="例如 D:\code"
        spellCheck={false}
        onChange={(e) => { setCwd(e.target.value); setError(null) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
    </Modal>
  )
}

const CAPTCHA_IMG_STYLE: React.CSSProperties = {
  display: 'block',
  maxWidth: '100%',
  maxHeight: 220,
  marginTop: 10,
  marginLeft: 'auto',
  marginRight: 'auto',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-interactive-bg-hover)',
  background: '#fff',
  objectFit: 'contain',
}

const HINT_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  marginTop: 10,
}

const WARN_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: '#d85f5f',
  marginTop: 10,
}

/** 服务端反馈（上一轮答错原文；`captcha.note`）—— 提醒人工"图已刷新，请重输"。 */
const NOTE_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: '#c26b1f',
  background: 'var(--dsw-alias-interactive-bg-hover)',
  borderRadius: 6,
  padding: '6px 8px',
  marginTop: 10,
  whiteSpace: 'pre-wrap',
}

/**
 * fullme 验证码对话框 (自驱动): 状态在 MudSocketController 的 captcha 存储
 * (替换语义, 全局唯一不叠开) — 新 captcha 事件整体覆盖当前对话框。输入框**只收
 * 图片里的文字 (码)**, 其余一律不做 (§19.3 人工只负责提供值): 提交 → 经
 * /mud/command 送到会话, 由后台人工回填 → 流程 answer 步动作统一包装成
 * `halt + fullme <码>`; 中止 → 先调 abortCaptcha (fail-closed: 后台等待者
 * 直接失败, 所在流程步收束) 再关闭弹窗。
 */
export function CaptchaDialog({ mudSocket, sendCommand, refreshCaptcha, abortCaptcha, sessionId }: {
  mudSocket: MudSocketController
  sendCommand: (cmd: string, sessionId?: string) => Promise<boolean>
  refreshCaptcha: (imageUrl: string, sessionId?: string) => Promise<string | null>
  abortCaptcha: (sessionId?: string) => Promise<boolean>
  /** 验证码所属会话 (右栏 focus 会话; 缺省 = host 回落最近绑定会话)。 */
  sessionId?: string | undefined
}) {
  const snapshot = useSyncExternalStore(
    listener => mudSocket.subscribeCaptcha(listener),
    () => mudSocket.getCaptcha(),
  )
  const captcha = snapshot.captcha
  const [cmd, setCmd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // 新验证码事件 → 清空输入 (人工只填图片里的文字)。
  useEffect(() => {
    if (captcha === null) return
    setCmd('')
    setError(null)
  }, [captcha])

  const close = (): void => { mudSocket.clearCaptcha() }
  const [aborting, setAborting] = useState(false)
  const abort = (): void => {
    if (aborting) return
    setAborting(true)
    void Promise.resolve(abortCaptcha(sessionId))
      .catch(() => {})
      .finally(() => { setAborting(false); close() })
  }
  const submit = (): void => {
    const trimmed = cmd.trim()
    if (trimmed === '') {
      setError('请输入图片中的文字')
      return
    }
    setSending(true)
    void Promise.resolve(sendCommand(trimmed, sessionId))
      .then((ok) => {
        if (ok) { close() } else { setError('发送失败 (游戏可能未连接), 请重试') }
      })
      .catch(() => { setError('发送失败, 请重试') })
      .finally(() => { setSending(false) })
  }
  const refresh = (): void => {
    if (refreshing || captcha === null) return
    setRefreshing(true)
    setError(null)
    void Promise.resolve(refreshCaptcha(captcha.url ?? '', sessionId))
      .then((newUrl) => {
        if (newUrl === null) setError('刷新失败, 请重试')
      })
      .catch(() => { setError('刷新失败, 请重试') })
      .finally(() => { setRefreshing(false) })
  }
  const enter = useEnterSubmit(() => { if (!sending) submit() })

  return (
    <Modal
      open={captcha !== null}
      onClose={close}
      title="fullme 验证码"
      closeLabel="关闭"
      footer={(
        <>
          <Button variant="outline" onClick={abort} disabled={aborting}>
            {aborting ? '中止中…' : '中止'}
          </Button>
          <Button variant="primary" onClick={submit} disabled={sending}>
            {sending ? '发送中…' : '确认发送'}
          </Button>
        </>
      )}
    >
      {captcha !== null && (
        <>
          {/* 答错重来：服务端原话（图已自动刷新）先摆出来，人工据此重输。 */}
          {captcha.note !== undefined && captcha.note.trim() !== ''
            && <div style={NOTE_STYLE} role="status">{captcha.note}</div>}
          {/* eslint-disable-next-line @next/next/no-img-element -- 内部对话框, 直接用 img */}
          <img src={captcha.url ?? ''} alt="验证码图片" style={CAPTCHA_IMG_STYLE} />
          <div style={{...HINT_STYLE, display: 'flex', alignItems: 'center', gap: 4}}>
            请输入图片中的文字，如看不清可按 <span style={{cursor: 'pointer'}} onClick={refresh}>刷新 ↻</span>
          </div>
          <input
            style={{ ...FIELD_STYLE, marginTop: 4 }}
            value={cmd}
            autoFocus
            onFocus={(e) => {
              const len = e.target.value.length
              e.target.setSelectionRange(len, len)
            }}
            onChange={(e) => { setCmd(e.target.value); setError(null) }}
            onCompositionStart={() => { enter.composing.current = true }}
            onCompositionEnd={() => { enter.composing.current = false }}
            onKeyDown={enter.onKeyDown}
          />
          {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
          <div style={WARN_STYLE}>强行打断练功、战斗可能存在危险。</div>
        </>
      )}
    </Modal>
  )
}

/**
 * Add-user dialog for one server: account name + password.
 *
 * 密码不留在页面: `onAdd` 的契约是"把明文写进 host 凭据存储并落一条名单行",
 * 因此它是 **async** —— 凭据写入失败时**弹窗必须保持打开**并把 host 的原话显示
 * 出来 (值仍留在输入框, 用户改完可重试); 成功才关闭。早期实现是 `onAdd(...)`
 * 后立刻 `close()`, 异步失败就没有落点了。
 */
export function UserDialog({ open, serverName, onClose, onAdd }: {
  open: boolean
  serverName: string
  onClose: () => void
  onAdd: (input: { name: string; pass: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    setName('')
    setPass('')
    setError(null)
    setBusy(false)
    onClose()
  }
  const submit = (): void => {
    if (busy) return
    if (name.trim() === '') {
      setError('请输入用户名')
      return
    }
    // 官方 `credentials.set` 拒绝空值 (`min(1)`): 空密码根本写不进去, 就地拦下
    // 比让 host 回一句 `credential/rejected` 更清楚。
    if (pass === '') {
      setError('请输入密码')
      return
    }
    setBusy(true)
    setError(null)
    void onAdd({ name, pass })
      .then(() => { close() })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }
  const enter = useEnterSubmit(submit)

  return (
    <Modal
      open={open}
      onClose={close}
      title={`添加用户 — ${serverName}`}
      closeLabel="关闭"
      footer={(
        <>
          <Button variant="outline" onClick={close}>取消</Button>
          <Button variant="primary" onClick={submit}>{busy ? '保存中…' : '添加'}</Button>
        </>
      )}
    >
      <label style={LABEL_STYLE}>用户名</label>
      <input
        style={FIELD_STYLE}
        value={name}
        autoFocus
        placeholder="游戏账号"
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setName(e.target.value); setError(null) }}
        onCompositionStart={() => { enter.composing.current = true }}
        onCompositionEnd={() => { enter.composing.current = false }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>密码</label>
      <input
        style={FIELD_STYLE}
        type="password"
        value={pass}
        placeholder="登录密码 (写入 host 凭据存储, 不进浏览器名单)"
        onChange={(e) => { setPass(e.target.value); setError(null) }}
        onKeyDown={enter.onKeyDown}
      />
      {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
    </Modal>
  )
}
