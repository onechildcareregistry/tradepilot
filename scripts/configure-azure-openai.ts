import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const account = process.argv[2] ?? 'tradepilotaiccan';
const resourceGroup = process.argv[3] ?? 'rg-tradepilot';
const deployment = process.argv[4] ?? 'tradepilot-gpt-5-6-luna';

function az(...args: string[]): string {
  return execFileSync('az', args, { encoding: 'utf8' }).trim();
}

function setVariable(contents: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const expression = new RegExp(`^${name}=.*$`, 'm');
  return expression.test(contents) ? contents.replace(expression, line) : `${contents}\n${line}`;
}

async function main(): Promise<void> {
  const endpoint = az(
    'cognitiveservices',
    'account',
    'show',
    '--name',
    account,
    '--resource-group',
    resourceGroup,
    '--query',
    'properties.endpoint',
    '--output',
    'tsv',
  );
  const key = az(
    'cognitiveservices',
    'account',
    'keys',
    'list',
    '--name',
    account,
    '--resource-group',
    resourceGroup,
    '--query',
    'key1',
    '--output',
    'tsv',
  );
  let contents = '';
  try {
    contents = await readFile('.env', 'utf8');
  } catch {
    contents = '';
  }
  for (const [name, value] of [
    ['AI_PROVIDER', 'azure-openai'],
    ['AZURE_OPENAI_ENDPOINT', endpoint],
    ['AZURE_OPENAI_API_KEY', key],
    ['AZURE_OPENAI_DEPLOYMENT', deployment],
    ['AI_REASONING_EFFORT', 'low'],
    ['MAX_RESEARCH_OUTPUT_TOKENS', ''],
  ])
    contents = setVariable(contents, name, value);
  await writeFile('.env', `${contents.trim()}\n`, { mode: 0o600 });
  console.log('Azure OpenAI configuration was written to .env without printing the API key.');
}

void main();
