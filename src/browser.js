import { WASI, OpenFile, File, ConsoleStdout } from '@bjorn3/browser_wasi_shim'
import * as idb from './idb.js'

function makeMem(instance) {
    return instance.exports.memory
}

function readStr(instance, ptr, len) {
    const mem = makeMem(instance)
    const bytes = new Uint8Array(mem.buffer, ptr, len)
    return new TextDecoder().decode(bytes)
}

function readBytes(instance, ptr, len) {
    const mem = makeMem(instance)
    return new Uint8Array(mem.buffer.slice(ptr, ptr + len))
}

function allocWrite(instance, bytes) {
    const alloc = instance.exports.plugkit_alloc
    if (!alloc) throw new Error('plugkit_alloc export missing')
    const ptr = alloc(bytes.byteLength)
    const mem = makeMem(instance)
    new Uint8Array(mem.buffer, ptr, bytes.byteLength).set(bytes)
    return ptr
}

function pack(ptr, len) {
    return BigInt(ptr & 0xffffffff) | (BigInt(len & 0xffffffff) << 32n)
}

function packResultBytes(instance, bytes) {
    if (!bytes || bytes.byteLength === 0) return pack(0, 0)
    const ptr = allocWrite(instance, bytes)
    return pack(ptr, bytes.byteLength)
}

function packResultStr(instance, str) {
    return packResultBytes(instance, new TextEncoder().encode(str))
}

function packResultJson(instance, obj) {
    return packResultStr(instance, JSON.stringify(obj))
}

const browserSessions = new Map()
let nextSessionId = 1

function makeHostImports(getInstance, storage) {
    const enc = new TextEncoder()
    return {
        host_fs_read: (pathPtr, pathLen) => {
            const inst = getInstance()
            const path = readStr(inst, pathPtr, pathLen)
            try {
                const data = syncify(idb.fsRead(path))
                return packResultBytes(inst, data)
            } catch {
                return pack(0, 0)
            }
        },
        host_fs_write: (pathPtr, pathLen, dataPtr, dataLen) => {
            const inst = getInstance()
            const path = readStr(inst, pathPtr, pathLen)
            const data = readBytes(inst, dataPtr, dataLen)
            try { syncify(idb.fsWrite(path, data)); return 1 } catch { return 0 }
        },
        host_fs_readdir: (pathPtr, pathLen) => {
            const inst = getInstance()
            const path = readStr(inst, pathPtr, pathLen)
            try { return packResultJson(inst, syncify(idb.fsReaddir(path))) } catch { return pack(0, 0) }
        },
        host_fs_stat: (pathPtr, pathLen) => {
            const inst = getInstance()
            const path = readStr(inst, pathPtr, pathLen)
            try { return packResultJson(inst, syncify(idb.fsStat(path))) } catch { return pack(0, 0) }
        },
        host_fetch: (urlPtr, urlLen, optsPtr, optsLen) => {
            const inst = getInstance()
            const url = readStr(inst, urlPtr, urlLen)
            const opts = optsLen > 0 ? JSON.parse(readStr(inst, optsPtr, optsLen)) : {}
            try {
                const result = syncify(fetch(url, opts).then(async r => ({
                    status: r.status,
                    headers: Object.fromEntries(r.headers.entries()),
                    body: await r.text(),
                })))
                return packResultJson(inst, result)
            } catch (e) {
                return packResultJson(inst, { error: String(e) })
            }
        },
        host_kv_get: (nsPtr, nsLen, keyPtr, keyLen) => {
            const inst = getInstance()
            const ns = readStr(inst, nsPtr, nsLen)
            const key = readStr(inst, keyPtr, keyLen)
            try {
                const val = syncify(idb.kvGet(ns, key))
                if (val == null) return pack(0, 0)
                if (val instanceof Uint8Array) return packResultBytes(inst, val)
                return packResultStr(inst, typeof val === 'string' ? val : JSON.stringify(val))
            } catch { return pack(0, 0) }
        },
        host_kv_put: (nsPtr, nsLen, keyPtr, keyLen, valPtr, valLen) => {
            const inst = getInstance()
            const ns = readStr(inst, nsPtr, nsLen)
            const key = readStr(inst, keyPtr, keyLen)
            const val = readBytes(inst, valPtr, valLen)
            try { syncify(idb.kvPut(ns, key, val)); return 1 } catch { return 0 }
        },
        host_kv_query: (nsPtr, nsLen, qPtr, qLen) => {
            const inst = getInstance()
            const ns = readStr(inst, nsPtr, nsLen)
            const q = readStr(inst, qPtr, qLen)
            try {
                const rows = syncify(idb.kvQuery(ns, q))
                return packResultJson(inst, rows.map(r => ({ key: r.key })))
            } catch { return pack(0, 0) }
        },
        host_vec_search: (qPtr, qLen, k) => {
            const inst = getInstance()
            const qStr = readStr(inst, qPtr, qLen)
            let parsed
            try { parsed = JSON.parse(qStr) } catch { parsed = null }
            try {
                const embedding = parsed && Array.isArray(parsed.embedding) ? Float32Array.from(parsed.embedding) : null
                if (!embedding) return packResultJson(inst, [])
                const hits = syncify(idb.vecSearch(embedding, k | 0))
                return packResultJson(inst, hits)
            } catch { return pack(0, 0) }
        },
        host_browser_spawn: (urlPtr, urlLen) => {
            const inst = getInstance()
            const url = readStr(inst, urlPtr, urlLen)
            const id = nextSessionId++
            const iframe = (typeof document !== 'undefined') ? document.createElement('iframe') : null
            if (iframe) { iframe.src = url; iframe.style.display = 'none'; document.body.appendChild(iframe) }
            browserSessions.set(id, { url, iframe })
            return id
        },
        host_browser_eval: (sessionId, codePtr, codeLen) => {
            const inst = getInstance()
            const sess = browserSessions.get(sessionId)
            if (!sess || !sess.iframe) return pack(0, 0)
            const code = readStr(inst, codePtr, codeLen)
            try {
                const result = sess.iframe.contentWindow.eval(code)
                return packResultStr(inst, String(result))
            } catch (e) {
                return packResultStr(inst, 'error: ' + String(e))
            }
        },
        host_browser_close: (sessionId) => {
            const sess = browserSessions.get(sessionId)
            if (!sess) return 0
            if (sess.iframe && sess.iframe.parentNode) sess.iframe.parentNode.removeChild(sess.iframe)
            browserSessions.delete(sessionId)
            return 1
        },
        host_exec_js: (codePtr, codeLen, optsPtr, optsLen) => {
            const inst = getInstance()
            const code = readStr(inst, codePtr, codeLen)
            try {
                const fn = new Function(code)
                const result = fn()
                return packResultStr(inst, String(result))
            } catch (e) {
                return packResultStr(inst, 'error: ' + String(e))
            }
        },
        host_log: (level, msgPtr, msgLen) => {
            const inst = getInstance()
            const msg = readStr(inst, msgPtr, msgLen)
            const methods = ['error', 'warn', 'info', 'log', 'debug']
            const fn = methods[level | 0] || 'log'
            try { (console[fn] || console.log).call(console, '[plugkit]', msg) } catch {}
            return 1
        },
        host_now_ms: () => BigInt(Date.now()),
        host_env_get: (keyPtr, keyLen) => {
            const inst = getInstance()
            const key = readStr(inst, keyPtr, keyLen)
            let val = null
            try {
                if (typeof localStorage !== 'undefined') val = localStorage.getItem('env:' + key)
            } catch {}
            if (val == null) {
                try {
                    const params = new URLSearchParams(globalThis.location?.search || '')
                    val = params.get('env_' + key)
                } catch {}
            }
            if (val == null) return pack(0, 0)
            return packResultStr(inst, val)
        },
    }
}

