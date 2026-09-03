import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookType, claudeAdapter, loadClaudePlugin, loadClaudeMarketplace, createHost, parseFrontmatter } from './src/index.js'

let pass = 0, fail = 0
const t  = (n, fn) => { try { fn(); console.log('ok', n); pass++ } catch (e) { console.log('FAIL', n, '\n', e.stack||e.message); fail++ } }
const ta = async (n, fn) => { try { await fn(); console.log('ok', n); pass++ } catch (e) { console.log('FAIL', n, '\n', e.stack||e.message); fail++ } }
const throws = (fn, re) => { let t; try { fn() } catch (e) { t = e } if (!t || !re.test(t.message)) throw new Error('expected throw matching ' + re) }

t('adapter+frontmatter+matcher rules', () => {
    for (const e of ['SessionStart','SessionEnd','Setup','UserPromptSubmit','UserPromptExpansion','PreToolUse','PermissionRequest','PermissionDenied','PostToolUse','PostToolUseFailure','PostToolBatch','Notification','SubagentStart','SubagentStop','TaskCreated','TaskCompleted','Stop','StopFailure','TeammateIdle','InstructionsLoaded','ConfigChange','CwdChanged','FileChanged','WorktreeCreate','WorktreeRemove','PreCompact','PostCompact','Elicitation','ElicitationResult'])
        assert.ok(claudeAdapter.getCanonical(e), e)
    assert.equal(claudeAdapter.matches('Bash|Edit', 'Edit'), true)
    assert.equal(claudeAdapter.matches('^Notebook', 'NotebookEdit'), true)
    assert.equal(claudeAdapter.matches('Bash', 'Edit'), false)
    const fm = parseFrontmatter('---\nname: x\nflag: true\n---\nbody')
    assert.equal(fm.fields.name, 'x'); assert.equal(fm.fields.flag, true); assert.equal(fm.body, 'body')
})

const buildFixture = (root) => {
    const m = (p) => mkdirSync(join(root, p), { recursive: true })
    m('.claude-plugin'); m('hooks'); m('skills/review'); m('commands'); m('agents'); m('monitors'); m('themes'); m('output-styles'); m('bin')
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: 'audit', version: '1.0.0', description: 'd', license: 'MIT',
        userConfig: { token: { type: 'string', title: 'T', description: 'd', sensitive: true, default: 'def' } },
        channels: [{ server: 'tg' }], dependencies: [{ name: 'v', version: '~2.0' }],
    }))
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/h' }] }],
        Stop:       [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/h' }] }],
    } }))
    writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '---\ndescription: Review code\ndisable-model-invocation: true\n---\n\nReview $ARGUMENTS.\n')
    writeFileSync(join(root, 'commands', 'flat.md'), '---\ndescription: Flat\n---\n\nDo a thing.\n')
    writeFileSync(join(root, 'agents', 'sec.md'), '---\nname: sec\ndescription: r\nmodel: sonnet\nisolation: worktree\n---\n\nReview.\n')
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: '${CLAUDE_PLUGIN_ROOT}/srv', args: [] } } }))
    writeFileSync(join(root, '.lsp.json'), JSON.stringify({ go: { command: 'gopls', extensionToLanguage: { '.go': 'go' } } }))
    writeFileSync(join(root, 'monitors', 'monitors.json'), JSON.stringify([{ name: 'log', command: 'tail -F x', description: 'app log' }]))
    writeFileSync(join(root, 'themes', 'dracula.json'), JSON.stringify({ name: 'Dracula', base: 'dark', overrides: { claude: '#bd93f9' } }))
    writeFileSync(join(root, 'output-styles', 'terse.md'), '---\ndescription: short\n---\n\nBe brief.\n')
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ agent: 'sec', subagentStatusLine: 'busy', extra: 'kept' }))
    return root
}

t('loadClaudePlugin yields universal Plugin shape with every component', () => {
    const p = loadClaudePlugin(buildFixture(mkdtempSync(join(tmpdir(), 'plugsdk-fix-'))))
    assert.equal(p.format, 'claude-code'); assert.equal(p.manifest.name, 'audit')
    assert.ok(p.hooks.PreToolUse && p.hooks.Stop)
    assert.equal(p.skills[0].name, 'review'); assert.equal(p.skills[0].fields['disable-model-invocation'], true)
    assert.equal(p.commands[0].name, 'flat'); assert.equal(p.agents[0].name, 'sec')
    assert.equal(p.mcpServers.db.command, '${CLAUDE_PLUGIN_ROOT}/srv')
    assert.equal(p.lspServers.go.command, 'gopls'); assert.equal(p.monitors[0].name, 'log')
    assert.equal(p.themes[0].slug, 'dracula'); assert.equal(p.outputStyles[0].name, 'terse')
    assert.equal(p.settings.agent, 'sec'); assert.equal(p.bin?.endsWith('bin'), true)
})

