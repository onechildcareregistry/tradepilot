import { z } from 'zod';
const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const positive = (v: number) => z.coerce.number().positive().default(v);
export const configSchema = z.object({
  TRADEPILOT_MODE: z.literal('Monopoly').default('Monopoly'),
  TRADING_ENABLED: bool,
  DATA_VERIFIED: bool,
  DATABASE: z.enum(['sqlite', 'azure-sql']).default('sqlite'),
  SQLITE_PATH: z.string().default('data/tradepilot.db'),
  SQL_SERVER: z.string().optional(),
  SQL_DATABASE: z.string().default('tradepilot'),
  AZURE_CLIENT_ID: z.string().optional(),
  AI_PROVIDER: z.enum(['openai', 'azure-openai']).default('azure-openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  AI_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  FINNHUB_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_TO: z.string().optional(),
  STORAGE_ACCOUNT: z.string().optional(),
  REPORT_PATH: z.string().default('dashboard/public/report.json'),
  POLL_ENTRY_SECONDS: positive(5),
  POLL_POSITION_SECONDS: positive(10),
  POLL_IDLE_SECONDS: positive(60),
  REQUESTS_PER_MINUTE: positive(55),
  MIN_ENTRY_QUALITY: z.coerce.number().min(0).max(100).default(60),
  RISK_PER_TRADE: z.coerce.number().positive().max(0.1).default(0.005),
  MAX_ALLOCATION: z.coerce.number().positive().max(1).default(0.2),
  MAX_EXPOSURE: z.coerce.number().positive().max(1).default(0.6),
  MAX_POSITIONS: z.coerce.number().int().min(1).max(3).default(3),
  MAX_ENTRIES_PER_SYMBOL: z.coerce.number().int().positive().default(1),
  MAX_DAILY_LOSS: z.coerce.number().positive().max(1).default(0.02),
  MAX_DRAWDOWN: z.coerce.number().positive().max(1).default(0.1),
  MAX_CHASE: positive(0.005),
  PRICE_MODEL: z.literal('last-price-v1').default('last-price-v1'),
  MAX_STOP_DISTANCE: positive(0.05),
  STALE_SECONDS: positive(15),
  SLIPPAGE_BPS: z.coerce.number().nonnegative().default(5),
  FEE_PER_ORDER: z.coerce.number().nonnegative().default(0),
  TARGET_R: positive(2),
  TIME_EXIT_MINUTES: positive(30),
  ENTRY_TTL_SECONDS: positive(30),
  RESEARCH_HOUR: z.coerce.number().int().min(0).max(23).default(6),
  RESEARCH_MINUTE: z.coerce.number().int().min(0).max(59).default(15),
  RESEARCH_TIMEOUT_SECONDS: positive(600),
  MAX_RESEARCH_OUTPUT_TOKENS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().positive().optional(),
  ),
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
export function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
export function publicConfig(c: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(c).filter(([k]) => !/(KEY|SECRET|CLIENT|SERVER|EMAIL|PATH|ACCOUNT)/.test(k)),
  );
}
