import assert from 'node:assert/strict'
import { it } from 'node:test'
import { decryptBackup, encryptBackup } from '../src/main/backup-crypto.ts'

it('round-trips, rejects wrong password, tampering and hostile KDF params', async () => {
  const text = await encryptBackup({ a: [1, 'x'] }, 'correct horse battery', 1 << 14)
  assert.deepEqual(await decryptBackup(text, 'correct horse battery'), { a: [1, 'x'] })
  await assert.rejects(decryptBackup(text, 'wrong password!!'), /Wrong password/)
  const env = JSON.parse(text)
  const flipped = { ...env, kdf: { ...env.kdf, N: 1 << 15 } }
  await assert.rejects(decryptBackup(JSON.stringify(flipped), 'correct horse battery'), /Wrong password/)
  await assert.rejects(decryptBackup(JSON.stringify({ ...env, kdf: { ...env.kdf, N: 1 << 30 } }), 'x'), /Unsupported/)
  await assert.rejects(encryptBackup({}, 'short'), /at least/)
  assert.ok(!text.includes('"x"'))
})
