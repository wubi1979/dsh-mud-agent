/**
 * dsh-mud-webui — roster dialogs (client half).
 *
 * Controlled Modal forms for adding a MUD server (host:port) and adding a
 * user account to a server. Plain controlled inputs; Enter submits, Escape
 * closes via the Modal. Product copy is Chinese, comments are English.
 * @module @deepseek-ai/dsh-mud-webui/client/MudDialogs
 */

import { useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

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
