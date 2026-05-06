/**
 * Resource kind for sandbox file caching. Drives the `sessionKey`
 * shape that codeapi derives — explicit instead of emergent.
 *
 * - `skill`: shared per skill identity. Cross-user sharing within an
 *   org/tenant. SessionKey omits the user dimension.
 * - `agent`: shared per agent identity. Same sharing semantic as
 *   skills (agents are addressable resources accessible to a
 *   permission-defined audience).
 * - `user`: user-private. SessionKey includes the user dimension.
 *   Used for chat attachments and user-uploaded artifacts.
 * - `system`: shared system-wide. Reserved for built-in resources.
 */
export type CodeEnvKind = 'skill' | 'agent' | 'user' | 'system';

/**
 * Typed reference to a file in the code-execution sandbox.
 *
 * `storage_session_id` is intentionally distinct from the *execution*
 * session id at the top level of an execute response — they are
 * different concepts that historically shared the field name
 * `session_id`. This is the long-lived storage session keyed by the
 * resource's identity (skill/agent/user), not the transient
 * sandbox-run session.
 *
 * `kind` and `id` together name the resource that owns this file's
 * storage session. CodeAPI uses them (plus the auth-context tenant
 * id) to derive the sessionKey, which determines who shares the
 * cache. Cross-user sharing for shared resources (skills, agents) is
 * a designed property of the kind switch, not an emergent side
 * effect. See codeapi #1455 / agents #148 / LC #12960.
 *
 * `version` carries the resource version when relevant — primarily
 * for `kind: 'skill'`, where bumping the version (on any skill edit)
 * scopes the cache to that revision.
 */
export interface CodeEnvRef {
  kind: CodeEnvKind;
  id: string;
  storage_session_id: string;
  file_id: string;
  entity_id?: string;
  version?: number;
}
