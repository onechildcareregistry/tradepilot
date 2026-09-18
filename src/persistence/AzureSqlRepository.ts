import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
import { entities, initialState, type AuditRecord, type State } from '../domain/models.js';
import { decodeState, projections, type Mutation, type Repository } from './Repository.js';
export class AzureSqlRepository implements Repository {
  constructor(private pool: sql.ConnectionPool) {}
  static async connect(
    server: string,
    database: string,
    clientId?: string,
  ): Promise<AzureSqlRepository> {
    const credential = new DefaultAzureCredential(
      clientId ? { managedIdentityClientId: clientId } : {},
    );
    const pool = new sql.ConnectionPool({
      server,
      database,
      options: { encrypt: true, trustServerCertificate: false },
      authentication: { type: 'azure-active-directory-default', options: { clientId } },
      pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 30000,
    }); // Driver refreshes managed-identity tokens rather than pinning an expiring token.
    await credential.getToken('https://database.windows.net/.default');
    await pool.connect();
    return new AzureSqlRepository(pool);
  }
  async migrate(): Promise<void> {
    await this.pool
      .request()
      .query(
        "IF OBJECT_ID('dbo.State') IS NULL CREATE TABLE dbo.State (id int PRIMARY KEY CHECK(id=1),payload nvarchar(max) NOT NULL); IF OBJECT_ID('dbo.WorkerLease') IS NULL CREATE TABLE dbo.WorkerLease (id int PRIMARY KEY CHECK(id=1),owner nvarchar(100) NOT NULL,expires datetime2 NOT NULL)",
      );
    for (const e of entities)
      await this.pool
        .request()
        .query(
          `IF OBJECT_ID('dbo.${e}') IS NULL BEGIN CREATE TABLE dbo.[${e}] (id nvarchar(450) PRIMARY KEY,at varchar(40) NOT NULL,payload nvarchar(max) NOT NULL); CREATE INDEX ix_${e}_at ON dbo.[${e}](at); END`,
        );
    await this.pool
      .request()
      .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(initialState()))
      .query(
        'IF NOT EXISTS (SELECT 1 FROM dbo.State WHERE id=1) INSERT INTO dbo.State VALUES (1,@payload)',
      );
    const seed = initialState().ledger[0];
    if (seed)
      await this.pool
        .request()
        .input('at', seed.at)
        .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(seed))
        .query(
          "IF NOT EXISTS(SELECT 1 FROM dbo.CashLedger WHERE id='initial:event') INSERT INTO dbo.CashLedger VALUES('initial:event',@at,@payload)",
        );
  }
  async read(): Promise<State> {
    const r = await this.pool
      .request()
      .query<{ payload: string }>('SELECT payload FROM dbo.State WHERE id=1');
    const row = r.recordset[0];
    if (!row) throw new Error('Run migrate before starting worker');
    return decodeState(row.payload);
  }
  async transact<T>(mutation: Mutation<T>, owner?: string): Promise<T> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const r = await new sql.Request(tx).query<{ payload: string }>(
        'SELECT payload FROM dbo.State WITH(UPDLOCK,HOLDLOCK) WHERE id=1',
      );
      const row = r.recordset[0];
      if (!row) throw new Error('Missing state');
      if (owner) {
        const lease = await new sql.Request(tx)
          .input('owner', owner)
          .query(
            'SELECT id FROM dbo.WorkerLease WITH(UPDLOCK,HOLDLOCK) WHERE id=1 AND owner=@owner AND expires>SYSUTCDATETIME()',
          );
        if (lease.recordset.length !== 1) throw new Error('Worker lease lost');
      }
      const before = decodeState(row.payload),
        next = structuredClone(before),
        audit: AuditRecord[] = [];
      const result = mutation(next, audit);
      audit.push(...projections(before, next));
      for (const a of audit) {
        if (!entities.includes(a.entity)) throw new Error('Unknown entity');
        await new sql.Request(tx)
          .input('id', sql.NVarChar(450), a.id)
          .input('at', a.at)
          .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(a.payload))
          .query(
            `IF NOT EXISTS (SELECT 1 FROM dbo.[${a.entity}] WHERE id=@id) INSERT INTO dbo.[${a.entity}] VALUES (@id,@at,@payload)`,
          );
      }
      await new sql.Request(tx)
        .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(next))
        .query('UPDATE dbo.State SET payload=@payload WHERE id=1');
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    }
  }
  async acquireLease(owner: string, seconds: number): Promise<boolean> {
    const r = await this.pool
      .request()
      .input('owner', owner)
      .input('seconds', sql.Int, seconds)
      .query<{ acquired: number }>(
        `SET XACT_ABORT ON; BEGIN TRAN; IF EXISTS(SELECT 1 FROM dbo.WorkerLease WITH(UPDLOCK,HOLDLOCK) WHERE id=1 AND expires>SYSUTCDATETIME() AND owner<>@owner) BEGIN SELECT 0 AS acquired; END ELSE BEGIN DELETE FROM dbo.WorkerLease WHERE id=1; INSERT INTO dbo.WorkerLease VALUES(1,@owner,DATEADD(second,@seconds,SYSUTCDATETIME())); SELECT 1 AS acquired; END COMMIT;`,
      );
    return r.recordset[0]?.acquired === 1;
  }
  async releaseLease(owner: string): Promise<void> {
    await this.pool
      .request()
      .input('owner', owner)
      .query('DELETE FROM dbo.WorkerLease WHERE owner=@owner');
  }
  async records(entity: AuditRecord['entity'], before = '9999'): Promise<AuditRecord[]> {
    if (!entities.includes(entity)) throw new Error('Unknown entity');
    const r = await this.pool
      .request()
      .input('before', before)
      .query<{ id: string; at: string; payload: string }>(
        `SELECT id,at,payload FROM dbo.[${entity}] WHERE at<@before ORDER BY at`,
      );
    return r.recordset.map((row) => ({
      entity,
      id: row.id,
      at: row.at,
      payload: JSON.parse(row.payload) as unknown,
    }));
  }
  async pruneObservations(before: string): Promise<void> {
    await this.pool
      .request()
      .input('before', before)
      .query('DELETE FROM dbo.MarketDataSnapshot WHERE at<@before');
  }
  async close(): Promise<void> {
    await this.pool.close();
  }
}
