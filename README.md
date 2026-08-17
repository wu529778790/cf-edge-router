# cf-edge-router

> 在 Cloudflare Workers 上运行的开源轻量边缘调度器 —— 免费替代 Load Balancer 的"逻辑等价"方案。

**单 Worker 实现主源/备用双活**：健康检查 + 自动容灾 + 权重灰度，全部跑在 Cloudflare 边缘，零服务器成本。

## 特性

- ⚡ **免费**：运行在 Workers 免费额度内（KV + Cron + 请求均免费）
- 🔀 **自动容灾**：Cron 每 1 分钟探测主源健康，异常自动切换到备用 Worker，恢复自动切回
- 📊 **权重灰度**：`WEIGHT_DOCKER` 控制主源流量比例（0-100），秒级调整灰度
- 🪶 **轻量**：核心逻辑约 100 行，无依赖、无构建
- 🔧 **配置化**：全部参数走环境变量，开箱即用、无硬编码
- 📦 **通用**：适用于任意"主源服务器 + 备用 Worker"的应用，多个站点可各配一条路由

## 为什么需要它

Cloudflare 官方 **Load Balancer 是付费功能（Pro 起）**。它之所以没有成熟的开源替代，是因为其核心价值在**全球 300+ POP 分布式健康探测**与 **DNS 层秒级切换** —— 这些是网络基础设施能力，代码层无法复制。

但绝大多数场景（服务器偶发故障、容量兜底、灰度发布）**不需要秒级切换**，1 分钟探测周期完全够用。本项目用 Workers 复刻了 LB 的**逻辑**（健康检查 + 分流 + 容灾 + 灰度），免费且轻量：

| | 官方 Load Balancer | cf-edge-router |
|---|---|---|
| 健康探测 | 全球 300+ POP | 单点 Cron（1 分钟） |
| 故障切换 | 秒级（DNS 层） | ~1 分钟 |
| 请求开销 | 零（DNS 决策） | 多一跳边缘转发 |
| 费用 | Pro 起（$20/月） | **免费** |

## 工作原理

```
用户请求
   ↓
Cloudflare 边缘 · cf-edge-router（调度员）
   ├─ 主源健康 & 命中权重 → 回源主源（灰云子域 → 你的服务器）
   └─ 主源异常 / 灰度分流 → 转发到备用 Worker（数据共享 D1/KV 时接管无缝）
```

健康状态由 **Cron Trigger** 探测主源 `/api/health` 写入 **KV**；请求时读 KV 决策，无状态时乐观回源（失败有兜底）。

## 快速开始

```bash
# 1. 创建 KV namespace，把返回的 id 填入 wrangler.toml
npx wrangler kv namespace create ROUTER_STATE

# 2. 按你的场景修改 wrangler.toml 的 [vars]
#    DOCKER_ORIGIN（灰云子域）/ DOCKER_HOST / FALLBACK_WORKER / WEIGHT_DOCKER ...

# 3. 部署
npx wrangler deploy
```

> ⚠️ **三个关键前置**（详见 [docs/部署指南.md](docs/部署指南.md)）：
> 1. **主源回源必须用灰云（DNS-only）A 记录子域** —— Workers 子请求禁止 fetch 裸 IP（error 1003）与橙云域名；
> 2. **主源服务器需为灰云子域配置 server_name 转发**（否则 OpenResty/Nginx 返回 404）；
> 3. **路由绑定**（`routes`）是接管线上流量的最后一步，先部署验证再启用。

## 配置说明

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `DOCKER_ORIGIN` | ✅ | - | 主源回源目标（灰云子域，如 `http://origin.example.com`） |
| `DOCKER_HOST` | ✅ | - | 回源 Host 头（主源按它分发站点） |
| `FALLBACK_WORKER` | ✅ | - | 备用 Worker（如 `https://app.example.workers.dev`） |
| `HEALTH_PATH` | - | `/api/health` | 主源健康检查路径（2xx 视为健康） |
| `WEIGHT_DOCKER` | - | `100` | 主源流量权重 %（0-100；100=纯容灾） |
| `HEALTH_TTL_SEC` | - | `120` | 健康状态缓存 TTL（秒，须 > Cron 间隔 60s） |
| `HEALTH_TIMEOUT_MS` | - | `5000` | 健康探测超时（毫秒） |

## Roadmap

- [ ] v1：单 Worker 双活 + 容灾（当前）
- [ ] v2：配置化路由表（存 D1/KV，多站点一条规则，改配置即生效）
- [ ] v2：多主源池（多 origin 加权/故障剔除）
- [ ] v3：后台管理 API + 可视化界面（健康状态 / 灰度权重实时调整）

## License

[MIT](LICENSE)
