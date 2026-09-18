import 'dotenv/config';
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
import { AzureSqlRepository } from '../src/persistence/AzureSqlRepository.js';
import { required } from '../src/config.js';
const server = required(process.env.SQL_SERVER, 'SQL_SERVER'),
  database = process.env.SQL_DATABASE ?? 'tradepilot';
const principal = required(process.env.RUNTIME_PRINCIPAL_ID, 'RUNTIME_PRINCIPAL_ID');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal))
  throw new Error('Expected managed identity principal UUID');
const repo = await AzureSqlRepository.connect(server, database);
try {
  await repo.migrate();
} finally {
  await repo.close();
}
const bytes = Buffer.from(principal.replaceAll('-', ''), 'hex');
bytes.subarray(0, 4).reverse();
bytes.subarray(4, 6).reverse();
bytes.subarray(6, 8).reverse();
const token = await new DefaultAzureCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server,
  database,
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
  options: { encrypt: true },
}).connect();
try {
  await pool
    .request()
    .query(
      `IF NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE name='tradepilot-runtime') CREATE USER [tradepilot-runtime] WITH SID=0x${bytes.toString('hex')}, TYPE=E; ALTER ROLE db_datareader ADD MEMBER [tradepilot-runtime]; ALTER ROLE db_datawriter ADD MEMBER [tradepilot-runtime];`,
    );
  console.log('Schema migrated and runtime managed identity granted DML access.');
} finally {
  await pool.close();
}
