import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { loadConfig, required } from '../src/config.js';

function az(...args: string[]): string {
  return execFileSync('az', args, { encoding: 'utf8' }).trim();
}
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const identity = JSON.parse(
    az(
      'ad',
      'signed-in-user',
      'show',
      '--query',
      '{id:id,login:userPrincipalName}',
      '--output',
      'json',
    ),
  ) as { id: string; login: string };
  const endpoint = required(config.AZURE_OPENAI_ENDPOINT, 'AZURE_OPENAI_ENDPOINT');
  const deployment = required(config.AZURE_OPENAI_DEPLOYMENT, 'AZURE_OPENAI_DEPLOYMENT');
  const emailFrom = required(config.EMAIL_FROM, 'EMAIL_FROM');
  const emailTo = required(config.EMAIL_TO, 'EMAIL_TO');
  const image = `ghcr.io/onechildcareregistry/tradepilot:${git('rev-parse', 'HEAD')}`;
  const parameters = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0',
    parameters: {
      resourceGroupName: { value: 'rg-tradepilot' },
      location: { value: 'canadacentral' },
      deployApplications: { value: false },
      image: { value: image },
      sqlAdminObjectId: { value: identity.id },
      sqlAdminLogin: { value: identity.login },
      alertEmail: { value: emailTo },
      azureOpenAiEndpoint: { value: endpoint },
      azureOpenAiDeployment: { value: deployment },
      tradingEnabled: { value: false },
      dataVerified: { value: false },
      emailFrom: { value: emailFrom },
      emailTo: { value: emailTo },
      budgetStartDate: { value: '2026-09-01T00:00:00Z' },
    },
  };
  await writeFile('infra/parameters.local.json', `${JSON.stringify(parameters, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log('Wrote ignored Azure deployment parameters without secrets.');
}

void main();
