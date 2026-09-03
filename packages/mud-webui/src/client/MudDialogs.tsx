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
  marginTop: 10,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-interactive-bg-hover)',
  background: '#fff',
}

const HINT_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  marginTop: 10,
}

/**
 * fullme 验证码对话框 (自驱动): 状态在 MudSocketController 的 captcha 存储
 * (替换语义, 全局唯一不叠开) — 新 captcha 事件整体覆盖当前对话框 (含 host
 * 侧 OCR 完成后的增量预填事件, 命令框预填 "fullme <文字>")。确认 → 经
 * /mud/command 并行发送 (不经过 agent/流程); 中止 → 仅关闭。用户可随时
 * 修改命令框内容再发送。
 */
export function CaptchaDialog({ mudSocket, sendCommand }: {
  mudSocket: MudSocketController
  sendCommand: (cmd: string) => Promise<boolean>
}) {
  const snapshot = useSyncExternalStore(
    listener => mudSocket.subscribeCaptcha(listener),
    () => mudSocket.getCaptcha(),
  )
  const captcha = snapshot.captcha
  const [cmd, setCmd] = useState('fullme')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  // 新验证码事件 → 重置命令预填 (host: 'fullme' 或 OCR 后 'fullme <文字>')。
  useEffect(() => {
    if (captcha === null) return
    setCmd(captcha.cmd ?? 'fullme')
    setError(null)
  }, [captcha])

  const close = (): void => { mudSocket.clearCaptcha() }
  const submit = (): void => {
    const trimmed = cmd.trim()
    if (trimmed === '') {
      setError('请输入完整命令 (fullme 文字)')
      return
    }
    setSending(true)
    void Promise.resolve(sendCommand(trimmed))
      .then((ok) => {
        if (ok) { close() } else { setError('发送失败 (游戏可能未连接), 请重试') }
      })
      .catch(() => { setError('发送失败, 请重试') })
      .finally(() => { setSending(false) })
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
          <Button variant="outline" onClick={close}>中止</Button>
          <Button variant="primary" onClick={submit} disabled={sending}>
            {sending ? '发送中…' : '确认发送'}
          </Button>
        </>
      )}
    >
      {captcha !== null && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- 内部对话框, 直接用 img */}
          <img src={captcha.url ?? ''} alt="验证码图片" style={CAPTCHA_IMG_STYLE} />
          <div style={HINT_STYLE}>请输入图片中的文字 (识别错误可在游戏内重试)</div>
          <input
            style={{ ...FIELD_STYLE, marginTop: 4 }}
            value={cmd}
            autoFocus
            onFocus={(e) => { e.target.select() }}
            onChange={(e) => { setCmd(e.target.value); setError(null) }}
            onCompositionStart={() => { enter.composing.current = true }}
            onCompositionEnd={() => { enter.composing.current = false }}
            onKeyDown={enter.onKeyDown}
          />
          {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
        </>
      )}
    </Modal>
  )
}

/** Add-user dialog for one server: account name + password. */
export function UserDialog({ open, serverName, onClose, onAdd }: {
  open: boolean
  serverName: string
  onClose: () => void
  onAdd: (input: { name: string; pass: string }) => void
}) {
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)

  const close = (): void => {
    setName('')
    setPass('')
    setError(null)
    onClose()
  }
  const submit = (): void => {
    if (name.trim() === '') {
      setError('请输入用户名')
      return
    }
    onAdd({ name, pass })
    close()
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
          <Button variant="primary" onClick={submit}>添加</Button>
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
        placeholder="登录密码"
        onChange={(e) => { setPass(e.target.value); setError(null) }}
        onKeyDown={enter.onKeyDown}
      />
      {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
    </Modal>
  )
}
