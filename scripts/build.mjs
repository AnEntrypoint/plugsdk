import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'fs'

mkdirSync('dist/adapters', { recursive: true })
mkdirSync('dist/loader',   { recursive: true })
mkdirSync('dist/host',     { recursive: true })

const shared = { bundle: true, format: 'esm', platform: 'node', target: 'node18', sourcemap: true }
const browserShared = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true }

await Promise.all([
  build({ ...shared, entryPoints: ['src/index.js'],            outfile: 'dist/index.js' }),
  build({ ...shared, entryPoints: ['src/adapters/claude.js'],  outfile: 'dist/adapters/claude.js' }),
  build({ ...shared, entryPoints: ['src/loader/index.js'],     outfile: 'dist/loader/index.js' }),
  build({ ...shared, entryPoints: ['src/host/index.js'],       outfile: 'dist/host/index.js' }),
  build({ ...browserShared, entryPoints: ['src/browser.js'],   outfile: 'dist/browser.js' }),
  build({ ...browserShared, entryPoints: ['src/idb.js'],       outfile: 'dist/idb.js' }),
])

const dts = `export type HookEventName = string

export const HookType: Record<string, string>

export interface ClaudeAdapter {
  name: 'claude'
  listNativeEvents(): string[]
  getCanonical(native: string): string | null
  getNative(canonical: string): string | null
  eventSupportsMatcher(native: string): boolean
  isPermissionDecisionEvent(native: string): boolean
  isTopLevelDecisionEvent(native: string): boolean
  matches(matcher: string | undefined, target: string): boolean
}
export const claudeAdapter: ClaudeAdapter

export interface FrontmatterDoc { name: string; file: string; fields: Record<string, unknown>; body: string; description: string }
export interface SkillDoc extends FrontmatterDoc { dir: string }

export interface HookHandler { type: 'command' | 'http' | 'mcp_tool' | 'prompt' | 'agent'; [k: string]: unknown }
export interface HookGroup { matcher?: string; hooks: HookHandler[] }
export type HookConfig = Record<string, HookGroup[]>

export interface Plugin {
  root: string
  format: string
  manifest: Record<string, unknown> & { name: string }
  hooks: HookConfig
  skills: SkillDoc[]
  commands: FrontmatterDoc[]
  agents: FrontmatterDoc[]
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }>
  lspServers: Record<string, { command: string; args?: string[]; extensionToLanguage: Record<string, string>; [k: string]: unknown }>
  monitors: Array<{ name: string; command: string; description: string; when?: string }>
  themes: Array<{ slug: string; file: string; name: string; base: 'dark' | 'light'; overrides?: Record<string, string> }>
  outputStyles: FrontmatterDoc[]
  settings: Record<string, unknown>
  userConfig: Record<string, unknown>
  channels: unknown[]
  dependencies: unknown[]
  bin: string | null
}

export function loadClaudePlugin(dir: string): Plugin
export function loadClaudeMarketplace(dir: string): { root: string; catalog: Record<string, unknown>; plugins: Array<{ entry: Record<string, unknown>; plugin: Plugin | null }> }
export function parseFrontmatter(text: string): { fields: Record<string, unknown>; body: string }

export interface HostCallbacks {
  onSkill?(plugin: Plugin, skill: SkillDoc): void
  onAgent?(plugin: Plugin, agent: FrontmatterDoc): void
  onCommand?(plugin: Plugin, command: FrontmatterDoc): void
  onTheme?(plugin: Plugin, theme: { slug: string; name: string; base: 'dark' | 'light'; overrides?: Record<string, string> }): void
  onOutputStyle?(plugin: Plugin, style: FrontmatterDoc): void
  onChannel?(plugin: Plugin, channel: unknown): void
  onSetting?(plugin: Plugin, settings: Record<string, unknown>): void
  onBin?(plugin: Plugin, dir: string): void
  onLsp?(plugin: Plugin, lang: string, cfg: unknown): void
  onMcpTool?(plugin: Plugin, server: string, tool: { name: string; description?: string }, call: (args: unknown) => Promise<unknown>): void
  onMonitorLine?(plugin: Plugin, monitor: { name: string }, line: string): void
}

export interface HostDispatchResult {
  results: Array<{ plugin: string; exitCode: number; output: unknown }>
  unhandled: Array<{ plugin: string; handler: HookHandler }>
  decision?: 'block'
  reason?: string
  hookSpecificOutput?: { hookEventName: string; permissionDecision?: string; additionalContext?: string; updatedInput?: Record<string, unknown> }
  continue?: false
  stopReason?: string
  suppressOutput?: true
  systemMessage?: string
}

export interface Host {
  plugins(): Plugin[]
  use(plugin: Plugin): Promise<void>
  dispatch(eventName: string, payload?: Record<string, unknown>): Promise<HostDispatchResult>
  notifySkillInvoked(pluginName: string, skillName: string): void
  shutdown(): Promise<void>
  subst(str: string, plugin: Plugin): string
  childEnv(plugin: Plugin, extra?: Record<string, string>): Record<string, string>
}

export function createHost(opts?: { on?: HostCallbacks; dataRoot?: string; env?: Record<string, string>; timeout?: number }): Host
`
writeFileSync('dist/index.d.ts', dts)

const browserDts = `export interface PlugkitHookResult { ok: boolean; output?: string; reason?: string }
export type PlugkitHook = (payload?: string | Record<string, unknown>) => PlugkitHookResult

export interface PlugkitInstance {
  instance: WebAssembly.Instance
  preToolUse: PlugkitHook
  postToolUse: PlugkitHook
  sessionStart: PlugkitHook
  sessionEnd: PlugkitHook
  userPromptSubmit: PlugkitHook
  promptSubmit: PlugkitHook
  preCompact: PlugkitHook
  postCompact: PlugkitHook
  stop: PlugkitHook
  stopGit: PlugkitHook
}

export interface LoadPlugkitOptions {
  url: string
  storage?: 'opfs' | 'idb'
}

export function loadPlugkit(opts: LoadPlugkitOptions): Promise<PlugkitInstance>
export function wrapHookCalls(instance: WebAssembly.Instance): PlugkitInstance
`
writeFileSync('dist/browser.d.ts', browserDts)

console.log('build complete')
