import { Injectable } from '@nestjs/common';

interface CacheEntry {
  workflowExecutionId: string;
  variableName: string;
  value: unknown;
}

@Injectable()
export class WorkflowCacheService {
  private readonly tables = new Set<string>();
  private readonly cache = new Map<string, Map<string, unknown>>();

  async createExecutionTable(workflowExecutionId: string): Promise<{ message: string; tableName: string }> {
    if (!workflowExecutionId || typeof workflowExecutionId !== 'string') {
      throw new Error('Invalid workflowExecutionId');
    }
    this.tables.add(workflowExecutionId);
    this.cache.set(workflowExecutionId, new Map());
    return { message: 'Table created', tableName: `exec_${workflowExecutionId}` };
  }

  async addOutputAsCache(
    workflowExecutionId: string,
    variableName: string,
    value: unknown,
  ): Promise<void> {
    let map = this.cache.get(workflowExecutionId);
    if (!map) {
      map = new Map();
      this.cache.set(workflowExecutionId, map);
    }
    map.set(variableName, value);
  }

  async getCacheEntries(workflowExecutionId: string): Promise<{ variableName: string; value: unknown }[]> {
    const map = this.cache.get(workflowExecutionId);
    if (!map) return [];
    return Array.from(map.entries()).map(([variableName, value]) => ({ variableName, value }));
  }

  getVariables(workflowExecutionId: string): Record<string, unknown> {
    const map = this.cache.get(workflowExecutionId);
    if (!map) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of map) {
      if (!k.startsWith('_fanout_')) out[k] = v;
    }
    return out;
  }

  setFanoutTotal(workflowExecutionId: string, nodeExecutionId: string, total: number): void {
    this.addOutputAsCache(workflowExecutionId, `_fanout_${nodeExecutionId}_total`, total);
    this.addOutputAsCache(workflowExecutionId, `_fanout_${nodeExecutionId}_completed`, 0);
  }

  incrementFanoutCompleted(workflowExecutionId: string, nodeExecutionId: string): number {
    let map = this.cache.get(workflowExecutionId);
    if (!map) {
      map = new Map();
      this.cache.set(workflowExecutionId, map);
    }
    const key = `_fanout_${nodeExecutionId}_completed`;
    const prev = (map.get(key) as number) ?? 0;
    const next = prev + 1;
    map.set(key, next);
    return next;
  }

  getFanoutTotal(workflowExecutionId: string, nodeExecutionId: string): number | undefined {
    const map = this.cache.get(workflowExecutionId);
    const v = map?.get(`_fanout_${nodeExecutionId}_total`);
    return typeof v === 'number' ? v : undefined;
  }

  /** Store one fanout iteration's returnvalue so we can build loop[] when all complete. */
  async addFanoutIterationResult(
    workflowExecutionId: string,
    nodeExecutionId: string,
    fanoutIndex: number,
    returnvalue: Record<string, unknown>,
  ): Promise<void> {
    let map = this.cache.get(workflowExecutionId);
    if (!map) {
      map = new Map();
      this.cache.set(workflowExecutionId, map);
    }
    const key = `_fanout_${nodeExecutionId}_results`;
    const arr = (map.get(key) as unknown[]) ?? [];
    while (arr.length <= fanoutIndex) arr.push(null);
    arr[fanoutIndex] = returnvalue;
    map.set(key, arr);
  }

  /** Get per-iteration results for a fanout child (used when building loop). */
  getFanoutResults(workflowExecutionId: string, nodeExecutionId: string): unknown[] {
    const map = this.cache.get(workflowExecutionId);
    const arr = map?.get(`_fanout_${nodeExecutionId}_results`);
    return Array.isArray(arr) ? arr : [];
  }

  /** Store batch structure when fanout starts (one result per batch). */
  async setFanoutBatches(
    workflowExecutionId: string,
    nodeExecutionId: string,
    batches: unknown[][],
  ): Promise<void> {
    await this.addOutputAsCache(
      workflowExecutionId,
      `_fanout_${nodeExecutionId}_batches`,
      batches,
    );
  }

  getFanoutBatches(
    workflowExecutionId: string,
    nodeExecutionId: string,
  ): unknown[][] | undefined {
    const map = this.cache.get(workflowExecutionId);
    const v = map?.get(`_fanout_${nodeExecutionId}_batches`);
    return Array.isArray(v) ? (v as unknown[][]) : undefined;
  }
}
