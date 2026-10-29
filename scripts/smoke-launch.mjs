// Launch smoke check: start the built app for a few seconds and fail on any main-process exception.
import { spawn } from 'node:child_process'
import electron from 'electron'

const seconds = Number(process.env.SMOKE_SECONDS || 8)
const child = spawn(electron, ['.', '--no-sandbox'], { env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))
const bad = /(Uncaught|Unhandled|SyntaxError|TypeError|ReferenceError|Error \[ERR_|A JavaScript error occurred)/
let exited = null
child.on('exit', (code) => (exited = code))
setTimeout(() => {
  const alive = exited === null
  if (alive) child.kill()
  if (!alive || bad.test(out)) {
    console.error(`Launch smoke check FAILED (exited=${exited})\n${out}`)
    process.exit(1)
  }
  console.log(`Launch smoke check passed: app stayed up ${seconds}s with no main-process error.`)
  process.exit(0)
}, seconds * 1000)
