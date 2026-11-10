import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { isAutoPasswordPrompt, promptFieldsFromServer, resolveKeyboardAuth, type KeyboardPromptField } from '../src/shared/keyboard-auth.ts'

const passwordPrompt: KeyboardPromptField = { prompt: 'Password: ', echo: false }
const codePrompt: KeyboardPromptField = { prompt: 'Verification code: ', echo: false }

test('a hidden server prompt stays echo false so the saved password can be used', () => {
  const [field] = promptFieldsFromServer([{ prompt: 'Password: ', echo: false }])
  assert.equal(field.echo, false)
  assert.equal(isAutoPasswordPrompt(field), true)
  const [visible] = promptFieldsFromServer([{ prompt: 'Password: ', echo: true }])
  assert.equal(visible.echo, true)
  assert.equal(isAutoPasswordPrompt(visible), false)
})

test('a single hidden password prompt is answered with the saved password and the UI is not asked', async () => {
  const outcome = await resolveKeyboardAuth('Sign in', '', [passwordPrompt], 's3cret', async () => {
    throw new Error('UI should not be asked for a password prompt')
  })
  assert.deepEqual(outcome, { type: 'answers', answers: ['s3cret'] })
})

test('password prompts are matched case-insensitively only when echo is off', async () => {
  assert.equal(isAutoPasswordPrompt({ prompt: "user@host's password: ", echo: false }), true)
  assert.equal(isAutoPasswordPrompt({ prompt: 'PASSWORD', echo: false }), true)
  assert.equal(isAutoPasswordPrompt({ prompt: 'Password: ', echo: true }), false)
  const visible = await resolveKeyboardAuth('', '', [{ prompt: 'Password: ', echo: true }], 's3cret', async () => ['typed'])
  assert.deepEqual(visible, { type: 'answers', answers: ['typed'] })
})

test('a password prompt without a saved password is requested from the UI', async () => {
  let asked = false
  const outcome = await resolveKeyboardAuth('', '', [passwordPrompt], '', async (challenge) => {
    asked = true
    assert.equal(challenge.prompts[0].echo, false)
    return ['typed-once']
  })
  assert.equal(asked, true)
  assert.deepEqual(outcome, { type: 'answers', answers: ['typed-once'] })
})

test('verification, OTP, and Duo prompts are requested from the UI and the saved password is not submitted', async () => {
  for (const prompt of ['Verification code: ', 'OTP: ', 'Duo Mobile passcode: ', 'One-time password: ']) {
    const outcome = await resolveKeyboardAuth('MFA', 'Enter the code from your app', [{ prompt, echo: false }], 's3cret', async (challenge) => {
      assert.equal(challenge.name, 'MFA')
      assert.match(challenge.instructions, /code from your app/)
      assert.equal(challenge.prompts.length, 1)
      assert.equal(challenge.prompts[0].prompt, prompt)
      assert.equal(challenge.prompts[0].echo, false)
      return ['654321']
    })
    assert.deepEqual(outcome, { type: 'answers', answers: ['654321'] })
    if (outcome.type === 'answers') assert.notEqual(outcome.answers[0], 's3cret')
  }
})

test('a password prompt bundled with another prompt is asked in full, using the UI answers', async () => {
  const outcome = await resolveKeyboardAuth(
    '',
    '',
    [passwordPrompt, codePrompt],
    's3cret',
    async (challenge) => {
      assert.deepEqual(
        challenge.prompts.map((item) => item.prompt),
        ['Password: ', 'Verification code: ']
      )
      return ['typed-password', '654321']
    }
  )
  assert.deepEqual(outcome, { type: 'answers', answers: ['typed-password', '654321'] })
})

test('cancel returns no answers and does not reuse the saved password', async () => {
  const outcome = await resolveKeyboardAuth('MFA', 'Enter the code', [codePrompt], 's3cret', async () => null)
  assert.deepEqual(outcome, { type: 'cancel', reason: 'user' })
})

test('a timeout cancels instead of submitting the saved password', async () => {
  const outcome = await resolveKeyboardAuth('', '', [codePrompt], 's3cret', async () => 'timeout')
  assert.deepEqual(outcome, { type: 'cancel', reason: 'timeout' })
})

test('the jump host uses the same rules with that hop’s own password', async () => {
  const jumpPassword = 'jump-secret'
  const passwordRound = await resolveKeyboardAuth('', '', [passwordPrompt], jumpPassword, async () => {
    throw new Error('jump password prompt should be automatic')
  })
  assert.deepEqual(passwordRound, { type: 'answers', answers: [jumpPassword] })

  const codeRound = await resolveKeyboardAuth('', '', [codePrompt], jumpPassword, async () => null)
  assert.deepEqual(codeRound, { type: 'cancel', reason: 'user' })
})

test('prompt answers are not written by the helper', () => {
  const src = readFileSync(new URL('../src/shared/keyboard-auth.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /safeStorage|setSecret|writeFile|localStorage|appendFile/)
})
