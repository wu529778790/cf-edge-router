/**
 * cf-edge-router · Cloudflare Workers 轻量边缘调度器（开源版）
 *
 * 免费替代 Cloudflare Load Balancer 的"逻辑等价"方案：
 * - 按健康状态分流：Docker/主源健康 → 回源；异常 → fallback 到备用 Worker
 * - 支持权重灰度：WEIGHT_DOCKER 控制主源流量比例（0-100）
 * - 健康状态由 Cron Trigger 定时探测写入 KV（无值/冷启动时乐观认为主源健康）
 *
 * 配置全部从环境变量读取（wrangler.toml [vars] 或 Dashboard 配置），
 * 无任何硬编码业务值，开箱即用。
 *
 * 依赖绑定：
 * - KV namespace（binding = ROUTER_STATE）：健康状态缓存
 *
 * 前置（务必阅读 docs/部署指南.md）：
 * - 主源回源必须用"灰云（DNS-only）A 记录子域"：Workers 子请求禁止 fetch 裸 IP
 *   （error 1003），也禁止 fetch 代理（橙云）域名（会绕回 CF 网络被拦）
 * - 主源服务器需为灰云子域配置对应的 server_name 转发（否则 404）
 * - fallback 目标通常是同一应用的另一个 Worker（数据共享 D1/KV 时接管无缝）
 */

const DEFAULT_HEALTH_TTL_SEC = 60;
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_WEIGHT_DOCKER = 100;

export default {
  /** Cron 心跳：探测主源健康并写 KV */
  async scheduled(_event, env) {
    await checkHealth(env);
  },

  /** 流量入口：按健康状态 + 权重分流 */
  async fetch(request, env) {
    const dockerOrigin = env.DOCKER_ORIGIN;
    const dockerHost = env.DOCKER_HOST;
    const fallbackWorker = env.FALLBACK_WORKER;
    if (!dockerOrigin || !dockerHost || !fallbackWorker) {
      return new Response("cf-edge-router: 缺少 DOCKER_ORIGIN/DOCKER_HOST/FALLBACK_WORKER 配置", { status: 500 });
    }

    // 1) 健康状态（无值 → 乐观认为主源健康，由 try/catch 兜底）
    let dockerUp = true;
    try {
      const status = await env.ROUTER_STATE.get("primary_health");
      dockerUp = status !== "down";
    } catch {
      // KV 异常时乐观回源
    }

    // 2) 权重灰度：按比例决定本次请求是否走主源
    const weight = clampWeight(env.WEIGHT_DOCKER);
    const goDocker = dockerUp && Math.random() * 100 < weight;

    // 3) 回源主源（灰云子域直连，规避 Direct IP Access 拦截）
    if (goDocker) {
      try {
        const target = new URL(request.url);
        target.protocol = new URL(dockerOrigin).protocol;
        target.hostname = new URL(dockerOrigin).hostname;
        target.port = new URL(dockerOrigin).port || (target.protocol === "https:" ? "443" : "80");
        const upstream = await fetch(buildUpstreamRequest(request, target.toString(), dockerHost));
        // 4xx 视为主源正常响应；5xx 视为异常（不立刻改 KV，交给 Cron 判定）
        if (upstream.status < 500) return upstream;
        console.log("[cf-edge-router] 主源 5xx", upstream.status);
      } catch (e) {
        console.log("[cf-edge-router] 回源主源失败:", e && e.message ? e.message : String(e));
      }
    }

    // 4) fallback：转发到备用 Worker（显式构造，避免 Host 回环）
    try {
      const target = new URL(request.url);
      target.protocol = "https:";
      target.hostname = new URL(fallbackWorker).hostname;
      target.port = "";
      return await fetch(buildUpstreamRequest(request, target.toString(), new URL(fallbackWorker).hostname));
    } catch (e) {
      console.log("[cf-edge-router] fallback 失败:", e && e.message ? e.message : String(e));
      return new Response("cf-edge-router unavailable", { status: 502 });
    }
  },
};

/** 构造子请求：复制原始 headers 并强制覆写 Host（避免 Host 回环） */
function buildUpstreamRequest(request, targetUrl, host) {
  const headers = new Headers(request.headers);
  headers.set("Host", host);
  headers.set("X-Forwarded-Proto", "https");
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : request.body;
  return new Request(targetUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
}

/** 权重归一化到 0-100 */
function clampWeight(raw) {
  const w = Number(raw ?? DEFAULT_WEIGHT_DOCKER);
  if (Number.isNaN(w)) return DEFAULT_WEIGHT_DOCKER;
  return Math.min(100, Math.max(0, w));
}

/** 探测主源健康，结果写 KV（TTL 可配） */
async function checkHealth(env) {
  const dockerOrigin = env.DOCKER_ORIGIN;
  const dockerHost = env.DOCKER_HOST;
  if (!dockerOrigin || !dockerHost) return;

  const healthPath = env.HEALTH_PATH || "/api/health";
  const ttlSec = Number(env.HEALTH_TTL_SEC) || DEFAULT_HEALTH_TTL_SEC;
  const timeoutMs = Number(env.HEALTH_TIMEOUT_MS) || DEFAULT_HEALTH_TIMEOUT_MS;

  let up = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`${dockerOrigin}${healthPath}`, {
      headers: { Host: dockerHost },
      signal: controller.signal,
    });
    clearTimeout(timer);
    up = resp.ok;
  } catch {
    up = false;
  }

  try {
    await env.ROUTER_STATE.put("primary_health", up ? "up" : "down", {
      expirationTtl: ttlSec,
    });
  } catch {
    // KV 写失败不影响主流程
  }
}
