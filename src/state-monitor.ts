import { EventEmitter } from 'node:events'

interface ServerRequestEnvelope {
  type: 'server-request'
  rpcId: string
  method: string
  payload: { type: string; [key: string]: unknown }
}

/**
 * Best-effort native-state bridge: subscribes to the host's WebSocket downlink
 * streams and surfaces approval/question/error activity as app events. It is
 * deliberately defensive — a dropped socket or malformed frame never crashes
 * the shell, it just stops updating the badge/notifications.
 */
export class HostStateMonitor extends EventEmitter {
  private readonly muxUrl: string
  private readonly hostUrl: string
  private mux: WebSocket | null = null
  private host: WebSocket | null = null
  private approvals = 0
  private questions = 0

  constructor(baseUrl: string) {
    super()
    const u = new URL(baseUrl)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = '/api/events.mux'
    this.muxUrl = u.toString()
    u.pathname = '/api/events.host'
    this.hostUrl = u.toString()
  }

  start(): void {
    this.mux = this.connect(this.muxUrl, (env) => this.handleMux(env))
    this.host = this.connect(this.hostUrl, (env) => this.handleHost(env))
  }

  stop(): void {
    this.mux?.close()
    this.host?.close()
    this.mux = null
    this.host = null
  }

  private connect(url: string, onEnvelope: (env: ServerRequestEnvelope) => void): WebSocket {
    const ws = new WebSocket(url)
    ws.addEventListener('message', (event) => {
      const env = parseEnvelope(event.data)
      if (env !== null) onEnvelope(env)
    })
    ws.addEventListener('error', () => {
      this.emit('monitor-error')
    })
    return ws
  }

  private handleMux(env: ServerRequestEnvelope): void {
    switch (env.method) {
      case 'approval/requested':
        this.approvals += 1
        this.emitPending()
        this.emit('notify', {
          title: '审批请求',
          body: `工具 ${String(env.payload.toolName ?? '')} 需要你的确认`.trim(),
        })
        break
      case 'approval/resolved':
        this.approvals = Math.max(0, this.approvals - 1)
        this.emitPending()
        break
      case 'question/requested':
        this.questions += 1
        this.emitPending()
        this.emit('notify', { title: '需要你的回答', body: 'Agent 向你提了一个问题' })
        break
      case 'question/resolved':
        this.questions = Math.max(0, this.questions - 1)
        this.emitPending()
        break
    }
  }

  private handleHost(env: ServerRequestEnvelope): void {
    if (env.method === 'host/agent-error') {
      this.emit('notify', {
        title: 'Agent 出错',
        body: String(env.payload.message ?? ''),
      })
    }
  }

  private emitPending(): void {
    this.emit('pending-change', this.approvals + this.questions)
  }
}

function parseEnvelope(data: unknown): ServerRequestEnvelope | null {
  try {
    const msg = JSON.parse(String(data)) as Partial<ServerRequestEnvelope>
    if (msg.type !== 'server-request' || typeof msg.method !== 'string') return null
    const payload = msg.payload as Record<string, unknown> | undefined
    return {
      type: 'server-request',
      rpcId: String(msg.rpcId ?? ''),
      method: msg.method,
      payload: { type: String(payload?.type ?? ''), ...(payload ?? {}) },
    }
  } catch {
    return null
  }
}
