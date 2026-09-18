import { describe, it, expect } from 'vitest';
import sql from 'mssql';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, type Repository } from '../src/persistence/Repository.js';
import { SqliteRepository } from '../src/persistence/SqliteRepository.js';
import { AzureSqlRepository } from '../src/persistence/AzureSqlRepository.js';
import { runDemo, samplePlan } from '../src/demo.js';
import { UsTradingCalendar } from '../src/domain/TradingCalendar.js';
const factories: {
  name: string;
  create: () => Promise<{ repo: Repository; cleanup: () => Promise<void> }>;
}[] = [
  {
    name: 'memory',
    create: async () => ({ repo: new MemoryRepository(), cleanup: async () => undefined }),
  },
  {
    name: 'sqlite',
    create: async () => {
      const path = await mkdtemp(join(tmpdir(), 'tradepilot-'));
      return {
        repo: new SqliteRepository(join(path, 'state.db')),
        cleanup: () => rm(path, { recursive: true, force: true }),
      };
    },
  },
];
if (process.env.SQL_LOCAL_TEST === 'true')
  factories.push({
    name: 'SQL Server (Azure SQL dialect)',
    create: async () => {
      const database = `TradePilot_test_${randomUUID().replaceAll('-', '')}`;
      const config: sql.config = {
        server: '127.0.0.1',
        port: 14339,
        user: 'sa',
        password: 'TradePilot_Local_Test_42!',
        options: { encrypt: true, trustServerCertificate: true },
        connectionTimeout: 30000,
      };
      const admin = await new sql.ConnectionPool({ ...config, database: 'master' }).connect();
      await admin.request().query(`CREATE DATABASE [${database}]`);
      const pool = await new sql.ConnectionPool({ ...config, database }).connect();
      const repo = new AzureSqlRepository(pool);
      await repo.migrate();
      return {
        repo,
        cleanup: async () => {
          await admin
            .request()
            .query(
              `ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]`,
            );
          await admin.close();
        },
      };
    },
  });
for (const f of factories)
  describe(`repository contract: ${f.name}`, () => {
    it('rolls back state and audit records together', async () => {
      const { repo, cleanup } = await f.create();
      try {
        await expect(
          repo.transact((s, a) => {
            s.cash = '0';
            a.push({ entity: 'OperationalEvent', id: 'failed', at: '2026-01-01', payload: {} });
            throw new Error('Crash');
          }),
        ).rejects.toThrow('Crash');
        expect((await repo.read()).cash).toBe('5000');
        expect(await repo.records('OperationalEvent')).toHaveLength(0);
      } finally {
        await repo.close();
        await cleanup();
      }
    });
    it('fences competing workers and refuses an expired/lost owner', async () => {
      const { repo, cleanup } = await f.create();
      try {
        expect(await repo.acquireLease('a', 60)).toBe(true);
        expect(await repo.acquireLease('b', 60)).toBe(false);
        await expect(
          repo.transact((s) => {
            s.cash = '1';
          }, 'b'),
        ).rejects.toThrow('lease');
        await repo.releaseLease('a');
        expect(await repo.acquireLease('b', 60)).toBe(true);
        await expect(repo.transact(() => undefined, 'a')).rejects.toThrow('lease');
      } finally {
        await repo.close();
        await cleanup();
      }
    });
    it('preserves immutable approved plans', async () => {
      const { repo, cleanup } = await f.create();
      try {
        const session = new UsTradingCalendar().session('2026-09-17');
        if (!session) throw new Error('No session');
        await repo.transact((s) => {
          s.plans[session.date] = samplePlan(session);
        });
        await expect(
          repo.transact((s) => {
            const p = s.plans[session.date];
            if (p) p.marketRegime = 'rewritten';
          }),
        ).rejects.toThrow('immutable');
        expect(await repo.records('TradingPlan')).toHaveLength(1);
      } finally {
        await repo.close();
        await cleanup();
      }
    });
    it('supports the full deterministic demo and auditable fills', async () => {
      const { repo, cleanup } = await f.create();
      try {
        const r = await runDemo(repo);
        expect(r.metrics.tradeCount).toBe(1);
        expect(await repo.records('Execution')).toHaveLength(2);
        expect(await repo.records('CashLedger')).toHaveLength(3);
      } finally {
        await repo.close();
        await cleanup();
      }
    });
  });
it('SQLite restores filled orders, cash, and strategy checkpoints after restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'tradepilot-restart-'));
  try {
    let repo = new SqliteRepository(join(path, 'state.db'));
    await runDemo(repo);
    const expected = await repo.read();
    await repo.close();
    repo = new SqliteRepository(join(path, 'state.db'));
    expect(await repo.read()).toEqual(expected);
    await repo.close();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
it.skipIf(!process.env.SQL_TEST_SERVER)(
  'Azure SQL contract (requires an empty dedicated test database and managed identity)',
  async () => {
    const server = process.env.SQL_TEST_SERVER;
    if (!server) return;
    const repo = await AzureSqlRepository.connect(
      server,
      process.env.SQL_TEST_DATABASE ?? 'tradepilot-test',
    );
    try {
      await repo.migrate();
      expect(await repo.acquireLease('contract', 30)).toBe(true);
      await expect(
        repo.transact((s) => {
          s.cash = '0';
          throw new Error('rollback');
        }, 'contract'),
      ).rejects.toThrow('rollback');
      expect((await repo.read()).cash).toBe('5000');
      await repo.releaseLease('contract');
    } finally {
      await repo.close();
    }
  },
);
