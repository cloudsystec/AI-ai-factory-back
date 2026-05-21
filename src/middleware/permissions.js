/**
 * @param {'execute'|'write'|'manageUsers'} capability
 */
export function requireCapability(capability) {
  return (req, res, next) => {
    const caps = req.capabilities;
    if (!caps) {
      return res.status(401).json({ error: "Sessão inválida" });
    }
    const map = {
      execute: caps.canExecute,
      write: caps.canWrite,
      manageUsers: caps.canManageUsers,
    };
    if (!map[capability]) {
      return res.status(403).json({
        error: "Permissão negada",
        code: `forbidden_${capability}`,
      });
    }
    next();
  };
}
