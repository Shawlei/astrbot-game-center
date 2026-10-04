# AstrBot 游戏中心（game-center）

AstrBot 额度小游戏中心：基于真实 NewAPI 额度的对战平台 + 单机小游戏 + 模拟股市，附带一个独立端口的 Web 管理后台。

## 功能

- **联机对战**：斗地主 / 象棋 / 五子棋，支持自由押注、180 秒思考超时、退出重进、超时人机托管。
  - **斗地主**：三人一桌，叫分（1/2/3）、叫地主、加倍 / 超级加倍、炸弹 / 王炸、春天 / 反春，倍数 = 底分 × 加倍 × 2^炸弹数 × 春天翻倍，规则齐全、服务端权威校验。
- **单机小游戏**（门票制，服务端权威结算）：24 点、贪吃蛇、打砖块。
- **模拟股市**：虚拟股票，真实价格模型（涨跌停/动量/均值回归/板块情绪），AI 新闻事件驱动走势，买卖撮合 + 手续费 + T+1。
- **登录制**：对接 NewAPI 站点账号登录，额度与站点真实 quota 联动。
- **管理后台**（`:46111`）：管理员密码登录，运行/API/新闻配置在线修改、状态概览、排行榜/持仓/绑定数据查看、日志查看。

## 快速开始

```bash
git clone <repo-url>
cd astrbot-game-center

cp .env.example .env        # 填写真实配置（含数据库/NewAPI 凭据）
mkdir -p data

docker compose up -d --build
```

启动后：

| 端口 | 用途 |
|------|------|
| `46110` | 游戏大厅、对战、股市页面与 WebSocket |
| `46111` | 管理后台（密码登录） |

- 游戏大厅：`http://<host>:46110/`
- 管理后台：`http://<host>:46111/`（默认密码见 `.env` 的 `ADMIN_PASSWORD`）

## 配置

配置优先级：**`data/config.json`（管理后台保存）> 环境变量（`.env` / compose）> 内置默认值**。

- 首次部署：在 `.env` 里填好真实值（引导配置）。
- 后续运维：登录管理后台 →「运行配置 / API 配置 / 新闻设置」直接改，保存后**重启服务**生效。
- 敏感项（MySQL 密码、NewAPI Key）只存在于 `.env` / `data/config.json`，**不会进入 Git 仓库**。

完整配置项见 `config.example.json`。

## 数据持久化

所有运行数据挂在 `./data` 卷（`/app/data`），包含：

- `portfolio.json` — 股市持仓
- `stats.json` — 对战/单机战绩
- `reversals.json` — 待触发的后续新闻
- `config.json` — 管理后台保存的配置（首次保存后生成）
- `bindings.json` — QQ→NewAPI 账号绑定（来自 AstrBot 插件，只读挂载）

升级/重启容器不会丢失这些数据；代码更新直接 `docker compose up -d --build`，容器外文件不受影响。

## 目录结构

```
.
├── server.js             # 主服务（HTTP API + WebSocket + 管理后台挂载）
├── lib/                  # 业务模块（对战/斗地主引擎/AI/结算/股市/新闻/配置/管理）
├── public/               # 游戏前端（大厅/斗地主/象棋/五子棋/小游戏/股市）
├── admin/                # 管理后台前端
├── Dockerfile
├── docker-compose.yml
└── config.example.json
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `ADMIN_PASSWORD` | 管理后台密码（也写入 config.json） |
| `MYSQL_HOST/PORT/USER/PASS/NAME` | NewAPI 额度库连接 |
| `NEWAPI_BASE/KEY` | NewAPI 站点地址与 Key |
| `AI_MODEL` | AI 新闻生成模型 |
| `QUOTA_PER_UNIT` | 1 美元对应的 quota（默认 500000，须与站点一致） |
| `GAME_PORT` / `ADMIN_PORT` | 游戏 / 管理端口 |

> `bindings.json` 由 AstrBot 插件 `astrbot_plugin_newapi` 生成，需要从宿主机插件数据目录挂载进容器。
