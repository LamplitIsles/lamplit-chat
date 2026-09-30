import { Value } from 'typebox/value'
import type { Static, TSchema } from 'typebox'
import { MATERIAL_LIMITS as L, type MaterialErrorCode, type MaterialReply, type MaterialRequest, FileCreateSchema, FileUpdateSchema, ResetSchema } from '../shared/companion-materials'
import type { ComputerWorkspace } from './computer-workspace'
import { DEFAULT_COMPANION_COMPACTION_PROMPT } from './companion-compaction-prompt'
import { hashSourceId } from './history-import-api'
import { WORKSPACE_ROOT } from './workspace-root'

export class MaterialFailure extends Error {
  constructor(readonly code: MaterialErrorCode, readonly status = 400) { super(code) }
}
export function materialCheck<T extends TSchema>(schema: T, input: unknown): Static<T> {
  if (!Value.Check(schema, input)) throw new MaterialFailure('invalid-data')
  return input
}
export async function materialReply(operation: () => Promise<MaterialReply>): Promise<MaterialReply> {
  try { return await operation() }
  catch (error) {
    const failure = error instanceof MaterialFailure ? error : new MaterialFailure('internal-error', 500)
    return { status: failure.status, body: { error: { code: failure.code } } }
  }
}
export function rootBasename(name: string): string {
  if (!name || name.length > L.basenameCharacters || /[\\/\p{Cc}\p{Cf}]/u.test(name) || name === '.' || name === '..' || !name.endsWith('.md')) throw new MaterialFailure('invalid-data')
  return name
}
export function validFileContent(name: string, content: string): void {
  if (new TextEncoder().encode(content).byteLength > L.fileBytes) throw new MaterialFailure('resource-limit', 413)
  if (name === 'COMPACTION.md' && !content.trim()) throw new MaterialFailure('invalid-data')
}
export class CompanionFiles {
  constructor(private workspace: ComputerWorkspace) {}
  private path(name: string): string { return `${WORKSPACE_ROOT}/${rootBasename(name)}` }
  async read(name: string) {
    const path = this.path(name), stat = await this.workspace.stub().fs.lstatOrNull(path)
    if (!stat) return null
    if (!stat.isFile) throw new MaterialFailure('invalid-data')
    if (stat.size > L.fileBytes) throw new MaterialFailure('resource-limit', 413)
    const bytes = await this.workspace.readFileBytes(path)
    if (bytes === null) return null
    if (bytes.byteLength > L.fileBytes) throw new MaterialFailure('resource-limit', 413)
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw new MaterialFailure('invalid-data') }
    validFileContent(name, content)
    return { name, content, version: await hashSourceId(content), bytes: bytes.byteLength }
  }
  async effective() {
    const file = await this.read('COMPACTION.md')
    return file ? { mode: 'custom' as const, content: file.content, version: file.version, bytes: file.bytes } : {
      mode: 'default' as const, content: DEFAULT_COMPANION_COMPACTION_PROMPT, version: 'default', bytes: new TextEncoder().encode(DEFAULT_COMPANION_COMPACTION_PROMPT).byteLength,
    }
  }
  async request({ action, id = '', input }: MaterialRequest): Promise<MaterialReply> {
    if (action === 'file-list') {
      const entries = await this.workspace.fs.readdir(WORKSPACE_ROOT, { limit: L.rootEntries + 1 })
      if (entries.length > L.rootEntries) throw new MaterialFailure('resource-limit', 413)
      const files = entries.filter(e => e.isFile && e.name.endsWith('.md')).map(e => ({ name: e.name, bytes: e.size })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      return { status: 200, body: { files } }
    }
    if (action === 'compaction-read') return { status: 200, body: await this.effective() }
    if (action === 'file-read') {
      const file = await this.read(id)
      if (!file) throw new MaterialFailure('not-found', 404)
      return { status: 200, body: file }
    }
    if (action === 'compaction-reset') {
      const { expectedVersion } = materialCheck(ResetSchema, input)
      const current = await this.effective()
      if (current.version !== expectedVersion) throw new MaterialFailure('conflict', 409)
      if (current.mode === 'custom') await this.workspace.rm(this.path('COMPACTION.md'))
      return { status: 200, body: await this.effective() }
    }
    const name = action === 'compaction-save' ? 'COMPACTION.md' : rootBasename(id)
    const data = action === 'file-create' ? materialCheck(FileCreateSchema, input) : materialCheck(FileUpdateSchema, input)
    validFileContent(name, data.content)
    if (action === 'file-create') {
      if (await this.workspace.stub().fs.lstatOrNull(this.path(name))) throw new MaterialFailure('conflict', 409)
    } else {
      const current = action === 'compaction-save' ? await this.effective() : await this.read(name)
      if (!current) throw new MaterialFailure('not-found', 404)
      if (current.version !== (data as Static<typeof FileUpdateSchema>).expectedVersion) throw new MaterialFailure('conflict', 409)
    }
    await this.workspace.writeFile(this.path(name), data.content)
    return { status: action === 'file-create' ? 201 : 200, body: action === 'compaction-save' ? await this.effective() : (await this.read(name))! }
  }
}
