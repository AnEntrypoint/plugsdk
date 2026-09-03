# plugsdk — Agent Guide

Notes for AI coding assistants. README.md has the public surface; this file holds non-obvious caveats.

## Universal Plugin shape

`createHost({on, dataRoot?, env?, timeout?})` from `src/host/index.js` is the universal entrypoint. The consumer provides `on*` callbacks; the host owns subprocess lifecycle, string substitution, and component iteration. Callback set (each fires once per matching component):

- `onSkill(plugin, skill)`
- `onAgent(plugin, agent)`
- `onCommand(plugin, command)`
- `onTheme(plugin, theme)`
- `onOutputStyle(plugin, style)`
- `onChannel(plugin, channel)`
- `onSetting(plugin, key, value)`
- `onBin(plugin, binDir)`
- `onMcpTool(plugin, server, tool, call)`
- `onMonitorLine(plugin, monitor, line)`

Methods returned: `host.use(plugin)`, `host.dispatch(eventName, payload)`, `host.shutdown()`.

## Auto-publish

plugsdk auto-publishes to npm on push to `main`. Current version pinned in consumers via `^x.y.z`. Do NOT hand-bump — CI does that. Verify with `npm view plugsdk version`.

## peer-dep zod range

`peerDependencies.zod` is `^3.23.0 || ^4.0.0` (relaxed in v1.0.7 from `^3.23.0` only) so consumers on zod@4 (e.g., freddie) don't ERESOLVE. Keep the dual-range when bumping.

## CJS/ESM consumer pattern

Pure ESM. Consumers that are ESM import directly. CJS consumers (or ESM consumers that need to bridge CJS deps) use `createRequire(import.meta.url)`. This is the same pattern freddie uses for `acptoapi`.

## acptoapi is THE LLM SDK (downstream advisory)

When wiring plugsdk plugins that need LLM resolution, sampler backoff, fallback chains, or matrix-aware model scoring, **delegate to `acptoapi` (npm) directly — do not reimplement.** Public surface lives in `node_modules/acptoapi/AGENTS.md` "Public API — unified chain SDK" section. Top-level exports: `chat`, `chain`, `fallback`, `buildAutoChain`, `parseCommaList`, `resolveQueue`, `listAllModelsAndQueues`, `loadMatrix`, `matrixScore`, `peekStatus`, `getStatus`, `markFailed`, `markOk`, `PROVIDER_KEYS`, `PROVIDER_DEFAULTS`. Pin via `sync-upstream.mjs` (^<latest> from registry). Current floor: 1.0.62 (buildParams strips chain-only opts before upstream HTTP body to fix mistral/groq 422 leak).

## Hook dispatch (PreToolUse, etc.)

`createHookDispatcher(plugins, {timeout})` runs every matching `command`-type hook as a subprocess with `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${user_config.<k>}`, `${ENV_VAR}` substituted. Payload goes to stdin as JSON; stdout JSON parsed; exit-code-2 captures stderr. See README "Dispatching hooks" for the returned shape.
