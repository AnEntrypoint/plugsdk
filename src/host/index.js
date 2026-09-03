import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { claudeAdapter } from '../adapters/claude.js'

const wasmInstances = new Map()

async function getWasmInstance(plugin, modulePath) {
    const key = plugin.manifest.name + ':' + modulePath
    if (wasmInstances.has(key)) return wasmInstances.get(key)
    const bytes = readFileSync(modulePath)
    const wasi = globalThis.WASI || (await import('node:wasi').then(m => m.WASI).catch(() => null))
    let imports = {}
    let instance
    if (wasi) {
        const w = new wasi({
            version: 'preview1',
            args: [plugin.manifest.name],
            env: {},
            preopens: { '/': plugin.root },
        })
        imports = (typeof w.getImportObject === 'function')
            ? w.getImportObject()
            : { wasi_snapshot_preview1: w.wasiImport }
        const mod = await WebAssembly.compile(bytes)
        instance = await WebAssembly.instantiate(mod, imports)
        try { w.initialize?.(instance) } catch { try { w.start?.(instance) } catch (e) { console.error(`[plugsdk] wasm WASI init failed for plugin '${plugin.manifest.name}' (${modulePath}): ${e.message}`) } }
    } else {
        const mod = await WebAssembly.compile(bytes)
        instance = await WebAssembly.instantiate(mod, imports)
    }
    wasmInstances.set(key, instance)
    return instance
}

function wasmWriteString(instance, str) {
    const enc = new TextEncoder().encode(str)
    const alloc = instance.exports.plugkit_alloc || instance.exports.malloc
    const mem = instance.exports.memory
    if (!alloc || !mem) throw new Error('wasm module missing plugkit_alloc/memory exports')
    const ptr = alloc(enc.length)
    new Uint8Array(mem.buffer, ptr, enc.length).set(enc)
    return { ptr, len: enc.length }
}

function wasmReadString(instance, ptr, len) {
    const mem = instance.exports.memory
    const bytes = new Uint8Array(mem.buffer, ptr, len)
    return new TextDecoder().decode(bytes)
}

function wasmFreeString(instance, ptr, len) {
    const free = instance.exports.plugkit_free || instance.exports.free
    if (free) free(ptr, len)
}

/**
 * createHost({ on }) — universal Plugin host.
 *
 * The host owns lifecycle (spawn/kill of subprocess hooks, MCP servers,
 * LSP servers, monitors) and string substitution. It calls the consumer's
 * `on*` callbacks once per component so the consumer never branches by
 * format.
 *
 *   const host = createHost({
 *     on: {
 *       onSkill(plugin, skill) { ... },
 *       onAgent, onCommand, onTheme, onOutputStyle,
 *       onChannel, onSetting, onBin,
 *       onMcpTool(plugin, server, tool, call) { ... },
 *       onMonitorLine(plugin, monitor, line) { ... },
 *     },
 *   })
 *   host.use(plugin)
 *   await host.dispatch('PreToolUse', payload)
 *   await host.shutdown()
 *
 * The consumer wires plugins to its native surfaces inside the callbacks
 * and never sees subprocess plumbing.
 */
