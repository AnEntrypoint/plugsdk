/**
 * HookType — canonical event identifiers used by plugsdk's host-side loader.
 * Mapped 1:1 to Claude Code's documented native event names so a host can
 * either dispatch by canonical id or by native string.
 */
export const HookType = Object.freeze({
    PRE_TOOL_USE:           'pre_tool_use',
    POST_TOOL_USE:          'post_tool_use',
    POST_TOOL_USE_FAILURE:  'post_tool_use_failure',
    POST_TOOL_BATCH:        'post_tool_batch',
    PERMISSION_REQUEST:     'permission_request',
    PERMISSION_DENIED:      'permission_denied',
    SESSION_START:          'session_start',
    SESSION_END:            'session_end',
    SETUP:                  'setup',
    PROMPT_SUBMIT:          'prompt_submit',
    PROMPT_EXPANSION:       'prompt_expansion',
    NOTIFICATION:           'notification',
    STOP:                   'stop',
    STOP_FAILURE:           'stop_failure',
    SUBAGENT_START:         'subagent_start',
    SUBAGENT_STOP:          'subagent_stop',
    TASK_CREATED:           'task_created',
    TASK_COMPLETED:         'task_completed',
    TEAMMATE_IDLE:          'teammate_idle',
    INSTRUCTIONS_LOADED:    'instructions_loaded',
    CONFIG_CHANGE:          'config_change',
    CWD_CHANGED:            'cwd_changed',
    FILE_CHANGED:           'file_changed',
    WORKTREE_CREATE:        'worktree_create',
    WORKTREE_REMOVE:        'worktree_remove',
    PRE_COMPACT:            'pre_compact',
    POST_COMPACT:           'post_compact',
    ELICITATION:            'elicitation',
    ELICITATION_RESULT:     'elicitation_result',
})
