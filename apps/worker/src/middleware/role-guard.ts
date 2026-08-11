import type { MiddlewareHandler } from 'hono';
import type { Env } from '../index.js';

type Role = 'owner' | 'admin' | 'staff';

export function requireRole(...allowed: Role[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const staff = c.get('staff');
    if (!staff || !allowed.includes(staff.role)) {
      return c.json(
        { success: false, error: `この操作には${allowed[0]}権限が必要です` },
        403,
      );
    }
    return next();
  };
}
