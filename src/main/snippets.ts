import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { Snippet, SnippetInput } from '../shared/snippets'
import { dataDir, encryptionStatus, writePrivate } from './store'

const MAX_SNIPPETS = 500

/** Snippets are kept as one OS-encrypted blob (safeStorage); nothing is written in plain text. */
export class SnippetStore {
  private cache: Snippet[] | null = null
  private file = join(dataDir(), 'snippets.enc')

  async list(): Promise<Snippet[]> {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) return (this.cache = [])
    const status = await encryptionStatus()
    if (!status.available) throw new Error('The OS keychain is unavailable, so snippets cannot be read.')
    const raw = Buffer.from(readFileSync(this.file, 'utf8').trim(), 'base64')
    const { result: text } = await safeStorage.decryptStringAsync(raw)
    const parsed = JSON.parse(text) as { version: 1; snippets: Snippet[] }
    this.cache = Array.isArray(parsed.snippets) ? parsed.snippets : []
    return this.cache
  }

  async save(input: SnippetInput): Promise<Snippet> {
    const list = [...(await this.list())]
    const now = Date.now()
    const index = input.id ? list.findIndex((s) => s.id === input.id) : -1
    const next: Snippet = { id: index >= 0 ? list[index].id : randomUUID(), name: input.name, command: input.command, connectionId: input.connectionId, updatedAt: now }
    if (index >= 0) list[index] = next
    else {
      if (list.length >= MAX_SNIPPETS) throw new Error('Snippet limit reached.')
      list.push(next)
    }
    await this.persist(list)
    return next
  }

  async remove(id: string): Promise<void> {
    await this.persist((await this.list()).filter((s) => s.id !== id))
  }

  private async persist(list: Snippet[]): Promise<void> {
    const status = await encryptionStatus()
    if (!status.available) throw new Error('The OS keychain is unavailable, so snippets cannot be saved securely.')
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ version: 1, snippets: list }))
    writePrivate(this.file, `${Buffer.from(encrypted).toString('base64')}\n`)
    this.cache = list
  }
}
