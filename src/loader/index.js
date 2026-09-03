import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, basename, extname } from 'node:path'

/**
 * loadClaudePlugin(dir) — return the universal Plugin shape from a Claude
 * Code plugin directory. The Plugin shape is the same one every other
 * format loader returns; hosts treat them identically.
 *
 *   Plugin = {
 *     root, format, manifest,
 *     hooks, skills, commands, agents,
 *     mcpServers, lspServers, monitors,
 *     themes, outputStyles, settings,
 *     userConfig, channels, dependencies, bin,
 *   }
 */
export function loadClaudePlugin(dir) {
    const root = resolve(dir)
    if (!existsSync(root)) throw new Error(`loadClaudePlugin: ${root} does not exist`)
    const manifest = readJsonIfExists(join(root, '.claude-plugin', 'plugin.json'))
        || readJsonIfExists(join(root, 'plugin.json'))
        || {}
    if (!manifest.name) manifest.name = basename(root)
    const pickPath = (field, def) => {
        const v = manifest[field]
        if (typeof v === 'string') return [join(root, v)]
        if (Array.isArray(v)) return v.map(p => typeof p === 'string' ? join(root, p) : null).filter(Boolean)
        if (v && typeof v === 'object') return null
        return def ? [join(root, def)] : []
    }
    return {
        root, format: 'claude-code', manifest,
        hooks:        loadHooks(root, manifest),
        skills:       loadSkills(pickPath('skills', 'skills')),
        commands:     loadCommands(pickPath('commands', 'commands')),
        agents:       loadAgents(pickPath('agents', 'agents')),
        mcpServers:   loadInlineOrFile(root, manifest, 'mcpServers', '.mcp.json', j => j?.mcpServers ?? j ?? {}),
        lspServers:   loadInlineOrFile(root, manifest, 'lspServers', '.lsp.json', j => j ?? {}),
        monitors:     loadMonitors(root, manifest),
        themes:       loadThemes(pickPath('themes', 'themes')),
        outputStyles: loadOutputStyles(pickPath('outputStyles', 'output-styles')),
        settings:     readJsonIfExists(join(root, 'settings.json')) || {},
        userConfig:   manifest.userConfig || {},
        channels:     manifest.channels || [],
        dependencies: manifest.dependencies || [],
        bin:          existsSync(join(root, 'bin')) ? join(root, 'bin') : null,
    }
}

export function loadClaudeMarketplace(dir) {
    const root = resolve(dir)
    const file = join(root, '.claude-plugin', 'marketplace.json')
    if (!existsSync(file)) throw new Error(`loadClaudeMarketplace: ${file} not found`)
    const catalog = JSON.parse(readFileSync(file, 'utf8'))
    const pluginRoot = catalog.metadata?.pluginRoot
    const plugins = (catalog.plugins || []).map(entry => ({
        entry,
        plugin: resolveLocalSource(root, entry.source, pluginRoot)
            ? safeLoad(resolveLocalSource(root, entry.source, pluginRoot))
            : null,
    }))
    return { root, catalog, plugins }
}

function safeLoad(p) { try { return loadClaudePlugin(p) } catch (e) { console.error(`[plugsdk] skipping malformed plugin at '${p}': ${e.message}`); return null } }

function resolveLocalSource(root, source, pluginRoot) {
    if (typeof source === 'string') {
        const base = pluginRoot ? join(root, pluginRoot) : root
        const c = source.startsWith('.') ? join(root, source) : join(base, source)
        return existsSync(c) ? c : null
    }
    if (source && typeof source === 'object' && source.source === 'file' && source.path) return resolve(root, source.path)
    return null
}

function readJsonIfExists(p) { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null }

function loadHooks(root, manifest) {
    const v = manifest.hooks
    if (v && typeof v === 'object' && !Array.isArray(v)) return v.hooks || v
    if (typeof v === 'string') {
        const f = join(root, v)
        if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); return j.hooks || j }
    }
    const def = join(root, 'hooks', 'hooks.json')
    if (existsSync(def)) { const j = JSON.parse(readFileSync(def, 'utf8')); return j.hooks || j }
    return {}
}

