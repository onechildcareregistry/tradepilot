import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { planSchema } from '../domain/models.js';
import type { Clock } from '../domain/Clock.js';
import type { TradingBrain, TradingResearchContext, BrainRun } from './TradingBrain.js';
import { validatePlan } from './validation.js';
import { HttpClient } from '../market-data/HttpClient.js';
const PROMPT_VERSION = 'trading-brain-v0.2';
export interface ResponsesApi {
  endpoint: string;
  headers: Record<string, string>;
  background?: boolean;
}
export function azureResponsesApi(endpoint: string, apiKey: string): ResponsesApi {
  const base = endpoint.replace(/\/+$/, '');
  return {
    endpoint: base.endsWith('/openai/v1') ? `${base}/responses` : `${base}/openai/v1/responses`,
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    background: true,
  };
}
const output = z
  .object({
    status: z.string(),
    output: z.array(
      z
        .object({
          type: z.string(),
          content: z
            .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const usage = z
  .object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    total_tokens: z.number().nonnegative().optional(),
    output_tokens_details: z
      .object({ reasoning_tokens: z.number().nonnegative().optional() })
      .optional(),
  })
  .optional();
const responseState = z.object({ id: z.string(), status: z.string() }).passthrough();
function tokenUsage(value: unknown): {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
} {
  if (!value) return { input: null, output: null, reasoning: null, total: null };
  const parsed = z.object({ usage }).passthrough().parse(value).usage;
  return {
    input: parsed?.input_tokens ?? null,
    output: parsed?.output_tokens ?? null,
    reasoning: parsed?.output_tokens_details?.reasoning_tokens ?? null,
    total: parsed?.total_tokens ?? null,
  };
}
function outputText(raw: unknown): string {
  const parsed = output.parse(raw);
  if (parsed.status !== 'completed') throw new Error('Incomplete model output');
  const text = parsed.output
    .flatMap((x) => x.content ?? [])
    .filter((x) => x.type === 'output_text')
    .map((x) => x.text ?? '')
    .join('\n');
  if (!text) throw new Error('Model refusal or empty output');
  return text;
}
function sourceUrls(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>\][)}]+/g)) {
      try {
        result.add(new URL(match[0]).toString());
      } catch {
        /* Ignore malformed text that resembles a URL. */
      }
    }
  } else if (Array.isArray(value)) for (const item of value) sourceUrls(item, result);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (k === 'url' && typeof v === 'string') result.add(v);
      else sourceUrls(v, result);
    }
  return result;
}
function citationIdentity(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  parsed.hash = '';
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}
/** Azure structured output accepts the JSON Schema shape but not Zod's `uri` format annotation. */
function withoutSchemaFormats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSchemaFormats);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'format')
      .map(([key, child]) => [key, withoutSchemaFormats(child)]),
  );
}
export class OpenAiTradingBrain implements TradingBrain {
  constructor(
    key: string,
    private model: string,
    private clock: Clock,
    private http: HttpClient,
    private maxTokens?: number,
    private timeout = 600000,
    private api: ResponsesApi = {
      endpoint: 'https://api.openai.com/v1/responses',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    },
    private reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'low',
  ) {}
  async generateTradingPlan(context: TradingResearchContext): Promise<BrainRun> {
    const startedAt = this.clock.now().toISOString(),
      prompt = await readFile(new URL(`./prompts/${PROMPT_VERSION}.md`, import.meta.url), 'utf8');
    const run: BrainRun = {
      id: randomUUID(),
      model: this.model,
      promptVersion: PROMPT_VERSION,
      promptHash: createHash('sha256').update(prompt).digest('hex'),
      startedAt,
      generatedAt: startedAt,
      cutoffAt: context.session.cutoffAt,
      originalResearch: null,
      originalOutput: null,
      validationStatus: 'invalid',
      validationErrors: [],
      plan: null,
    };
    const request = async (body: Record<string, unknown>): Promise<unknown> => {
      const created = await this.http.json(
        this.api.endpoint,
        {
          method: 'POST',
          headers: this.api.headers,
          body: JSON.stringify(
            this.api.background ? { ...body, background: true, store: true } : body,
          ),
        },
        Math.min(
          this.timeout,
          Math.max(1000, Date.parse(context.session.open) - this.clock.now().getTime()),
        ),
      );
      if (!this.api.background) return created;
      let current = responseState.parse(created);
      const deadline = Date.now() + this.timeout;
      while (current.status === 'queued' || current.status === 'in_progress') {
        if (Date.now() >= deadline) throw new Error('Azure background response timed out');
        await this.clock.sleep(2000);
        current = responseState.parse(
          await this.http.json(
            `${this.api.endpoint}/${encodeURIComponent(current.id)}`,
            { headers: this.api.headers },
            20000,
          ),
        );
      }
      return current;
    };
    try {
      if (startedAt < context.session.cutoffAt || startedAt >= context.session.open)
        throw new Error('Research outside premarket window');
      run.originalResearch = await request({
        model: this.model,
        instructions: prompt,
        input: `Research date ${context.session.date}. Information cutoff ${context.session.cutoffAt}. Current retrieval time ${startedAt}. Aim for exactly 3 qualified primary recommendations plus 12 distinct cited others considered (15 unique stocks). Expand screening before returning fewer. Explain any shortfall and preserve all supported names in the structured plan. Do not invent unsupported candidates to meet the target.`,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        include: ['web_search_call.action.sources'],
        reasoning: { effort: this.reasoningEffort },
        ...(this.maxTokens === undefined ? {} : { max_output_tokens: this.maxTokens }),
        store: false,
      });
      const research = outputText(run.originalResearch),
        urls = sourceUrls(run.originalResearch),
        citationIds = new Set([...urls].map(citationIdentity));
      if (urls.size === 0) throw new Error('Research did not return verifiable citation URLs');
      const schema = zodToJsonSchema(planSchema, { $refStrategy: 'none' });
      const { $schema: _schema, ...jsonSchema } = schema;
      void _schema;
      run.originalOutput = await request({
        model: this.model,
        instructions: prompt,
        input: `Structure only the following research. Do not add evidence. Context: ${JSON.stringify(context)}. Model: ${this.model}. generatedAt: ${this.clock.now().toISOString()}. expiresAt: ${context.session.entryDeadline}. Allowed citation URLs: ${JSON.stringify([...urls])}. Evidence follows:\n${research}`,
        text: {
          format: {
            type: 'json_schema',
            name: 'trading_plan',
            strict: true,
            schema: withoutSchemaFormats(jsonSchema),
          },
        },
        reasoning: { effort: this.reasoningEffort },
        ...(this.maxTokens === undefined ? {} : { max_output_tokens: this.maxTokens }),
        store: false,
      });
      run.generatedAt = this.clock.now().toISOString();
      const modelPlan = JSON.parse(outputText(run.originalOutput)) as unknown;
      if (!modelPlan || typeof modelPlan !== 'object' || Array.isArray(modelPlan))
        throw new Error('Structured model output must be an object');
      // These identity fields are application metadata. The model may repeat them in its
      // response for schema compliance, but it cannot choose what is recorded or reported.
      const parsed = planSchema.parse({
        ...modelPlan,
        model: this.model,
        promptVersion: PROMPT_VERSION,
      });
      for (const c of [...parsed.candidates, ...(parsed.watchlist ?? [])])
        for (const source of c.sources) {
          if (!citationIds.has(citationIdentity(source.url)))
            throw new Error('Plan cites a URL not retrieved during research');
          source.retrievedAt = run.generatedAt;
          source.cutoffVerified = false;
          if (
            !c.uncertainties.includes(
              'Source page contents at cutoff are not independently verified',
            )
          )
            c.uncertainties.push('Source page contents at cutoff are not independently verified');
        }
      parsed.model = this.model;
      parsed.promptVersion = PROMPT_VERSION;
      parsed.generatedAt = run.generatedAt;
      parsed.cutoffAt = context.session.cutoffAt;
      run.plan = validatePlan(parsed, context.session, run.generatedAt);
      run.validationStatus = 'valid';
    } catch (error) {
      run.validationErrors = [error instanceof Error ? error.message : 'Brain generation failed'];
      run.generatedAt = this.clock.now().toISOString();
    }
    const researchUsage = tokenUsage(run.originalResearch);
    const outputUsage = tokenUsage(run.originalOutput);
    const sum = (first: number | null, second: number | null): number | null =>
      first === null || second === null ? null : first + second;
    run.usage = {
      requests: Number(run.originalResearch !== null) + Number(run.originalOutput !== null),
      inputTokens: sum(researchUsage.input, outputUsage.input),
      outputTokens: sum(researchUsage.output, outputUsage.output),
      reasoningTokens: sum(researchUsage.reasoning, outputUsage.reasoning),
      totalTokens: sum(researchUsage.total, outputUsage.total),
    };
    return run;
  }
}
