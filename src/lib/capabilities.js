/** @typedef {'executor'|'auditor'|'viewer'} UserRole */

/**
 * @param {UserRole} role
 * @param {{ usersUsed: number, usersMax: number }} quota
 */
export function buildCapabilities(role, quota) {
  const canExecute = role === "executor";
  const canWrite = role === "executor" || role === "auditor";
  const canManageUsers = role === "auditor";
  const canAddUser = quota.usersUsed < quota.usersMax;

  return {
    role,
    canExecute,
    canWrite,
    canManageUsers,
    canViewCursorKeys: false,
    usersUsed: quota.usersUsed,
    usersMax: quota.usersMax,
    canAddUser,
  };
}
