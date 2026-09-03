import { HookType } from '../types/index.js'

/**
 * claudeAdapter — host-side helpers for Claude Code's hook protocol.
 *
 * Reference: https://code.claude.com/docs/en/hooks
 *
 * Hosts use this to:
 *   - map native event names to canonical HookType ids (and back)
 *   - inspect a native event for matcher support
 *   - classify the output schema family of an event
 */

const NATIVE_TO_CANONICAL = Object.freeze({
    PreToolUse:           HookType.PRE_TOOL_USE,
    PostToolUse:          HookType.POST_TOOL_USE,
    PostToolUseFailure:   HookType.POST_TOOL_USE_FAILURE,
    PostToolBatch:        HookType.POST_TOOL_BATCH,
    PermissionRequest:    HookType.PERMISSION_REQUEST,
    PermissionDenied:     HookType.PERMISSION_DENIED,
    SessionStart:         HookType.SESSION_START,
    SessionEnd:           HookType.SESSION_END,
    Setup:                HookType.SETUP,
    UserPromptSubmit:     HookType.PROMPT_SUBMIT,
    UserPromptExpansion:  HookType.PROMPT_EXPANSION,
    Notification:         HookType.NOTIFICATION,
    Stop:                 HookType.STOP,
    StopFailure:          HookType.STOP_FAILURE,
    SubagentStart:        HookType.SUBAGENT_START,
    SubagentStop:         HookType.SUBAGENT_STOP,
    TaskCreated:          HookType.TASK_CREATED,
    TaskCompleted:        HookType.TASK_COMPLETED,
    TeammateIdle:         HookType.TEAMMATE_IDLE,
    InstructionsLoaded:   HookType.INSTRUCTIONS_LOADED,
    ConfigChange:         HookType.CONFIG_CHANGE,
    CwdChanged:           HookType.CWD_CHANGED,
    FileChanged:          HookType.FILE_CHANGED,
    WorktreeCreate:       HookType.WORKTREE_CREATE,
    WorktreeRemove:       HookType.WORKTREE_REMOVE,
    PreCompact:           HookType.PRE_COMPACT,
    PostCompact:          HookType.POST_COMPACT,
    Elicitation:          HookType.ELICITATION,
    ElicitationResult:    HookType.ELICITATION_RESULT,
})

const CANONICAL_TO_NATIVE = Object.freeze(
    Object.fromEntries(Object.entries(NATIVE_TO_CANONICAL).map(([k, v]) => [v, k]))
)

const NO_MATCHER_EVENTS = new Set([
    'UserPromptSubmit', 'PostToolBatch', 'TaskCreated', 'TaskCompleted',
    'Stop', 'TeammateIdle', 'CwdChanged', 'WorktreeCreate', 'WorktreeRemove',
])

const PERMISSION_DECISION_EVENTS = new Set(['PreToolUse', 'PermissionRequest'])

const TOP_LEVEL_DECISION_EVENTS = new Set([
    'UserPromptSubmit', 'UserPromptExpansion', 'Stop', 'SubagentStop',
    'PostToolBatch', 'PreCompact', 'ConfigChange',
    'TaskCreated', 'TaskCompleted', 'TeammateIdle',
])

export const claudeAdapter = {
    name: 'claude',

    listNativeEvents: () => Object.keys(NATIVE_TO_CANONICAL),
    getCanonical:     (native) => NATIVE_TO_CANONICAL[native] ?? null,
    getNative:        (canonical) => CANONICAL_TO_NATIVE[canonical] ?? null,
    eventSupportsMatcher: (native) => !NO_MATCHER_EVENTS.has(native),
    isPermissionDecisionEvent: (native) => PERMISSION_DECISION_EVENTS.has(native),
    isTopLevelDecisionEvent:   (native) => TOP_LEVEL_DECISION_EVENTS.has(native),

    /**
     * Match Claude Code's documented matcher rules:
     *   '*' | '' | undefined         → match every event/tool name
     *   /^[A-Za-z0-9_|]+$/           → exact string OR pipe-separated literal list
     *   anything else                → JavaScript regex
     */
    matches(matcher, target) {
        if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
        if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
            const parts = matcher.split('|')
            return parts.includes(target)
        }
        try { return new RegExp(matcher).test(target) }
        catch { return false }
    },
}
