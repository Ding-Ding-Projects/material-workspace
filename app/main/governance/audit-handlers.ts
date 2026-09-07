import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import { AuditLog } from './audit-log.js';

export const auditLog = new AuditLog();

export function registerAuditHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.auditAppend, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('an audit entry is required');
    }
    const { actor, action, subject, detail } = payload as Record<string, unknown>;
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('an actor is required');
    if (typeof action !== 'string' || action.length === 0) throw new Error('an action is required');
    if (typeof subject !== 'string') throw new Error('a subject is required');
    return auditLog.append({
      actor,
      action,
      subject,
      detail:
        typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {},
    });
  });

  ipcMain.handle(IPC.auditList, (_event, query: unknown) => {
    const request = (typeof query === 'object' && query !== null ? query : {}) as Record<
      string,
      unknown
    >;
    return auditLog.list({
      limit: typeof request.limit === 'number' ? request.limit : undefined,
    });
  });

  ipcMain.handle(IPC.auditVerify, () => auditLog.verify());
}
