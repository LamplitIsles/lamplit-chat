import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { SessionSearchResult } from '../shared/pi-contract'
import type { ComputerWorkspace } from './computer-workspace'
import { requireWorkspacePath, WORKSPACE_ROOT } from './workspace-root'

type RegistrySearch = {
  searchSessions(input: { query: string; limit?: number }): Promise<SessionSearchResult[]>
}

const text = (value: unknown) => ({
  content: [{
    type: 'text' as const,
    text: typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)),
  }],
  details: {},
})

export function createWorkspaceTools(workspace: ComputerWorkspace) {
  const maxFileBytes = 128_000
  const maxSearchFiles = 200
  function requireSearchPattern(pattern: string): void {
    if (!pattern || pattern.includes('\0') || pattern.split('/').includes('..')) throw new Error('Search pattern must stay inside /workspace.')
    if (pattern.startsWith('/')) requireWorkspacePath(pattern)
  }
  async function assertSearchBudget(): Promise<void> {
    if (!await workspace.stat(WORKSPACE_ROOT)) return
    const pending = [WORKSPACE_ROOT]
    let visited = 0
    while (pending.length) {
      const entries = await workspace.readDir(pending.pop()!, { limit: maxSearchFiles + 1 })
      visited += entries.length
      if (visited > maxSearchFiles) throw new Error('Workspace exceeds the 200-entry search limit.')
      for (const entry of entries) if (entry.type === 'directory') pending.push(entry.path)
    }
  }
  const readSchema = Type.Object({ path: Type.String({ description: 'Absolute workspace path' }) })
  const writeSchema = Type.Object({
    path: Type.String({ description: 'Absolute workspace path' }),
    content: Type.String({ description: 'Complete file contents' }),
  })
  const editSchema = Type.Object({
    path: Type.String({ description: 'Absolute workspace path' }),
    search: Type.String({ minLength: 1, description: 'Non-empty exact text to replace' }),
    replacement: Type.String({ description: 'Replacement text' }),
  })
  const listSchema = Type.Object({
    path: Type.Optional(Type.String({ description: `Directory path, defaults to ${WORKSPACE_ROOT}` })),
  })
  const findSchema = Type.Object({ pattern: Type.String({ description: 'Glob pattern, such as **/*.ts' }) })
  const grepSchema = Type.Object({
    pattern: Type.String({ description: 'File glob to search' }),
    query: Type.String({ description: 'Text or regular expression to find' }),
  })

  const readTool: AgentHarnessTool<undefined, typeof readSchema> = {
    name: 'read',
    label: 'Read file',
    description: 'Read a UTF-8 file from the durable workspace.',
    parameters: readSchema,
    execute: async (_id, { path }, _onUpdate, _toolContext, _invocation, context) => {
      const signal = context.abortSignal
      signal?.throwIfAborted()
      requireWorkspacePath(path)
      if (((await workspace.stat(path))?.size ?? 0) > maxFileBytes) throw new Error('File exceeds the 128 KB read limit.')
      const content = await workspace.readFile(path)
      signal?.throwIfAborted()
      if (content === null) throw new Error(`File not found: ${path}`)
      return text(content)
    },
  }
  const writeTool: AgentHarnessTool<undefined, typeof writeSchema> = {
    name: 'write',
    label: 'Write file',
    description: 'Write a complete UTF-8 file to the durable workspace.',
    parameters: writeSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, content }, _onUpdate, _toolContext, _invocation, context) => {
      const signal = context.abortSignal
      signal?.throwIfAborted()
      requireWorkspacePath(path)
      if (new TextEncoder().encode(content).byteLength > maxFileBytes) throw new Error('File exceeds the 128 KB limit.')
      await workspace.writeFile(path, content)
      signal?.throwIfAborted()
      return text(`Wrote ${path}`)
    },
  }
  const editTool: AgentHarnessTool<undefined, typeof editSchema> = {
    name: 'edit',
    label: 'Edit file',
    description: 'Replace exact text in a durable workspace file.',
    parameters: editSchema,
    executionMode: 'sequential',
    execute: async (_id, { path, search, replacement }, _onUpdate, _toolContext, _invocation, context) => {
      const signal = context.abortSignal
      signal?.throwIfAborted()
      requireWorkspacePath(path)
      if (((await workspace.stat(path))?.size ?? 0) > maxFileBytes) throw new Error('File exceeds the 128 KB edit limit.')
      const content = await workspace.readFile(path)
      if (content === null) throw new Error(`File not found: ${path}`)
      if (new TextEncoder().encode(content.replace(search, replacement)).byteLength > maxFileBytes) throw new Error('File exceeds the 128 KB limit.')
      const occurrences = content.split(search).length - 1
      if (occurrences !== 1) throw new Error(`Expected exactly one match in ${path}, found ${occurrences}.`)
      await workspace.writeFile(path, content.replace(search, replacement))
      signal?.throwIfAborted()
      return text(`Updated ${path}`)
    },
  }
  const listTool: AgentHarnessTool<undefined, typeof listSchema> = {
    name: 'list',
    label: 'List directory',
    description: 'List files and directories in the durable workspace.',
    parameters: listSchema,
    execute: async (_id, { path }, _onUpdate, _toolContext, _invocation, context) => {
      const signal = context.abortSignal
      signal?.throwIfAborted()
      const directory = requireWorkspacePath(path ?? WORKSPACE_ROOT)
      const result = await workspace.readDir(directory, { limit: maxSearchFiles + 1 })
      if (result.length > maxSearchFiles) throw new Error('Directory contains more than 200 entries.')
      signal?.throwIfAborted()
      return text(result)
    },
  }
  const findTool: AgentHarnessTool<undefined, typeof findSchema> = {
    name: 'find',
    label: 'Find files',
    description: 'Find durable workspace files using a glob pattern.',
    parameters: findSchema,
    execute: async (_id, { pattern }, _onUpdate, _toolContext, _invocation, context) => {
      const signal = context.abortSignal
      signal?.throwIfAborted()
      requireSearchPattern(pattern)
      await assertSearchBudget()
      const result = await workspace.glob(pattern)
      if (result.length > maxSearchFiles) throw new Error('Search matches more than 200 files; narrow the pattern.')
      signal?.throwIfAborted()
      return text(result)
    },
  }
  const grepTool: AgentHarnessTool<undefined, typeof grepSchema> = {
    name: 'grep',
    label: 'Search files',
    description: 'Search matching durable workspace files for text.',
    parameters: grepSchema,
    execute: async (_id, { pattern, query }, _onUpdate, _toolContext, _invocation, context) => {
      const signal = context.abortSignal
      signal?.throwIfAborted()
      requireSearchPattern(pattern)
      if (query.length > 128) throw new Error('Search query exceeds 128 characters.')
      await assertSearchBudget()
      const files = (await workspace.glob(pattern)).filter((entry) => entry.type === 'file')
      if (files.length > maxSearchFiles) throw new Error('Search matches more than 200 files; narrow the pattern.')
      const result = []
      for (const file of files) {
        if (file.size > maxFileBytes) continue
        result.push(...await workspace.fs.grep(query, file.path))
        if (result.length >= 100) break
      }
      signal?.throwIfAborted()
      return text(result.slice(0, 100))
    },
  }

  return [readTool, writeTool, editTool, listTool, findTool, grepTool]
}

export function createSessionSearchTool(
  registry: RegistrySearch,
): AgentHarnessTool<undefined> {
  const parameters = Type.Object({
    query: Type.String({ description: 'Lexical query, quoted phrase, or re: regular expression' }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  })
  return {
    name: 'session_search',
    label: 'Search sessions',
    description: 'Search prior Pi sessions and read-only imported archives for plain message text on all branches. Historical thoughts are excluded. Archive IDs cannot be resumed.',
    parameters,
    execute: async (_id, { query, limit }, _onUpdate, _toolContext, _invocation, context) => {
      const signal = context.abortSignal
      signal?.throwIfAborted()
      const results = await registry.searchSessions({ query, limit })
      signal?.throwIfAborted()
      return text(results.map(({ session, matches, archive }) => ({
        sessionId: session.id,
        ...(archive ? { archive } : {}),
        name: session.name,
        updatedAt: session.updatedAt,
        matches: matches.map(({ entryId, sourceNodeId, role, timestamp, text: matchText }) => ({
          entryId,
          ...(sourceNodeId ? { sourceNodeId } : {}),
          role,
          timestamp,
          text: matchText.slice(0, 2_000),
        })),
      })))
    },
  }
}
