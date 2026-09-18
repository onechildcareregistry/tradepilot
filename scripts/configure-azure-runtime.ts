import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { loadConfig, required } from '../src/config.js';

const vault = process.argv[2];
if (!vault) throw new Error('Usage: configure-azure-runtime <key-vault-name>');
const config = loadConfig();

function setSecret(name: string, value: string): void {
  try {
    execFileSync(
      'az',
      [
        'keyvault',
        'secret',
        'set',
        '--vault-name',
        vault,
        '--name',
        name,
        '--value',
        value,
        '--output',
        'none',
      ],
      { stdio: 'ignore' },
    );
  } catch {
    throw new Error(`Unable to store ${name} in Key Vault`);
  }
}

setSecret('azure-openai-api-key', required(config.AZURE_OPENAI_API_KEY, 'AZURE_OPENAI_API_KEY'));
setSecret('finnhub-api-key', required(config.FINNHUB_API_KEY, 'FINNHUB_API_KEY'));
setSecret('resend-api-key', required(config.RESEND_API_KEY, 'RESEND_API_KEY'));
console.log('Stored runtime secrets in Key Vault without printing their values.');
