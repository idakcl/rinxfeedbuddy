import { drizzle } from "drizzle-orm/d1";
import { CacheImpl } from "../utils/cache";

export async function handleScheduled(
  _controller: ScheduledController | null,
  env: Env,
  ctx: ExecutionContext,
) {
  const schema = await import("../db/schema");
  const db = drizzle(env.DB, { schema });

  const serverConfig = new CacheImpl(db, env, "server.config", "database");
  const clientConfig = new CacheImpl(db, env, "client.config");
  const cache = new CacheImpl(db, env, "cache", undefined, clientConfig);

  const { friendCrontab } = await import("../services/friends");
  const { rssCrontab } = await import("../services/rss");
  const { publishScheduledFeeds } = await import("../services/feed");

  // 定时发布检查每次调度都跑（保证 ≤1 分钟延迟，且幂等）。
  await publishScheduledFeeds(db, cache, serverConfig, env);

  // friend/RSS 同步仅在非「每分钟」cron 时执行，避免每分钟都打外部服务。
  if (_controller?.cron !== "* * * * *") {
    await friendCrontab(env, ctx, db, cache, serverConfig, clientConfig);
    await rssCrontab(env, db);
  }
}