export function createHost({ on = {}, dataRoot, env = process.env, timeout = 60000 } = {}) {
    const plugins = []
    const procs = []
    const monitorOnDemand = new Map()
    const mcpToolHandles = []

    function pluginDataDir(plugin) {
        const root = dataRoot || join(homedir(), '.plugsdk-data')
        const id = plugin.manifest.name.replace(/[^a-zA-Z0-9_-]/g, '-')
        const dir = join(root, id)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        return dir
    }

    function userConfigBag(plugin) {
        const bag = {}
        for (const k of Object.keys(plugin.userConfig || {})) {
            const envKey = 'CLAUDE_PLUGIN_OPTION_' + k
            if (env[envKey] !== undefined) bag[k] = env[envKey]
            else if (plugin.userConfig[k]?.default !== undefined) bag[k] = plugin.userConfig[k].default
        }
        return Object.assign(bag, plugin._userConfig || {})
    }

    function subst(str, plugin) {
        if (typeof str !== 'string') return str
        const data = pluginDataDir(plugin)
        const uc = userConfigBag(plugin)
        return str.replace(/\$\{([^}]+)\}/g, (_, key) => {
            if (key === 'CLAUDE_PLUGIN_ROOT') return plugin.root
            if (key === 'CLAUDE_PLUGIN_DATA') return data
            if (key.startsWith('user_config.')) return uc[key.slice('user_config.'.length)] ?? ''
            return env[key] ?? ''
        })
    }

    function childEnv(plugin, extra = {}) {
        const data = pluginDataDir(plugin)
        const uc = userConfigBag(plugin)
        const envKv = {}
        for (const [k, v] of Object.entries(uc)) envKv['CLAUDE_PLUGIN_OPTION_' + k] = String(v)
        return { ...env, CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PLUGIN_DATA: data, ...envKv, ...extra }
    }

    function track(child) { procs.push(child); return child }

    function spawnMonitor(plugin, monitor) {
        const child = track(spawn(subst(monitor.command, plugin), { shell: true, env: childEnv(plugin) }))
        let buf = ''
        child.stdout?.on('data', d => {
            buf += d.toString()
            let i
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1)
                if (line.trim()) on.onMonitorLine?.(plugin, monitor, line)
            }
        })
    }

    function startMonitorsAtBoot(plugin) {
        for (const m of plugin.monitors || []) {
            if (!m.when || m.when === 'always') spawnMonitor(plugin, m)
            else if (m.when.startsWith('on-skill-invoke:')) {
                const skill = m.when.slice('on-skill-invoke:'.length)
                monitorOnDemand.set(plugin.manifest.name + ':' + skill, () => spawnMonitor(plugin, m))
            }
        }
    }

    async function startMcp(plugin) {
        for (const [serverName, cfg] of Object.entries(plugin.mcpServers || {})) {
            const args = (cfg.args || []).map(a => subst(a, plugin))
            const cwd = cfg.cwd ? subst(cfg.cwd, plugin) : plugin.root
            let child
            try {
                child = track(spawn(subst(cfg.command, plugin), args, {
                    env: childEnv(plugin, cfg.env || {}), cwd, stdio: ['pipe', 'pipe', 'pipe'],
                }))
            } catch (e) { console.error(`[plugsdk] failed to spawn MCP server '${serverName}' for plugin '${plugin.manifest.name}': ${e.message}`); continue }
            let exited = false
            child.on('error', () => { exited = true })
            child.on('exit',  () => { exited = true })
            const handle = mcpHandle(plugin, serverName, child)
            mcpToolHandles.push(handle)
            const tools = await Promise.race([
                handle.ready,
                new Promise(r => setTimeout(() => r([]), 2000)),
            ]).catch(() => [])
            if (exited) continue
            for (const tool of tools) on.onMcpTool?.(plugin, serverName, tool, (a) => handle.call(tool.name, a))
        }
    }

    function startLsp(plugin) {
        for (const [lang, cfg] of Object.entries(plugin.lspServers || {})) {
            const args = (cfg.args || []).map(a => subst(a, plugin))
            try {
                const child = track(spawn(subst(cfg.command, plugin), args, {
                    env: childEnv(plugin, cfg.env || {}), stdio: ['pipe', 'pipe', 'pipe'],
                }))
                child.on('error', () => {})
                on.onLsp?.(plugin, lang, cfg)
            } catch (e) { console.error(`[plugsdk] failed to spawn LSP server for '${lang}' in plugin '${plugin.manifest.name}': ${e.message} (loader still surfaces lspServers)`) }
        }
    }

    function emitComponents(plugin) {
        for (const s of plugin.skills || [])       on.onSkill?.(plugin, s)
        for (const a of plugin.agents || [])       on.onAgent?.(plugin, a)
        for (const c of plugin.commands || [])     on.onCommand?.(plugin, c)
        for (const t of plugin.themes || [])       on.onTheme?.(plugin, t)
        for (const o of plugin.outputStyles || []) on.onOutputStyle?.(plugin, o)
        for (const ch of plugin.channels || [])    on.onChannel?.(plugin, ch)
        if (plugin.bin) on.onBin?.(plugin, plugin.bin)
        if (plugin.settings && Object.keys(plugin.settings).length) on.onSetting?.(plugin, plugin.settings)
    }

    async function use(plugin) {
        plugins.push(plugin)
        emitComponents(plugin)
        startMonitorsAtBoot(plugin)
        startLsp(plugin)
        await startMcp(plugin)
    }

    function notifySkillInvoked(pluginName, skillName) {
        const key = pluginName + ':' + skillName
        const f = monitorOnDemand.get(key)
        if (f) { monitorOnDemand.delete(key); f() }
    }

    async function dispatch(eventName, payload = {}) {
        const tasks = []
        const unhandled = []
        for (const plugin of plugins) {
            const entries = plugin.hooks?.[eventName]
            if (!Array.isArray(entries)) continue
            const target = matcherTarget(eventName, payload)
            for (const group of entries) {
                if (group.matcher !== undefined && !claudeAdapter.matches(group.matcher, target)) continue
                for (const handler of group.hooks || []) {
                    if (handler.type === 'command') tasks.push(runCommand(plugin, handler, eventName, payload))
                    else if (handler.type === 'http') tasks.push(runHttp(plugin, handler, eventName, payload))
                    else if (handler.type === 'mcp_tool') tasks.push(runMcpTool(plugin, handler, eventName, payload))
                    else if (handler.type === 'wasm') tasks.push(runWasm(plugin, handler, eventName, payload))
                    else unhandled.push({ plugin: plugin.manifest.name, handler })
                }
            }
        }
        const results = await Promise.all(tasks)
        return mergeResults(eventName, results, unhandled)
    }

    function runCommand(plugin, handler, eventName, payload) {
        return new Promise((res) => {
            const ms = handler.timeout ?? timeout
            const cmd = subst(handler.command, plugin)
            const shell = handler.shell === 'powershell' ? 'powershell' : true
            const child = spawn(cmd, { shell, env: childEnv(plugin, { CLAUDE_PROJECT_DIR: payload.cwd || env.CLAUDE_PROJECT_DIR || process.cwd() }), stdio: ['pipe', 'pipe', 'pipe'] })
            let out = '', err = ''
            const t = setTimeout(() => { try { child.kill() } catch {} }, ms)
            child.stdout.on('data', d => out += d.toString())
            child.stderr.on('data', d => err += d.toString())
            child.on('close', code => {
                clearTimeout(t)
                let parsed = null
                try { parsed = out.trim() ? JSON.parse(out.trim()) : null } catch { parsed = { raw: out.trim() } }
                res({ plugin: plugin.manifest.name, exitCode: code, stdout: out, stderr: err, output: parsed, eventName, handler })
            })
            child.on('error', e => { clearTimeout(t); res({ plugin: plugin.manifest.name, error: e.message, exitCode: -1 }) })
            child.stdin.end(JSON.stringify({ hook_event_name: eventName, ...payload }))
        })
    }

    async function runHttp(plugin, handler, eventName, payload) {
        const url = subst(handler.url, plugin)
        const headers = Object.fromEntries(Object.entries(handler.headers || {}).map(([k, v]) => [k, subst(v, plugin)]))
        try {
            const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ hook_event_name: eventName, ...payload }) })
            const text = await r.text()
            let parsed = null
            try { parsed = text.trim() ? JSON.parse(text) : null } catch { parsed = { raw: text } }
            return { plugin: plugin.manifest.name, exitCode: r.ok ? 0 : 1, output: parsed, eventName, handler }
        } catch (e) { return { plugin: plugin.manifest.name, exitCode: -1, error: e.message } }
    }

    async function runWasm(plugin, handler, eventName, payload) {
        try {
            const modulePath = subst(handler.module, plugin)
            const exportName = handler.export || `hook_${eventName.replace(/[A-Z]/g, (m, i) => (i ? '_' : '') + m.toLowerCase())}`
            const instance = await getWasmInstance(plugin, modulePath)
            const fn = instance.exports[exportName]
            if (typeof fn !== 'function') {
                return { plugin: plugin.manifest.name, exitCode: -1, error: `wasm export not found: ${exportName}` }
            }
            const body = JSON.stringify({ hook_event_name: eventName, ...payload })
            const { ptr, len } = wasmWriteString(instance, body)
            let resultPtr, resultLen
            try {
                const r = fn(ptr, len)
                if (typeof r === 'bigint' || typeof r === 'number') {
                    const v = BigInt(r)
                    resultPtr = Number(v & 0xffffffffn)
                    resultLen = Number((v >> 32n) & 0xffffffffn)
                } else if (Array.isArray(r) && r.length === 2) {
                    [resultPtr, resultLen] = r
                }
            } finally {
                wasmFreeString(instance, ptr, len)
            }
            let parsed = null
            if (resultPtr && resultLen) {
                const out = wasmReadString(instance, resultPtr, resultLen)
                wasmFreeString(instance, resultPtr, resultLen)
                try { parsed = out.trim() ? JSON.parse(out) : null } catch { parsed = { raw: out } }
            }
            return { plugin: plugin.manifest.name, exitCode: 0, output: parsed, eventName, handler }
        } catch (e) {
            return { plugin: plugin.manifest.name, exitCode: -1, error: e.message, eventName, handler }
        }
    }

    async function runMcpTool(plugin, handler, eventName, payload) {
        const handle = mcpToolHandles.find(h => h.plugin === plugin.manifest.name && h.serverName === handler.server)
        if (!handle) return { plugin: plugin.manifest.name, exitCode: -1, error: 'mcp server not running: ' + handler.server }
        try {
            const subbed = JSON.parse(subst(JSON.stringify(handler.input || {}), plugin))
            const r = await handle.call(handler.tool, subbed)
            return { plugin: plugin.manifest.name, exitCode: 0, output: r, eventName, handler }
        } catch (e) { return { plugin: plugin.manifest.name, exitCode: -1, error: e.message } }
    }

    async function shutdown() {
        for (const p of procs) { try { p.kill() } catch {} }
        procs.length = 0
        for (const h of mcpToolHandles) { try { h.shutdown() } catch {} }
        mcpToolHandles.length = 0
    }

    return {
        plugins: () => plugins.slice(),
        use, dispatch, shutdown, notifySkillInvoked, subst, childEnv,
    }
}

