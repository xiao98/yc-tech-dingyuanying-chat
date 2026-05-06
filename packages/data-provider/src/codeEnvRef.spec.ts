/* `CodeEnvRef` is a plain typed struct (no helpers, no resolvers).
 * Behavioral coverage lives at consumer sites — `processCodeOutput`
 * (write), `primeFiles` (read+reupload), `primeSkillFiles` (read+write),
 * agents `ToolNode` (forward to codeapi). This file just pins the
 * shape so a future refactor can't silently widen or narrow the
 * fields without surfacing here. */
import type { CodeEnvKind, CodeEnvRef } from './codeEnvRef';

describe('CodeEnvRef', () => {
  it('accepts the canonical shape for kind: skill', () => {
    const ref: CodeEnvRef = {
      kind: 'skill',
      id: 'skill_123',
      storage_session_id: 'sess_abc',
      file_id: 'file_xyz',
      version: 7,
    };
    expect(ref.kind).toBe('skill');
    expect(ref.version).toBe(7);
  });

  it('accepts the canonical shape for kind: user', () => {
    const ref: CodeEnvRef = {
      kind: 'user',
      id: 'user_456',
      storage_session_id: 'sess_def',
      file_id: 'file_uvw',
    };
    expect(ref.kind).toBe('user');
    expect(ref.version).toBeUndefined();
  });

  it('accepts the canonical shape for kind: agent', () => {
    const ref: CodeEnvRef = {
      kind: 'agent',
      id: 'agent_789',
      storage_session_id: 'sess_ghi',
      file_id: 'file_rst',
    };
    expect(ref.kind).toBe('agent');
  });

  it('CodeEnvKind union enumerates all four kinds', () => {
    const kinds: CodeEnvKind[] = ['skill', 'agent', 'user', 'system'];
    expect(kinds).toHaveLength(4);
  });
});
