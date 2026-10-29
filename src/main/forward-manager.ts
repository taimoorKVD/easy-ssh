import { createServer, connect as netConnect, type Server, type Socket } from 'node:net'
import type { Client, ClientChannel } from 'ssh2'
import { parseSocksConnect, type ForwardRule } from '../shared/forwards'

export interface ForwardState {
  sessionId: string
  ruleId: string
  active: boolean
  error?: string
}

interface Running {
  rule: ForwardRule
  client: Client
  server?: Server
  sockets: Set<Socket | ClientChannel>
  stop: () => void
}

const MAX_SOCKETS_PER_RULE = 256

function pipe(a: Socket, b: ClientChannel, sockets: Set<Socket | ClientChannel>): void {
  sockets.add(a)
  sockets.add(b)
  const done = (): void => {
    sockets.delete(a)
    sockets.delete(b)
    a.destroy()
    try {
      b.close()
    } catch {
      // already closed
    }
  }
  a.on('error', done).on('close', done)
  b.on('error', done).on('close', done)
  a.pipe(b).pipe(a)
}

/** Runs -L, -R and -D style forwards over a live session's ssh2 client. */
export class ForwardManager {
  private running = new Map<string, Running>()

  constructor(private readonly emit: (state: ForwardState) => void) {}

  private key(sessionId: string, ruleId: string): string {
    return `${sessionId}:${ruleId}`
  }

  list(sessionId: string): string[] {
    return [...this.running.keys()].filter((k) => k.startsWith(`${sessionId}:`)).map((k) => k.slice(sessionId.length + 1))
  }

  async start(sessionId: string, client: Client, rule: ForwardRule): Promise<void> {
    const key = this.key(sessionId, rule.id)
    if (this.running.has(key)) return
    const entry: Running = { rule, client, sockets: new Set(), stop: () => undefined }
    if (rule.type === 'remote') await this.startRemote(entry)
    else await this.startListener(entry)
    this.running.set(key, entry)
    client.once('close', () => this.stop(sessionId, rule.id))
    this.emit({ sessionId, ruleId: rule.id, active: true })
  }

  stop(sessionId: string, ruleId: string): void {
    const key = this.key(sessionId, ruleId)
    const entry = this.running.get(key)
    if (!entry) return
    this.running.delete(key)
    entry.stop()
    for (const s of entry.sockets) {
      try {
        if ('destroy' in s && typeof (s as Socket).destroy === 'function') (s as Socket).destroy()
        else (s as ClientChannel).close()
      } catch {
        // ignore
      }
    }
    this.emit({ sessionId, ruleId, active: false })
  }

  stopSession(sessionId: string): void {
    for (const ruleId of this.list(sessionId)) this.stop(sessionId, ruleId)
  }

  private startListener(entry: Running): Promise<void> {
    const { rule, client } = entry
    const server = createServer((socket) => {
      if (entry.sockets.size >= MAX_SOCKETS_PER_RULE * 2) {
        socket.destroy()
        return
      }
      socket.on('error', () => socket.destroy())
      if (rule.type === 'local') {
        client.forwardOut('127.0.0.1', 0, rule.destHost, rule.destPort, (err, stream) => {
          if (err || !stream) return void socket.destroy()
          pipe(socket, stream, entry.sockets)
        })
        return
      }
      // SOCKS5, no auth, CONNECT only.
      let stage: 'greet' | 'request' = 'greet'
      let buf = Buffer.alloc(0)
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk])
        if (buf.length > 600) return void socket.destroy()
        if (stage === 'greet') {
          if (buf.length < 2) return
          const n = buf[1]
          if (buf[0] !== 5) return void socket.destroy()
          if (buf.length < 2 + n) return
          const methods = buf.subarray(2, 2 + n)
          if (!methods.includes(0)) {
            socket.end(Buffer.from([5, 0xff]))
            return
          }
          socket.write(Buffer.from([5, 0]))
          buf = buf.subarray(2 + n)
          stage = 'request'
        }
        let req: ReturnType<typeof parseSocksConnect>
        try {
          req = parseSocksConnect(buf)
        } catch {
          socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))
          return
        }
        if (!req) return
        socket.off('data', onData)
        socket.pause()
        const rest = buf.subarray(req.length)
        client.forwardOut('127.0.0.1', 0, req.host, req.port, (err, stream) => {
          if (err || !stream) {
            socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
            return
          }
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          if (rest.length) stream.write(rest)
          pipe(socket, stream, entry.sockets)
          socket.resume()
        })
      }
      socket.on('data', onData)
    })
    entry.server = server
    entry.stop = () => server.close()
    return new Promise((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        reject(new Error(error.code === 'EADDRINUSE' ? `Port ${rule.bindPort} is already in use on this computer.` : error.message))
      })
      server.listen(rule.bindPort, rule.bindHost, () => resolve())
    })
  }

  private startRemote(entry: Running): Promise<void> {
    const { rule, client } = entry
    const onTcp = (
      info: { destIP: string; destPort: number },
      accept: () => ClientChannel,
      reject: () => void
    ): void => {
      if (info.destPort !== rule.bindPort || entry.sockets.size >= MAX_SOCKETS_PER_RULE * 2) return void reject()
      const local = netConnect(rule.destPort, rule.destHost)
      local.once('connect', () => pipe(local, accept(), entry.sockets))
      local.once('error', () => {
        local.destroy()
        reject()
      })
    }
    client.on('tcp connection', onTcp)
    entry.stop = () => {
      client.off('tcp connection', onTcp)
      client.unforwardIn(rule.bindHost, rule.bindPort, () => undefined)
    }
    return new Promise((resolve, reject) => {
      client.forwardIn(rule.bindHost, rule.bindPort, (err) => {
        if (err) {
          client.off('tcp connection', onTcp)
          reject(new Error(`The server refused to listen on ${rule.bindHost}:${rule.bindPort}. ${err.message}`))
        } else resolve()
      })
    })
  }
}
