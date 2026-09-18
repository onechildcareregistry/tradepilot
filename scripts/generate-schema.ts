import { writeFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { planSchema } from '../src/domain/models.js';
await writeFile(
  new URL('../src/brain/schemas/TradingPlan.schema.json', import.meta.url),
  JSON.stringify(zodToJsonSchema(planSchema, { $refStrategy: 'none' }), null, 2) + '\n',
);