function matcherTarget(event, payload) {
    if (['PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','PermissionDenied','SubagentStart','SubagentStop'].includes(event))
        return payload.tool_name || payload.agent_type || ''
    if (event === 'SessionStart' || event === 'SessionEnd' || event === 'PreCompact' || event === 'PostCompact') return payload.source || ''
    if (event === 'Setup') return payload.trigger || ''
    if (event === 'Notification') return payload.notification_type || ''
    return ''
}

const PERM_ORDER = ['deny', 'defer', 'ask', 'allow']

function mergeResults(eventName, results, unhandled) {
    const merged = { results, unhandled }
    let bestPerm = null, blockDec = null
    const ctx = [], updates = []
    for (const r of results) {
        if (r.exitCode === 2) blockDec = blockDec || { reason: r.stderr?.trim() || 'blocked' }
        const o = r.output
        if (!o || typeof o !== 'object') continue
        if (o.continue === false) merged.continue = false
        if (o.stopReason) merged.stopReason = o.stopReason
        if (o.suppressOutput) merged.suppressOutput = true
        if (o.systemMessage) merged.systemMessage = (merged.systemMessage ? merged.systemMessage + '\n' : '') + o.systemMessage
        const h = o.hookSpecificOutput
        if (h) {
            if (h.permissionDecision) {
                const c = PERM_ORDER.indexOf(h.permissionDecision)
                const b = bestPerm ? PERM_ORDER.indexOf(bestPerm.permissionDecision) : 99
                if (c >= 0 && c < b) bestPerm = h
            }
            if (h.additionalContext) ctx.push(h.additionalContext)
            if (h.updatedInput) updates.push(h.updatedInput)
        }
        if (o.decision === 'block') blockDec = blockDec || { reason: o.reason || 'blocked' }
    }
    if (claudeAdapter.isPermissionDecisionEvent(eventName) && bestPerm) merged.hookSpecificOutput = { hookEventName: eventName, ...bestPerm }
    else if (ctx.length || updates.length) {
        merged.hookSpecificOutput = { hookEventName: eventName }
        if (ctx.length) merged.hookSpecificOutput.additionalContext = ctx.join('\n')
        if (updates.length) merged.hookSpecificOutput.updatedInput = Object.assign({}, ...updates)
    }
    if (blockDec && claudeAdapter.isTopLevelDecisionEvent(eventName)) { merged.decision = 'block'; merged.reason = blockDec.reason }
    if (blockDec && claudeAdapter.isPermissionDecisionEvent(eventName) && !bestPerm)
        merged.hookSpecificOutput = { hookEventName: eventName, permissionDecision: 'deny', permissionDecisionReason: blockDec.reason }
    return merged
}

function mcpHandle(plugin, serverName, child) {
    let nextId = 1
    const pending = new Map()
    let buf = ''
    child.stdout.on('data', d => {
        buf += d.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1)
            if (!line.trim()) continue
            try {
                const msg = JSON.parse(line)
                if (msg.id != null && pending.has(msg.id)) {
                    const { resolve, reject } = pending.get(msg.id)
                    pending.delete(msg.id)
                    msg.error ? reject(new Error(msg.error.message || 'mcp error')) : resolve(msg.result)
                }
            } catch { /* ignore */ }
        }
    })
    function rpc(method, params) {
        return new Promise((resolve, reject) => {
            const id = nextId++
            pending.set(id, { resolve, reject })
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        })
    }
    const ready = (async () => {
        await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plugsdk', version: '1' } }).catch(() => null)
        const r = await rpc('tools/list', {}).catch(() => ({ tools: [] }))
        return r?.tools || []
    })()
    const handle = {
        plugin: plugin.manifest.name,
        serverName,
        tools: [],
        ready: ready.then(t => { handle.tools = t; return t }),
        call: (name, args) => rpc('tools/call', { name, arguments: args || {} }),
        shutdown: () => { try { child.kill() } catch {} },
    }
    return handle
}
