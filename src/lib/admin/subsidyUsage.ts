import { pool } from "@/lib/db";

type TotalsRow = {
  total_requests: string;
  requests_24h: string;
  requests_1h: string;
  rate_limited_1h: string;
  unique_deployments_24h: string;
};

type TopDeploymentRow = {
  deployment_id: string;
  request_count: string;
};

type TopUserRow = {
  user_id: string | null;
  request_count: string;
  requests_1h: string;
  rate_limited_1h: string;
};

export type SubsidyUsageOverview = {
  totalRequests: number;
  requests24h: number;
  requests1h: number;
  rateLimited1h: number;
  uniqueDeployments24h: number;
  topDeployments24h: Array<{ deploymentId: string; requestCount: number }>;
  topUsers24h: Array<{
    userId: string;
    requestCount: number;
    requests1h: number;
    rateLimited1h: number;
  }>;
};

export async function fetchSubsidyUsageOverview(): Promise<SubsidyUsageOverview> {
  const totals = await pool.query<TotalsRow>(
    `SELECT
       COUNT(*)::text AS total_requests,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::text AS requests_24h,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour')::text AS requests_1h,
       COUNT(*) FILTER (
         WHERE created_at >= NOW() - INTERVAL '1 hour'
           AND http_status = 429
       )::text AS rate_limited_1h,
       COUNT(DISTINCT deployment_id) FILTER (
         WHERE created_at >= NOW() - INTERVAL '24 hours'
       )::text AS unique_deployments_24h
     FROM subsidy_usage_events`,
  );

  const topDeployments = await pool.query<TopDeploymentRow>(
    `SELECT deployment_id, COUNT(*)::text AS request_count
     FROM subsidy_usage_events
     WHERE created_at >= NOW() - INTERVAL '24 hours'
     GROUP BY deployment_id
     ORDER BY COUNT(*) DESC
     LIMIT 5`,
  );

  const topUsers = await pool.query<TopUserRow>(
    `SELECT
       user_id,
       COUNT(*)::text AS request_count,
       COUNT(*) FILTER (
         WHERE created_at >= NOW() - INTERVAL '1 hour'
       )::text AS requests_1h,
       COUNT(*) FILTER (
         WHERE created_at >= NOW() - INTERVAL '1 hour'
           AND http_status = 429
       )::text AS rate_limited_1h
     FROM subsidy_usage_events
     WHERE created_at >= NOW() - INTERVAL '24 hours'
     GROUP BY user_id
     ORDER BY COUNT(*) DESC
     LIMIT 20`,
  );

  const row = totals.rows[0];
  return {
    totalRequests: Number(row?.total_requests ?? "0"),
    requests24h: Number(row?.requests_24h ?? "0"),
    requests1h: Number(row?.requests_1h ?? "0"),
    rateLimited1h: Number(row?.rate_limited_1h ?? "0"),
    uniqueDeployments24h: Number(row?.unique_deployments_24h ?? "0"),
    topDeployments24h: topDeployments.rows.map((item) => ({
      deploymentId: item.deployment_id,
      requestCount: Number(item.request_count),
    })),
    topUsers24h: topUsers.rows.map((item) => ({
      userId: item.user_id?.trim() || "unknown",
      requestCount: Number(item.request_count),
      requests1h: Number(item.requests_1h),
      rateLimited1h: Number(item.rate_limited_1h),
    })),
  };
}
