/**
 * Usage statistics service.
 */

import { Env } from '../index';
import * as db from '../db/queries';

export interface StatsOverview {
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  byProvider: {
    providerName: string;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
  }[];
}

export async function getStats(env: Env, userId: string, days: number = 30): Promise<StatsOverview> {
  const [summary, byProvider] = await Promise.all([
    db.getUsageSummary(env.DB, userId, days),
    db.getUsageByProvider(env.DB, userId, days),
  ]);

  return {
    totalInputTokens: summary.total_input_tokens,
    totalOutputTokens: summary.total_output_tokens,
    requestCount: summary.request_count,
    byProvider: byProvider.map(p => ({
      providerName: p.provider_name,
      inputTokens: p.total_input_tokens,
      outputTokens: p.total_output_tokens,
      requestCount: p.request_count,
    })),
  };
}

export async function recordUsage(
  env: Env, userId: string,
  providerId: string | null, providerName: string | null,
  inputTokens: number, outputTokens: number
): Promise<void> {
  await db.insertUsageLog(env.DB, userId, providerId, providerName, inputTokens, outputTokens);
}
