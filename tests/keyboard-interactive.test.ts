import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import ssh2 from 'ssh2'
import { promptFieldsFromServer, resolveKeyboardAuth, type KeyboardReply } from '../src/shared/keyboard-auth.ts'

const { Client, Server } = ssh2

function hostKey(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easy-ssh-kbd-'))
  const path = join(dir, 'host')
  const result = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', path, '-N', '', '-q'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'ssh-keygen failed')
  const pem = readFileSync(path, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return pem
}

const HOST_KEY = hostKey()

type AuthCtx = {
  method: string
  reject: (methods?: string[]) => void
  accept: () => void
  prompt: (
    prompts: Array<{ prompt: string; echo: boolean }>,
    title: string,
    instructions: string,
    cb: (answers: string[] | Error) => void
  ) => void
}

function listen(onAuth: (ctx: AuthCtx) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const clients = new Set<{ end: () => void }>()
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => onAuth(ctx as unknown as AuthCtx))
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('READY\n')
          stream.exit(0)
          stream.end()
        })
      })
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('test server has no port'))
        return
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            for (const client of clients) client.end()
            server.close(() => done())
          })
      })
    })
  })
}

/** Same decision the app uses: saved password only for a password prompt, otherwise `ask`. */
function answer(
  savedPassword: string,
  ask: (prompts: Array<{ prompt: string; echo: boolean }>) => Promise<KeyboardReply>
) {
  return (name: string, instructions: string, _lang: string, prompts: Array<{ prompt: string; echo?: boolean }>, finish: (answers: string[]) => void): void => {
    const fields = promptFieldsFromServer(prompts)
    void resolveKeyboardAuth(name, instructions, fields, savedPassword, async (challenge) => ask(challenge.prompts)).then((outcome) => {
      if (outcome.type === 'cancel') return
      finish(outcome.answers)
    })
  }
}

test('ssh2 keyboard-interactive: password is automatic, verification code comes from the ask callback', { timeout: 15_000 }, async () => {
  const seen: string[][] = []
  const asked: string[] = []
  const server = await listen((ctx) => {
    if (ctx.method === 'password') {
      ctx.reject(['keyboard-interactive'])
      return
    }
    if (ctx.method !== 'keyboard-interactive') {
      ctx.reject(['keyboard-interactive'])
      return
    }
    ctx.prompt([{ prompt: 'Password: ', echo: false }], 'Sign in', 'Use your password', (answers) => {
      if (answers instanceof Error) return
      seen.push(answers)
      if (answers[0] !== 's3cret') {
        ctx.reject()
        return
      }
      ctx.prompt([{ prompt: 'Verification code: ', echo: false }], 'MFA', 'Enter the code from your app', (codes) => {
        if (codes instanceof Error) return
        seen.push(codes)
        if (codes.length === 1 && codes[0] === '654321') ctx.accept()
        else ctx.reject()
      })
    })
  })

  const output = await new Promise<string>((resolve, reject) => {
    const client = new Client()
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('timed out waiting for the shell'))), 8000)
    client.on('keyboard-interactive', answer('s3cret', async (prompts) => {
      asked.push(...prompts.map((prompt) => `${prompt.prompt}:${prompt.echo}`))
      return ['654321']
    }))
    client.on('ready', () => {
      client.shell((error, stream) => {
        if (error || !stream) {
          finish(() => reject(error ?? new Error('no shell')))
          return
        }
        let text = ''
        stream.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
        })
        stream.on('close', () => finish(() => resolve(text)))
      })
    })
    client.on('error', (error) => finish(() => reject(error)))
    client.connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'user',
      password: 's3cret',
      tryKeyboard: true,
      readyTimeout: 8000,
      hostVerifier: (key: Buffer) => Buffer.isBuffer(key)
    })
  }).finally(() => server.close())

  assert.match(output, /READY/)
  assert.deepEqual(seen, [['s3cret'], ['654321']])
  assert.deepEqual(asked, ['Verification code: :false'])
})

test('ssh2 keyboard-interactive: cancel ends the connection without sending the saved password', { timeout: 15_000 }, async () => {
  let responses: string[] | Error | null = null
  const server = await listen((ctx) => {
    if (ctx.method !== 'keyboard-interactive') {
      ctx.reject(['keyboard-interactive'])
      return
    }
    ctx.prompt([{ prompt: 'Verification code: ', echo: false }], 'MFA', '', (answers) => {
      responses = answers
      ctx.reject()
    })
  })

  await new Promise<void>((resolve, reject) => {
    const client = new Client()
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end()
      resolve()
    }
    const timer = setTimeout(() => {
      client.end()
      reject(new Error('timed out waiting for cancel'))
    }, 8000)
    client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
      void resolveKeyboardAuth(name, instructions, promptFieldsFromServer(prompts), 's3cret', async () => null).then((outcome) => {
        assert.equal(outcome.type, 'cancel')
        // Do not call finish(): that would send the saved password or an empty code.
        void finish
        client.end()
      })
    })
    client.on('close', done)
    client.on('error', done)
    client.connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'user',
      tryKeyboard: true,
      readyTimeout: 8000,
      hostVerifier: (key: Buffer) => Buffer.isBuffer(key)
    })
  }).finally(() => server.close())

  assert.equal(Array.isArray(responses), false)
})
