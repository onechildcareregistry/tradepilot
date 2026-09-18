import { cp } from 'node:fs/promises';
await cp('src/brain/prompts', 'dist/brain/prompts', { recursive: true });
await cp('src/brain/schemas', 'dist/brain/schemas', { recursive: true });
