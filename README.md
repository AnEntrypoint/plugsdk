# plugsdk

**Embed Claude Code's plugin system in your own application.**

[![npm](https://img.shields.io/npm/v/plugsdk)](https://www.npmjs.com/package/plugsdk)
[![license](https://img.shields.io/npm/l/plugsdk)](./LICENSE)

```
npm install plugsdk
```

## What it is

plugsdk is the **host-side** loader for Claude Code plugins. Drop it into any
Node application and you can:

- Load plugins authored against Claude Code's plugin format from disk.
- Read every documented component — manifest, hooks, skills, commands,
  agents, MCP server configs, LSP server configs, monitors, themes,
  output styles, settings, marketplace catalogs.
- Dispatch your application's events through the plugins' hooks the same
  way Claude Code does, with subprocess execution, JSON I/O, matcher
  filtering, and result merging following the documented precedence rules.

plugsdk does **not** author plugins. It does **not** ship UI. It loads
on-disk plugin directories and gives you their structure plus a hook
dispatcher.

Reference: <https://code.claude.com/docs/en/plugins-reference> and
<https://code.claude.com/docs/en/hooks>.

## Quick start

```js
import { loadClaudePlugin, createHookDispatcher } from 'plugsdk'

const plugin   = loadClaudePlugin('/path/to/some-plugin')
const dispatch = createHookDispatcher([plugin])

// Your app is about to run a tool. Ask plugins first:
const result = await dispatch('PreToolUse', {
    tool_name:  'Bash',
    tool_input: { command: 'rm -rf /' },
    cwd:        process.cwd(),
})

if (result.hookSpecificOutput?.permissionDecision === 'deny') {
    throw new Error(result.hookSpecificOutput.permissionDecisionReason)
}
```

## What `loadClaudePlugin(dir)` returns

```ts
{
  root,                 // absolute plugin dir
  manifest,             // .claude-plugin/plugin.json
  hooks,                // { PreToolUse: [{ matcher, hooks: [...] }], ... }
  skills,               // [{ name, dir, file, fields, body }]
  commands,             // flat skills/commands
  agents,               // [{ name, file, fields, body }] — validated
  mcpServers,           // .mcp.json mcpServers map
  lspServers,           // .lsp.json
  monitors,             // monitors/monitors.json array
  themes,               // [{ slug, name, base, overrides }]
  outputStyles,         // output-styles/*.md
  settings,             // settings.json
  userConfig,           // manifest.userConfig
  channels,             // manifest.channels
  dependencies,         // manifest.dependencies
  binDir,               // bin/ if present
}
```

The manifest's custom-path fields (`skills`, `commands`, `agents`,
`outputStyles`, `themes`, `monitors`, `hooks`, `mcpServers`, `lspServers`)
are honored — when a manifest specifies a custom path, the default
location is skipped, exactly as the Claude Code spec mandates.

Forbidden agent fields (`hooks`, `mcpServers`, `permissionMode`) and
illegal `isolation` values cause the loader to throw at parse time so
malformed plugins are rejected up front.

## Loading marketplaces

```js
import { loadClaudeMarketplace } from 'plugsdk'

const m = loadClaudeMarketplace('/path/to/some-marketplace')
// m.catalog: marketplace.json
// m.plugins: [{ entry, plugin: LoadedClaudePlugin | null }]
//            local-path sources auto-load; remote sources kept as metadata.
```

`metadata.pluginRoot` is honored when resolving local plugin paths.

## Dispatching hooks

```js
const dispatch = createHookDispatcher(plugins, { timeout: 60_000 })
const r = await dispatch('PreToolUse', payload)
```

For each loaded plugin whose `hooks[event]` entries match the payload's
target (tool name / source / agent type / etc.), every `command`-type
handler runs as a subprocess:

- The command string has `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${user_config.<key>}`, and `${ENV_VAR}` substituted.
- The full payload (with `hook_event_name` injected) is written to stdin
  as JSON.
- `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` are exported on the child's
  env.
- stdout JSON is parsed; stderr is captured for exit-code-2 blocks.

Returned shape:

```ts
{
  results: [{ plugin, exitCode, stdout, stderr, output, eventName, handler }, ...],
  unhandled: [...],          // non-command handlers (http/mcp_tool/prompt/agent)
  decision?: 'block', reason?: string,                    // top-level decision events
  hookSpecificOutput?: {                                  // permission events
    hookEventName,
    permissionDecision: 'allow' | 'deny' | 'ask' | 'defer',
    permissionDecisionReason,
    additionalContext,                                    // joined across plugins
    updatedInput,                                         // shallow-merged
  },
  continue?, stopReason?, suppressOutput?, systemMessage?,
}
```

Result merging follows the documented precedence:

- **PreToolUse / PermissionRequest**: `deny > defer > ask > allow`.
- **Stop / UserPromptSubmit / PostToolBatch / etc.**: first plugin emitting
  `decision: 'block'` (or exit code 2) wins.
- **`additionalContext`** entries are concatenated.
- **`continue: false` / `suppressOutput` / `systemMessage`** propagate.

Non-`command` handler types are returned in `unhandled` so your host can
route them itself (HTTP webhook, an in-process MCP server call, etc).

## Matcher rules

`claudeAdapter.matches(matcher, target)` implements Claude Code's
documented matcher semantics:

| matcher | meaning |
|---|---|
| omitted / `''` / `'*'` | match every target |
| `Bash` | exact match |
| `Bash\|Edit` | pipe-separated literal list |
| anything else | JavaScript regex |

## License

MIT © AnEntrypoint
