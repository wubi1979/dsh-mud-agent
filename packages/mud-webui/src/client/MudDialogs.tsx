/**
 * dsh-mud-webui — roster dialogs (client half, core3).
 *
 * ServerDialog: 添加服务器（name/host/port/cwd）——v1 原样保留。
 * UserDialog: 添加用户（name/pass/preset）——新增 preset 下拉。
 * CaptchaDialog: 移除（core3 第一期不需要）。
 * @module @deepseek-ai/dsh-mud-webui/client/MudDialogs
 */

import { useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

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

/** Add-user dialog: account name + password + preset selection. */
export function UserDialog({ open, serverName, onClose, onAdd }: {
  open: boolean
  serverName: string
  onClose: () => void
  onAdd: (input: { name: string; pass: string; preset: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [preset, setPreset] = useState('mud-player')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (): void => { setName(''); setPass(''); setPreset('mud-player'); setError(null); setBusy(false); onClose() }
  const submit = (): void => {
    if (busy) return
    if (name.trim() === '') { setError('请输入用户名'); return }
    if (pass === '') { setError('请输入密码'); return }
    setBusy(true)
    setError(null)
    void onAdd({ name, pass, preset })
      .then(() => { close() })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); setBusy(false) })
  }
  const enter = useEnterSubmit(submit)

  return (
    <Modal open={open} onClose={close} title={`添加用户 — ${serverName}`} closeLabel="关闭"
      footer={<><Button variant="outline" onClick={close}>取消</Button><Button variant="primary" onClick={submit}>{busy ? '保存中…' : '添加'}</Button></>}
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
        placeholder="登录密码 (写入 host 凭据存储, 不进浏览器名单)"
        onChange={(e) => { setPass(e.target.value); setError(null) }}
        onKeyDown={enter.onKeyDown}
      />
      <label style={LABEL_STYLE}>Preset（Agent 装配）</label>
      <select style={FIELD_STYLE} value={preset}
        onChange={(e) => { setPreset(e.target.value) }}
      >
        {PRESET_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {error !== null && <div style={ERROR_STYLE} role="alert">{error}</div>}
    </Modal>
  )
}