t('loadClaudePlugin rejects forbidden agent fields + parses marketplace', () => {
    const r = mkdtempSync(join(tmpdir(), 'plugsdk-bad-'))
    mkdirSync(join(r, 'agents'), { recursive: true })
    writeFileSync(join(r, 'agents', 'x.md'), '---\nname: x\nhooks: yes\n---\nbody\n')
    throws(() => loadClaudePlugin(r), /not allowed/)
    const m = mkdtempSync(join(tmpdir(), 'plugsdk-mkt-'))
    mkdirSync(join(m, '.claude-plugin'), { recursive: true })
    buildFixture(join(m, 'plugins', 'audit'))
    writeFileSync(join(m, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'acme', owner: { name: 'A' }, metadata: { pluginRoot: './plugins' }, plugins: [{ name: 'audit', source: 'audit' }] }))
    const mk = loadClaudeMarketplace(m)
    assert.equal(mk.plugins[0].plugin.manifest.name, 'audit')
})

await ta('createHost.use fans every component to onCallbacks', async () => {
    const calls = { skill: [], agent: [], command: [], theme: [], style: [], channel: [], setting: [], bin: [] }
    const host = createHost({ on: {
        onSkill:       (_, s) => calls.skill.push(s.name),
        onAgent:       (_, a) => calls.agent.push(a.name),
        onCommand:     (_, c) => calls.command.push(c.name),
        onTheme:       (_, t) => calls.theme.push(t.slug),
        onOutputStyle: (_, o) => calls.style.push(o.name),
        onChannel:     (_, c) => calls.channel.push(c.server),
        onSetting:     (_, s) => calls.setting.push(s.agent),
        onBin:         (_, d) => calls.bin.push(d),
    } })
    const p = loadClaudePlugin(buildFixture(mkdtempSync(join(tmpdir(), 'plugsdk-host-'))))
    await host.use(p)
    assert.deepEqual(calls.skill, ['review']); assert.deepEqual(calls.agent, ['sec'])
    assert.deepEqual(calls.command, ['flat']); assert.deepEqual(calls.theme, ['dracula'])
    assert.deepEqual(calls.style, ['terse']); assert.deepEqual(calls.channel, ['tg'])
    assert.deepEqual(calls.setting, ['sec']); assert.equal(calls.bin.length, 1)
    await host.shutdown()
})

await ta('createHost.dispatch: command, http, deny>allow merge, top-level block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugsdk-d-'))
    mkdirSync(join(root, '.claude-plugin'), { recursive: true }); mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'd' }))
    const stop = join(root, 'stop.mjs')
    writeFileSync(stop, `process.stdout.write(JSON.stringify({decision:'block',reason:'wait'}))`)
    const deny = join(root, 'deny.mjs')
    writeFileSync(deny, `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'no'}}))`)
    const httpFixture = (await import('node:http')).createServer((req, res) => { let b=''; req.on('data', d => b+=d); req.on('end', () => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',additionalContext:'ctx'}})) }) })
    await new Promise(r => httpFixture.listen(0, r))
    const port = httpFixture.address().port
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [
            { type: 'command', command: `"${process.execPath}" "${deny.replace(/\\/g,'/')}"` },
            { type: 'http', url: `http://127.0.0.1:${port}/` },
        ] }],
        Stop: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${stop.replace(/\\/g,'/')}"` }] }],
    } }))
    const host = createHost()
    await host.use(loadClaudePlugin(root))
    const r1 = await host.dispatch('PreToolUse', { tool_name: 'Bash', tool_input: {} })
    assert.equal(r1.hookSpecificOutput.permissionDecision, 'deny')
    const r2 = await host.dispatch('Stop', {})
    assert.equal(r2.decision, 'block'); assert.equal(r2.reason, 'wait')
    await host.shutdown(); httpFixture.close()
})

await ta('createHost: monitor stdout + ${user_config} + skill-invoke trigger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugsdk-m-'))
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: 'mon', userConfig: { greeting: { type: 'string', title: 'g', description: 'd', default: 'hello' } },
        monitors: [
            { name: 'always', description: 'always', command: `"${process.execPath}" -e "console.log('always:'+process.env.CLAUDE_PLUGIN_ROOT)"` },
            { name: 'on-demand', description: 'd', when: 'on-skill-invoke:hi', command: `"${process.execPath}" -e "console.log('demand-line')"` },
        ],
    }))
    const lines = []
    const host = createHost({ on: { onMonitorLine: (_, mon, line) => lines.push(mon.name + ':' + line) } })
    await host.use(loadClaudePlugin(root))
    await new Promise(r => setTimeout(r, 400))
    assert.ok(lines.some(l => l.startsWith('always:') && l.includes(root)), 'always: ' + JSON.stringify(lines))
    host.notifySkillInvoked('mon', 'hi')
    await new Promise(r => setTimeout(r, 400))
    assert.ok(lines.some(l => l.startsWith('on-demand:demand-line')), 'on-demand: ' + JSON.stringify(lines))
    await host.shutdown()
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
