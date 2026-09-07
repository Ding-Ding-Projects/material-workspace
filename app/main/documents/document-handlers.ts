import type { IpcMain } from 'electron';
import { IPC } from '../../shared/ipc.js';
import { DocumentService, type DocumentRecord } from './document-service.js';

export const documentService = new DocumentService();

function asRecord(value: unknown): DocumentRecord {
  if (typeof value !== 'object' || value === null) throw new Error('a document is required');
  const candidate = value as Partial<DocumentRecord>;
  if (typeof candidate.id !== 'string') throw new Error('the document has no identifier');
  if (typeof candidate.application !== 'string') throw new Error('the document has no application');
  if (typeof candidate.title !== 'string') throw new Error('the document has no title');
  return value as DocumentRecord;
}

export function registerDocumentHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.documentList, () => documentService.list());

  ipcMain.handle(IPC.documentCreate, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('creating a document requires an application and a title');
    }
    const { application, title, content } = payload as Record<string, unknown>;
    if (typeof application !== 'string' || application.length === 0) {
      throw new Error('an application identifier is required');
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('a title is required');
    }
    return documentService.create({ application, title: title.trim(), content: content ?? null });
  });

  ipcMain.handle(IPC.documentOpen, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('a document identifier is required');
    return documentService.open(id);
  });

  ipcMain.handle(IPC.documentSave, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('saving requires a document');
    }
    const { document, mode } = payload as Record<string, unknown>;
    const record = asRecord(document);
    if (mode === 'autosave') {
      documentService.queueAutosave(record);
      // Says exactly what happened: the change is queued, not yet committed.
      // Reporting a commit here would be a success flag derived from the path
      // chosen rather than from the outcome.
      return { saved: false, queued: true, commit: null, historyError: null };
    }
    return documentService.save(record);
  });

  ipcMain.handle(IPC.documentRename, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('renaming requires a document identifier and a title');
    }
    const { id, title } = payload as Record<string, unknown>;
    if (typeof id !== 'string') throw new Error('a document identifier is required');
    if (typeof title !== 'string') throw new Error('a title is required');
    return documentService.rename(id, title);
  });

  ipcMain.handle(IPC.documentDelete, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('a document identifier is required');
    return documentService.remove(id);
  });
}
