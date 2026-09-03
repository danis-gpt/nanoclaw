import { getUserRoles, grantRole, revokeRole } from '../../modules/permissions/db/user-roles.js';
import type { UserRoleKind } from '../../types.js';
import { registerResource } from '../crud.js';

const ROLE_KINDS = ['owner', 'admin', 'product_approver', 'technical_approver'] satisfies UserRoleKind[];

function roleScope(role: UserRoleKind, groupId: string | null): string | null {
  if (groupId !== null && groupId.length === 0) throw new Error('group scope must not be empty');
  if (role === 'owner' && groupId !== null) {
    throw new Error('owner role is global; do not pass --group');
  }
  if ((role === 'product_approver' || role === 'technical_approver') && groupId === null) {
    throw new Error(`${role} role requires --group scope`);
  }
  return groupId;
}

async function hasExactRole(userId: string, role: UserRoleKind, groupId: string | null): Promise<boolean> {
  return (await getUserRoles(userId)).some((row) => row.role === role && row.agent_group_id === groupId);
}

registerResource({
  name: 'role',
  plural: 'roles',
  table: 'user_roles',
  description:
    'User role — privilege grant. "owner" is global; "admin" may be global or group-scoped; product_approver and technical_approver are always group-scoped.',
  idColumn: 'user_id',
  columns: [
    { name: 'user_id', type: 'string', description: 'User receiving the role. Must exist in users table.' },
    {
      name: 'role',
      type: 'string',
      description:
        'owner is global; admin may be global or scoped; product_approver and technical_approver must be scoped.',
      enum: ROLE_KINDS,
    },
    {
      name: 'agent_group_id',
      type: 'string',
      description:
        'Null = global (all groups). A specific ID limits the role to that group. Owner must always be null.',
    },
    { name: 'granted_by', type: 'string', description: 'Who granted this role. Informational.' },
    { name: 'granted_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    grant: {
      access: 'approval',
      description: 'Grant a role through the canonical permission helper.',
      args: [
        { name: 'user', type: 'string', description: 'Exact target user ID.', required: true },
        { name: 'role', type: 'string', description: 'Exact role kind.', required: true, enum: ROLE_KINDS },
        { name: 'group', type: 'string', description: 'Agent group scope when required.' },
        { name: 'granted_by', type: 'string', description: 'Exact granting actor ID.' },
      ],
      handler: async (args) => {
        const userId = args.user as string;
        if (userId.length === 0) throw new Error('--user must not be empty');
        const role = args.role as UserRoleKind;
        const groupId = roleScope(role, (args.group as string) ?? null);
        const grantedBy = (args.granted_by as string) ?? null;
        if (!(await hasExactRole(userId, role, groupId))) {
          await grantRole({
            user_id: userId,
            role,
            agent_group_id: groupId,
            granted_by: grantedBy,
            granted_at: new Date().toISOString(),
          });
        }
        return { user_id: userId, role, agent_group_id: groupId };
      },
    },
    revoke: {
      access: 'approval',
      description: 'Revoke an exact role scope through the canonical permission helper.',
      args: [
        { name: 'user', type: 'string', description: 'Exact target user ID.', required: true },
        { name: 'role', type: 'string', description: 'Exact role kind.', required: true, enum: ROLE_KINDS },
        { name: 'group', type: 'string', description: 'Agent group scope when required.' },
      ],
      handler: async (args) => {
        const userId = args.user as string;
        if (userId.length === 0) throw new Error('--user must not be empty');
        const role = args.role as UserRoleKind;
        const groupId = roleScope(role, (args.group as string) ?? null);
        if (!(await hasExactRole(userId, role, groupId))) {
          throw new Error('exact role grant does not exist');
        }
        await revokeRole(userId, role, groupId);
        if (await hasExactRole(userId, role, groupId)) {
          throw new Error('exact role grant remains after revoke');
        }
        return { revoked: { user_id: userId, role, agent_group_id: groupId } };
      },
    },
  },
});
