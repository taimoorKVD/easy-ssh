/** Keyboard-interactive prompt handling. Answers are ephemeral: nothing here is written to disk or the keychain. */

export interface KeyboardPromptField {
  prompt: string
  /** Server echo flag. False means the response is hidden. */
  echo: boolean
}

export interface KeyboardChallenge {
  name: string
  instructions: string
  prompts: KeyboardPromptField[]
}

/** `null` is a user cancel. `'timeout'` means the wait elapsed. */
export type KeyboardReply = string[] | null | 'timeout'

export type KeyboardOutcome =
  | { type: 'answers'; answers: string[] }
  | { type: 'cancel'; reason: 'user' | 'timeout' | 'invalid' }

export const KEYBOARD_AUTH_TIMEOUT_MS = 90_000
export const MAX_KEYBOARD_PROMPTS = 16
export const MAX_KEYBOARD_ANSWER = 1024

/**
 * One-time-code prompts sometimes contain the word "password"
 * ("One-time password"). Those must not be filled with the saved login password.
 */
const ONE_TIME_RE =
  /\b(otp|totp|hotp|2fa|mfa|duo|passcode|one[-\s]?time|verification(?:\s+code)?|authenticator|security code|two[-\s]?factor)\b/i

/** Normalize ssh2 prompt objects. Hidden stays `echo: false` so a password prompt can auto-answer. */
export function promptFieldsFromServer(prompts: Array<{ prompt?: string; echo?: boolean }>): KeyboardPromptField[] {
  return prompts.map((prompt) => ({
    prompt: String(prompt.prompt ?? ''),
    echo: prompt.echo === true
  }))
}

export function isAutoPasswordPrompt(prompt: KeyboardPromptField): boolean {
  if (prompt.echo !== false) return false
  if (ONE_TIME_RE.test(prompt.prompt)) return false
  return /password/i.test(prompt.prompt)
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Decide the replies for one keyboard-interactive round.
 *
 * A saved password is used only when the server asks for exactly one hidden password
 * prompt. Every other prompt is passed to `ask`. This function does not store replies.
 */
export async function resolveKeyboardAuth(
  name: string,
  instructions: string,
  prompts: KeyboardPromptField[],
  savedPassword: string | undefined,
  ask: (challenge: KeyboardChallenge) => Promise<KeyboardReply>
): Promise<KeyboardOutcome> {
  if (prompts.length > MAX_KEYBOARD_PROMPTS) return { type: 'cancel', reason: 'invalid' }
  if (prompts.length === 0) return { type: 'answers', answers: [] }

  const saved = typeof savedPassword === 'string' && savedPassword.length > 0 ? savedPassword : undefined
  if (prompts.length === 1 && saved && isAutoPasswordPrompt(prompts[0])) {
    return { type: 'answers', answers: [saved] }
  }

  const reply = await ask({
    name: clip(name, 300),
    instructions: clip(instructions, 2000),
    prompts: prompts.map((prompt) => ({ prompt: clip(prompt.prompt, 500), echo: prompt.echo }))
  })
  if (reply === 'timeout') return { type: 'cancel', reason: 'timeout' }
  if (reply === null) return { type: 'cancel', reason: 'user' }
  if (reply.length !== prompts.length || reply.some((answer) => typeof answer !== 'string' || answer.length > MAX_KEYBOARD_ANSWER)) {
    return { type: 'cancel', reason: 'invalid' }
  }
  return { type: 'answers', answers: reply }
}