function loadSkills(paths) {
    const out = []
    for (const p of paths) {
        if (!existsSync(p)) continue
        for (const name of readdirSync(p)) {
            const f = join(p, name, 'SKILL.md')
            if (!existsSync(f)) continue
            const { fields, body } = parseFrontmatter(readFileSync(f, 'utf8'))
            out.push({ name: fields.name || name, dir: join(p, name), file: f, fields, body, description: fields.description || '' })
        }
    }
    return out
}

function loadCommands(paths) {
    const out = []
    for (const p of paths) {
        if (!existsSync(p)) continue
        const s = statSync(p)
        if (s.isFile() && p.endsWith('.md')) { out.push(parseMarkdownEntry(p)); continue }
        if (s.isDirectory()) for (const n of readdirSync(p)) {
            const f = join(p, n)
            if (statSync(f).isFile() && f.endsWith('.md')) out.push(parseMarkdownEntry(f))
        }
    }
    return out
}

const AGENT_FORBIDDEN = ['hooks', 'mcpServers', 'permissionMode']

function loadAgents(paths) {
    const out = []
    for (const p of paths) {
        if (!existsSync(p)) continue
        const s = statSync(p)
        const files = s.isFile() ? [p]
            : readdirSync(p).map(f => join(p, f)).filter(f => statSync(f).isFile() && f.endsWith('.md'))
        for (const f of files) {
            const { fields, body } = parseFrontmatter(readFileSync(f, 'utf8'))
            for (const k of AGENT_FORBIDDEN) if (fields[k] !== undefined) throw new Error(`agent ${f}: field "${k}" not allowed`)
            if (fields.isolation && fields.isolation !== 'worktree') throw new Error(`agent ${f}: isolation must be "worktree"`)
            out.push({ name: fields.name || basename(f, '.md'), file: f, fields, body, description: fields.description || '' })
        }
    }
    return out
}

function loadInlineOrFile(root, manifest, key, def, project) {
    const v = manifest[key]
    if (v && typeof v === 'object' && !Array.isArray(v)) return project(v)
    if (typeof v === 'string') {
        const f = join(root, v)
        if (existsSync(f)) return project(JSON.parse(readFileSync(f, 'utf8')))
    }
    const d = join(root, def)
    return project(existsSync(d) ? JSON.parse(readFileSync(d, 'utf8')) : null)
}

function loadMonitors(root, manifest) {
    const v = manifest.monitors
    if (Array.isArray(v)) return v
    if (typeof v === 'string') {
        const f = join(root, v)
        if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
    }
    const d = join(root, 'monitors', 'monitors.json')
    return existsSync(d) ? JSON.parse(readFileSync(d, 'utf8')) : []
}

function loadThemes(paths) {
    const out = []
    for (const p of paths) {
        if (!existsSync(p)) continue
        for (const n of readdirSync(p)) {
            if (!n.endsWith('.json')) continue
            out.push({ slug: basename(n, '.json'), file: join(p, n), ...JSON.parse(readFileSync(join(p, n), 'utf8')) })
        }
    }
    return out
}

function loadOutputStyles(paths) {
    const out = []
    for (const p of paths) {
        if (!existsSync(p)) continue
        for (const n of readdirSync(p)) if (n.endsWith('.md')) out.push(parseMarkdownEntry(join(p, n)))
    }
    return out
}

function parseMarkdownEntry(file) {
    const { fields, body } = parseFrontmatter(readFileSync(file, 'utf8'))
    return { name: fields.name || basename(file, extname(file)), file, fields, body, description: fields.description || '' }
}

export function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!m) return { fields: {}, body: text }
    const fields = {}
    for (const line of m[1].split(/\r?\n/)) {
        if (!line.trim() || line.startsWith('#')) continue
        const i = line.indexOf(':')
        if (i < 0) continue
        fields[line.slice(0, i).trim()] = parseScalar(line.slice(i + 1).trim())
    }
    return { fields, body: m[2] }
}

function parseScalar(raw) {
    if (raw === '') return ''
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('[') && raw.endsWith(']'))) {
        try { return JSON.parse(raw) } catch { /* fall */ }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
    return raw
}
