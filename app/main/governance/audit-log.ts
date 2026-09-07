/**
 * A tamper-evident append-only audit log.
 *
 * Each record carries the hash of the record before it, so altering or removing
 * any earlier entry breaks every hash after it and verification says exactly
 * where. This detects tampering; it does not prevent it, and the surface says so
 * plainly. Anybody who can write to the file can rewrite the whole chain — what
 * they cannot do is change one entry and leave the rest consistent.
 *
 * Stored as JSON Lines so a partial write damages one record rather than the
 * whole log, and so an append never has to rewrite what came before.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { auditDir } from '../storage/paths.js';

export interface AuditRecord {
  sequence: number;
  at: string;
  actor: string;
  action: string;
  subject: string;
  detail: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

/**
 * Unit separator, chosen because no field above can contain it and a
 * separator a field CAN contain would let two different records hash
 * identically — which in a tamper-evident chain is the whole failure.
 *
 * Written as fromCharCode rather than as a literal control byte. The byte
 * is invisible in every editor and diff, and any tool that sanitises control
 * characters would silently change every hash this log has ever written.
 * The produced string is byte-identical, so existing chains still verify.
 */
const FIELD_SEPARATOR = String.fromCharCode(31);
const MAX_DETAIL_BYTES = 16 * 1024;

function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  // Field order is fixed and explicit. A hash over JSON.stringify of an object
  // whose key order can vary would verify today and fail tomorrow for no reason.
  const canonical = [
    String(record.sequence),
    record.at,
    record.actor,
    record.action,
    record.subject,
    JSON.stringify(record.detail),
    record.previousHash,
  ].join(FIELD_SEPARATOR);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export class AuditLog {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string = path.join(auditDir(), 'audit.jsonl')) {
    this.file = file;
  }

  private async readAll(): Promise<AuditRecord[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: AuditRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed) as AuditRecord);
      } catch {
        // A damaged line is preserved as a gap rather than dropped silently;
        // verification below reports it as a break in the chain.
        records.push({
          sequence: -1,
          at: '',
          actor: '',
          action: 'unreadable-record',
          subject: trimmed.slice(0, 120),
          detail: {},
          previousHash: '',
          hash: '',
        });
      }
    }
    return records;
  }

  async append(entry: {
    actor: string;
    action: string;
    subject: string;
    detail?: Record<string, unknown>;
  }): Promise<AuditRecord> {
    const run = this.queue.then(async () => {
      const detail = entry.detail ?? {};
      const detailBytes = Buffer.byteLength(JSON.stringify(detail), 'utf8');
      if (detailBytes > MAX_DETAIL_BYTES) {
        throw new Error(
          'the audit detail exceeds ' + MAX_DETAIL_BYTES + ' bytes and was not recorded',
        );
      }

      const existing = await this.readAll();
      const last = existing.at(-1);
      const withoutHash: Omit<AuditRecord, 'hash'> = {
        sequence: (last?.sequence ?? 0) + 1,
        at: new Date().toISOString(),
        actor: entry.actor,
        action: entry.action,
        subject: entry.subject,
        detail,
        previousHash: last?.hash ?? GENESIS,
      };
      const record: AuditRecord = { ...withoutHash, hash: hashRecord(withoutHash) };

      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      // Appended, never rewritten. An append-only log that rewrites itself to
      // add a line is not append-only.
      await fsp.appendFile(this.file, JSON.stringify(record) + '\n', 'utf8');
      return record;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(query: { limit?: number } = {}): Promise<AuditRecord[]> {
    const records = await this.readAll();
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 10000) : 500;
    return records.slice(-limit);
  }

  /**
   * Walk the chain. Reports the first break and its sequence rather than a bare
   * pass or fail, because "something changed" is not actionable and "record 412
   * does not match its recorded hash" is.
   */
  async verify(): Promise<{
    intact: boolean;
    recordCount: number;
    firstBreakAt: number | null;
    reason: string | null;
  }> {
    const records = await this.readAll();
    let previous = GENESIS;
    for (const record of records) {
      if (record.sequence === -1) {
        return {
          intact: false,
          recordCount: records.length,
          firstBreakAt: null,
          reason: 'the log contains a record that could not be parsed',
        };
      }
      if (record.previousHash !== previous) {
        return {
          intact: false,
          recordCount: records.length,
          firstBreakAt: record.sequence,
          reason:
            'record ' +
            record.sequence +
            ' does not follow the record before it. An entry was altered, inserted or removed.',
        };
      }
      const { hash, ...rest } = record;
      if (hashRecord(rest) !== hash) {
        return {
          intact: false,
          recordCount: records.length,
          firstBreakAt: record.sequence,
          reason: 'record ' + record.sequence + ' does not match its own recorded hash.',
        };
      }
      previous = hash;
    }
    return { intact: true, recordCount: records.length, firstBreakAt: null, reason: null };
  }
}
