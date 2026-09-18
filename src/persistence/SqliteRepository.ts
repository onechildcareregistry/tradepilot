import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { entities, initialState, type AuditRecord, type State } from '../domain/models.js';
import { decodeState, projections, type Mutation, type Repository } from './Repository.js';
export class SqliteRepository implements Repository {
  private db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 10000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS State (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS WorkerLease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL)',
    );
    for (const e of entities)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS [${e}] (id TEXT PRIMARY KEY, at TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ix_${e}_at ON [${e}](at)`,
      );
    this.db.prepare('INSERT OR IGNORE INTO State VALUES (1,?)').run(JSON.stringify(initialState()));
    const seed = initialState().ledger[0];
    if (seed)
      this.db
        .prepare('INSERT OR IGNORE INTO CashLedger VALUES(?,?,?)')
        .run('initial:event', seed.at, JSON.stringify(seed));
  }
  private current(): State {
    const row = this.db.prepare('SELECT payload FROM State WHERE id=1').get() as
      { payload: string } | undefined;
    if (!row) throw new Error('Missing state');
    return decodeState(row.payload);
  }
  async read(): Promise<State> {
    return this.current();
  }
  async transact<T>(mutation: Mutation<T>, owner?: string): Promise<T> {
    return this.db
      .transaction(() => {
        if (owner) {
          const lease = this.db
            .prepare('SELECT owner,expires FROM WorkerLease WHERE id=1')
            .get() as { owner: string; expires: number } | undefined;
          if (!lease || lease.owner !== owner || lease.expires <= Date.now())
            throw new Error('Worker lease lost');
        }
        const before = this.current(),
          next = structuredClone(before),
          audit: AuditRecord[] = [];
        const result = mutation(next, audit);
        audit.push(...projections(before, next));
        for (const row of audit) {
          if (!entities.includes(row.entity)) throw new Error('Unknown entity');
          this.db
            .prepare(`INSERT OR IGNORE INTO [${row.entity}] (id,at,payload) VALUES (?,?,?)`)
            .run(row.id, row.at, JSON.stringify(row.payload));
        }
        this.db.prepare('UPDATE State SET payload=? WHERE id=1').run(JSON.stringify(next));
        return result;
      })
      .immediate();
  }
  async acquireLease(owner: string, seconds: number): Promise<boolean> {
    return this.db
      .transaction(() => {
        const lease = this.db.prepare('SELECT owner,expires FROM WorkerLease WHERE id=1').get() as
          { owner: string; expires: number } | undefined;
        if (lease && lease.expires > Date.now() && lease.owner !== owner) return false;
        this.db
          .prepare(
            'INSERT INTO WorkerLease VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires',
          )
          .run(owner, Date.now() + seconds * 1000);
        return true;
      })
      .immediate();
  }
  async releaseLease(owner: string): Promise<void> {
    this.db.prepare('DELETE FROM WorkerLease WHERE owner=?').run(owner);
  }
  async records(entity: AuditRecord['entity'], before = '9999'): Promise<AuditRecord[]> {
    if (!entities.includes(entity)) throw new Error('Unknown entity');
    const rows = this.db
      .prepare(`SELECT id,at,payload FROM [${entity}] WHERE at < ? ORDER BY at`)
      .all(before) as { id: string; at: string; payload: string }[];
    return rows.map((r) => ({
      entity,
      id: r.id,
      at: r.at,
      payload: JSON.parse(r.payload) as unknown,
    }));
  }
  async pruneObservations(before: string): Promise<void> {
    this.db.prepare('DELETE FROM MarketDataSnapshot WHERE at < ?').run(before);
  }
  async close(): Promise<void> {
    this.db.close();
  }
}
