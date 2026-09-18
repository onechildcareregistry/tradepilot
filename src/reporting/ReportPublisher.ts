import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Repository } from '../persistence/Repository.js';
import type { PublicReport } from './PublicReport.js';
import { publicReportSchema } from './PublicReport.js';
export interface ReportPublisher {
  publish(report: PublicReport): Promise<void>;
}
export class LocalReportPublisher implements ReportPublisher {
  constructor(private path: string) {}
  async publish(report: PublicReport): Promise<void> {
    const json = JSON.stringify(publicReportSchema.parse(report));
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, json);
    await rename(`${this.path}.tmp`, this.path);
  }
}
export class AzureReportPublisher implements ReportPublisher {
  private blobs: BlobServiceClient;
  constructor(account: string, clientId?: string) {
    this.blobs = new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      new DefaultAzureCredential(clientId ? { managedIdentityClientId: clientId } : {}),
    );
  }
  async publish(report: PublicReport): Promise<void> {
    const data = JSON.stringify(publicReportSchema.parse(report));
    await this.blobs
      .getContainerClient('reports')
      .getBlockBlobClient('report.json')
      .upload(data, Buffer.byteLength(data), {
        blobHTTPHeaders: {
          blobContentType: 'application/json',
          blobCacheControl: 'public, max-age=60',
        },
      });
  }
  async archive(repo: Repository, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString(),
      rows = await repo.records('MarketDataSnapshot', cutoff);
    if (!rows.length) return;
    const data = gzipSync(JSON.stringify(rows)),
      hash = createHash('sha256').update(data).digest('hex');
    await this.blobs
      .getContainerClient('archive')
      .getBlockBlobClient(`observations/${now.toISOString().slice(0, 10)}-${hash}.json.gz`)
      .uploadData(data, { blobHTTPHeaders: { blobContentType: 'application/gzip' } });
    await repo.pruneObservations(cutoff);
  }
}