function syncify(promise) {
    throw new Error('plugkit host imports are async-only — wasm callers must use the async dispatch path. ' +
        'Pending Asyncify wiring; call via instance.exports.dispatch_verb_async wrapper instead.')
}

export async function loadPlugkit(opts) {
    if (!opts || !opts.url) throw new Error('loadPlugkit requires { url, storage }')
    const storage = opts.storage || 'idb'
    const args = []
    const env = []
    const fds = [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered((msg) => console.log('[plugkit:stdout]', msg)),
        ConsoleStdout.lineBuffered((msg) => console.error('[plugkit:stderr]', msg)),
    ]
    const wasi = new WASI(args, env, fds)
    let instance
    const getInstance = () => instance
    const hostImports = makeHostImports(getInstance, storage)
    const importObject = {
        wasi_snapshot_preview1: wasi.wasiImport,
        env: hostImports,
    }
    const source = await fetch(opts.url)
    const { instance: inst } = await WebAssembly.instantiateStreaming(source, importObject)
    instance = inst
    try { wasi.start(instance) } catch (e) {
        try { wasi.initialize(instance) } catch {}
    }
    return wrapHookCalls(instance)
}

function callPackedHook(instance, hookName, payloadStr) {
    const exp = instance.exports[hookName]
    if (typeof exp !== 'function') return { ok: false, reason: 'export missing: ' + hookName }
    const bytes = new TextEncoder().encode(payloadStr || '')
    const ptr = bytes.byteLength > 0 ? allocWrite(instance, bytes) : 0
    const packed = exp(ptr, bytes.byteLength)
    const big = BigInt.asUintN(64, BigInt(packed))
    const outPtr = Number(big & 0xffffffffn)
    const outLen = Number((big >> 32n) & 0xffffffffn)
    if (outLen === 0) return { ok: true, output: '' }
    const mem = makeMem(instance)
    const out = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, outLen))
    try { instance.exports.plugkit_free?.(outPtr, outLen) } catch {}
    return { ok: true, output: out }
}

export function wrapHookCalls(instance) {
    const wrap = (hookName) => (payload) =>
        callPackedHook(instance, hookName, typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}))
    return {
        instance,
        preToolUse: wrap('hook_pre_tool_use'),
        postToolUse: wrap('hook_post_tool_use'),
        sessionStart: wrap('hook_session_start'),
        sessionEnd: wrap('hook_session_end'),
        userPromptSubmit: wrap('hook_user_prompt_submit'),
        promptSubmit: wrap('hook_prompt_submit'),
        preCompact: wrap('hook_pre_compact'),
        postCompact: wrap('hook_post_compact'),
        stop: wrap('hook_stop'),
        stopGit: wrap('hook_stop_git'),
    }
}

export { idb }
