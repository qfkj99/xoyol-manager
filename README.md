# 小师妹账号管理平台

一个用于批量管理游戏账号及其绑定 Microsoft Outlook 邮箱的全栈 Web 应用。支持游戏资料导入、明文查看、用户认领和邮箱验证码获取，通过 OAuth2 双协议（Graph API + IMAP）收取邮件，并保留标签、代理、权限隔离与数据备份功能。

## 界面预览

以下为旧版邮箱管理界面参考，当前版本已升级为游戏账号管理。

| 仪表盘 | 邮箱管理 |
|:---:|:---:|
| ![仪表盘页面](docs/screenshots/仪表盘页面.png) | ![邮箱管理页面](docs/screenshots/邮箱管理页面.png) |

| 邮件查看 | 移动端 |
|:---:|:---:|
| ![邮件查看弹窗](docs/screenshots/邮件查看弹窗.png) | ![移动端效果](docs/screenshots/移动端效果.png) |

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Koa 3 + TypeScript + SQLite (better-sqlite3) |
| 前端 | React 19 + Tailwind CSS 3 + Zustand 5 + Framer Motion 11 |
| UI 组件 | Radix UI 原语 + 自定义 Glassmorphism 组件 |
| 邮件协议 | Microsoft Graph API / IMAP (XOAUTH2) |
| 代理 | SOCKS5 (socks-proxy-agent) / HTTP (undici ProxyAgent) |

## 功能概览

- **仪表盘** — 账户统计、最近邮件、快捷操作
- **游戏账号管理** — 管理员八字段批量导入/导出，可同时生成短链并导出五字段交付文本；默认明文展示游戏账号、游戏密码、name、身份证后六位、绑定邮箱，支持搜索、分页与标签
- **账号认领** — 用户导入管理员交付的五字段短链文本或八字段完整资料即可认领后台库存，也可使用一次性认领码；认领后接收账号及邮箱收信权限
- **账号短链** — 每个账号独立分享链接，无需登录即可查看完整八字段资料并获取该邮箱验证码，支持有效期、重置和关闭
- **短链访问检测** — 仅管理员账号列表展示当前短链是否已访问及最近访问时间，普通用户端和公开页面不显示
- **外部 API** — 管理员生成带权限和有效期的 API Key，支持八字段导入并自动返回短链、账号查询、短链管理及邮箱验证码获取；[完整调用文档](docs/external-api.md)
- **获取验证码** — 同时读取绑定邮箱的收件箱和垃圾箱，合并验证码候选，支持复制并显示邮件时间、文件夹及缓存来源
- **标签系统** — 创建/编辑/删除标签，为账户分配标签，右键快速切换
- **邮件查看** — 三栏布局（账户列表 → 邮件列表 → 邮件正文），支持收件箱/垃圾邮件切换
- **代理设置** — SOCKS5/HTTP 代理管理、连通性测试、默认代理设置
- **双协议收信** — Graph API 优先，IMAP 自动降级，本地缓存兜底
- **登录与注册** — 登录首页、自助注册、个人工作台、个人资料与密码设置
- **用户管理** — 管理员/普通用户角色、停用与注销、密码重置、强制退出、操作审计
- **数据隔离** — 普通用户管理被分配或已认领的游戏账号、绑定邮箱、标签和代理，不能新增账号或通过导入覆盖资料；管理员管理全部并可转移账号归属
- **数据备份** — 管理员二次验证后备份/恢复 SQLite 数据库，恢复后撤销全部会话
- **导入去重** — 两步导入流程（预览 → 确认）；管理员支持跳过/覆盖重复项，用户重复认领自己的账号时跳过
- **深色/浅色主题** — 跟随系统或手动切换
- **响应式布局** — 移动端适配，侧边栏抽屉模式

## 项目结构

```
outlook-mail-manager/
├── server/                  # 后端服务
│   └── src/
│       ├── config/          # 环境配置
│       ├── controllers/     # 请求处理器
│       ├── database/        # SQLite 连接 & 迁移
│       ├── middlewares/      # 日志 & 错误处理
│       ├── models/          # 数据访问层
│       ├── routes/          # API 路由
│       ├── services/        # 业务逻辑（OAuth、Graph、IMAP、代理）
│       ├── types/           # TypeScript 类型定义
│       └── utils/           # 工具函数
├── web/                     # 前端应用
│   └── src/
│       ├── components/      # UI 组件（按模块分组）
│       ├── lib/             # API 客户端 & 工具函数
│       ├── pages/           # 页面组件
│       ├── stores/          # Zustand 状态管理
│       └── types/           # 前端类型定义
├── data/                    # Docker 持久化数据（宿主机目录）
├── docker/                  # 容器入口脚本
├── Dockerfile               # Node.js 22 多阶段构建
├── compose.yaml             # Docker Compose 部署配置
├── .env.docker.example      # Docker 部署环境变量模板
├── .env.example             # 本地开发环境变量模板
└── package.json             # 根 monorepo 配置
```

## Docker 部署（推荐，适用于 Linux + 宝塔）

服务器安装 Docker Engine 和 Docker Compose 插件即可，Node.js 22、依赖安装和前后端构建均在镜像中完成。一个容器同时提供网页和 API，使用 SQLite，无需额外安装 Node.js、PM2 或 MySQL。

### 首次部署

将项目源码上传到服务器，例如 `/www/wwwroot/xoyol-manager`。在宝塔终端或 SSH 中执行：

```bash
cd /www/wwwroot/xoyol-manager
docker --version
docker compose version
cp -n .env.docker.example .env
mkdir -p data
```

已有 `.env` 时直接修改，避免覆盖原配置。编辑 `.env`，把域名替换为最终访问域名：

```dotenv
APP_ORIGIN=https://game.example.com
TRUST_PROXY=true
BIND_ADDRESS=127.0.0.1
HOST_PORT=3000
LOG_LEVEL=info
SESSION_HOURS=12
REMEMBER_DAYS=7
PROXY_PRIVATE_HOST_ALLOWLIST=
```

`APP_ORIGIN` 不带末尾 `/`，须与浏览器访问地址一致。Compose 固定使用生产模式和安全 Cookie，通过下面配置的 HTTPS 域名登录。默认只将后端端口发布到服务器本机，由宝塔 Nginx 转发；`HOST_PORT` 可更改以避开端口占用，修改后同步更改反向代理目标。

构建并启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

全新数据库还需在交互式终端创建管理员：

```bash
docker compose exec --user node app node server/dist/admin.js init admin
```

按提示输入两次密码，要求 12～128 个字符。迁移的数据已有管理员时跳过初始化，使用原账号登录。管理员忘记密码时执行：

```bash
docker compose exec --user node app node server/dist/admin.js reset admin
```

以上命令中的 `admin` 是管理员用户名，可替换。密码不放在命令行或环境变量中。

### 宝塔域名、HTTPS 和反向代理

先将域名解析到服务器。在宝塔添加纯静态网站，网站目录使用独立空目录，例如 `/www/wwwroot/game.example.com`；项目和 `data` 目录不要作为网站根目录。为网站申请 SSL 证书并开启强制 HTTPS，再添加整站反向代理：

- 目标 URL：`http://127.0.0.1:3000`，端口与 `HOST_PORT` 一致。
- 发送域名：`$host`。
- 关闭代理缓存。

在该代理的 `location` 配置中，确认以下转发头由 Nginx 覆盖；已有同名配置时修改原配置：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 180s;
```

在网站的 `server` 块设置上传限制，以支持数据库恢复：

```nginx
client_max_body_size 80m;
access_log off;
```

关闭访问日志可避免记录完整账号短链。保存并重载 Nginx 后，访问 `https://game.example.com`。服务器防火墙和云安全组放行网站的 80、443 端口；后端继续使用默认的本机绑定，不向公网开放 3000 端口。该示例适用于宝塔 Nginx 直接接收浏览器请求的部署方式。

### 独立数据目录

Compose 将项目根目录的 `./data` 绑定到容器 `/app/data`，数据库固定写入 `/app/data/outlook.db`。容器删除、镜像重建和源码更新不会删除宿主机数据。入口脚本会准备数据目录并设置运行用户权限，应用随后以非 root 用户启动。

```text
xoyol-manager/
├── data/
│   ├── outlook.db
│   ├── outlook.db-wal       # SQLite 运行时可能存在
│   ├── outlook.db-shm       # SQLite 运行时可能存在
│   ├── migration-backups/   # 数据库升级前备份，按需生成
│   └── restore-backups/     # 页面恢复前备份，按需生成
├── .env
├── compose.yaml
└── ...
```

该目录保存平台用户、游戏账号、邮箱授权、缓存、短链和系统设置，应限制目录访问并定期备份。运行期间不要手工只复制 `outlook.db`；SQLite 的最新数据可能仍在 WAL 文件中。

原非 Docker 部署的数据默认位于 `server/data/`。先停止原服务，确认没有进程继续读写数据库，再将**整个目录内容**复制到根目录 `data/`，然后首次启动 Docker：

```bash
cd /www/wwwroot/xoyol-manager
mkdir -p data
cp -a server/data/. data/
docker compose up -d --build
```

此操作适用于目标 `data/` 尚无业务数据的迁移；原来设置了自定义 `DB_PATH` 时，从实际数据库目录复制，并确保目标数据库名为 `outlook.db`。保留原数据直到完成登录、账号和短链验证。

迁移到另一台服务器时，先停止当前容器：

```bash
cd /www/wwwroot/xoyol-manager
docker compose down
```

把项目源码、`.env` 和整个 `data/` 目录复制到新服务器，在新项目目录执行 `docker compose up -d --build`。目录复制迁移会保留原有短链随机码和数据；域名不变时原网址可继续使用，域名变化时更新 `.env` 的 `APP_ORIGIN` 并使用新域名前缀访问原 `/s/随机码`。通过管理员页面“恢复备份”有不同的权限撤销规则，详见下文“备份与恢复”。

### 更新与日常维护

更新前先在管理员“系统设置”下载备份，或停止容器后备份整个 `data/`。更新源码时保留 `.env` 和 `data/`，然后执行：

```bash
cd /www/wwwroot/xoyol-manager
docker compose down
# 在此上传或拉取新版源码，保留 .env 和 data/
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

启动时自动执行数据库版本迁移，升级前备份保存在 `data/migration-backups/`。查看实时日志和重启服务：

```bash
docker compose logs -f --tail=100 app
docker compose restart app
```

修改 `.env` 后使用 `docker compose up -d` 重建容器，单独 `restart` 不会更新容器环境变量。保持一个应用实例，不要使用 `--scale app=...` 或让另一个服务同时操作此数据库。

## 本地开发与非 Docker 运行

### 环境要求

- Node.js 22 LTS（原生 SQLite 依赖须与当前 Node 版本匹配）
- npm >= 9

### 安装

```bash
# 克隆项目后，一键安装所有依赖
npm run install:all
```

### 配置

复制环境变量模板并按需修改：

```bash
cp .env.example .env
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `DB_PATH` | `./data/outlook.db` | SQLite 数据库路径（相对于 server/） |
| `SESSION_HOURS` | `12` | 普通登录会话有效小时数 |
| `REMEMBER_DAYS` | `7` | 勾选“保持登录”的会话有效天数 |
| `COOKIE_SECURE` | 生产模式为 `true`，其他为 `false` | HTTPS 部署设为 `true`；本地 HTTP 开发设为 `false` |
| `APP_ORIGIN` | _(空)_ | 外部访问源，例如 `https://mail.example.com`；反向代理部署时必须与浏览器访问源一致 |
| `TRUST_PROXY` | `false` | 仅在应用由可信反向代理访问时设为 `true`，让 Koa 正确识别 HTTPS 和客户端 IP |
| `PROXY_PRIVATE_HOST_ALLOWLIST` | _(空)_ | 可信内网代理的精确主机名/IP 白名单，逗号分隔；未配置时禁止连接私网或本地代理 |

### 初始化管理员与旧版本升级

首次启动前，在交互式终端创建管理员：

```bash
npm --prefix server run admin:init -- admin
```

按提示输入两次密码（输入隐藏，12～128 个字符）。不提供默认管理员密码，公开注册者不能成为初始管理员。初始化完成后，访问网站首页即可登录；系统默认开放普通用户注册，可在管理员的“系统设置”中关闭。

升级旧数据库时，初始化命令先执行版本化迁移，将原有邮箱、标签、代理及邮件缓存保留下来，并把历史资源归属初始管理员。迁移前使用 SQLite 一致性备份，文件位于数据库同级的 `migration-backups/`；迁移失败会回滚并停止。数据库迁移完成但未初始化管理员时，业务接口保持关闭。原 `ACCESS_PASSWORD` 和旧 Token 不再生效，所有人必须使用平台账号登录。

管理员忘记密码时，在服务器本地执行：

```bash
npm --prefix server run admin:reset -- admin
```

重置会撤销该管理员的全部会话；下一次登录必须先修改密码。普通用户由管理员在“用户管理”中重置。管理员创建用户时设置的临时密码也须首次登录修改；自行注册的用户无需再次改密。

平台密码采用随机盐 `scrypt` 哈希保存，浏览器使用 HttpOnly Cookie 会话。写接口要求 `X-CSRF-Token`；前端从认证配置/当前会话接口取得该值。生产部署应使用 HTTPS，并设置 `COOKIE_SECURE=true`。TLS 在反向代理终止时，同时设置外部 `APP_ORIGIN` 和 `TRUST_PROXY=true`，由可信代理覆盖 `X-Forwarded-Proto`、`X-Forwarded-For` 等头，并限制用户直接连接后端端口，保持浏览器与 API 同源。应用默认不信任转发头。

普通用户只能访问自己的游戏账号、绑定邮箱、邮件缓存、标签、代理和统计；管理员可以访问全部数据及邮箱凭据。游戏账号和邮箱地址分别保持全局唯一，第一版一个游戏账号绑定一个微软邮箱。账号转移或认领时缓存随账号转移，原标签关联解除，接收方重新分类。注销用户前须移交账号并清理其标签和代理；停用用户会立即撤销会话并保留资源。最后一个有效管理员不能被停用、注销或降级。

### 开发模式

```bash
# 同时启动前后端（热重载）
npm run dev
```

- 前端：http://localhost:5173（Vite dev server，自动代理 `/api` 到后端）
- 后端：http://localhost:3000

### 生产构建

```bash
# 构建后端与前端
npm run build

# 启动后端（同时托管前端静态文件）
npm start
```

后端同时提供前端页面。`NODE_ENV=production` 默认要求安全 Cookie，生产环境请配置反向代理并通过 HTTPS 地址访问；本地 HTTP 调试使用上面的开发模式。

当前使用单进程运行后端；资源操作锁、请求限流和恢复维护状态在进程内管理，请勿使用多进程集群或让多个服务实例同时操作同一数据库。恢复前请停止其他直接访问数据库的工具。

### 验证

```bash
npm --prefix server run build
npm --prefix web run build
# 在项目根目录运行集成测试（使用临时或内存数据库）
npm test
```

若提示 `NODE_MODULE_VERSION` 不匹配，请切换到安装依赖时使用的 Node.js 22，或在目标 Node 环境重新安装/构建 `better-sqlite3`。

### 备份与恢复

在管理员“系统设置”中输入当前密码后下载备份或恢复备份。备份包含平台用户、密码哈希、邮箱凭据和业务数据，应保存在受限目录；下载文件不包含有效登录会话。恢复前会校验文件完整性、数据库版本、有效管理员和数据归属，恢复期间暂停其他请求；失败可回滚，恢复前数据库保存在数据库同级 `restore-backups/`。恢复成功后，使用备份中的账号重新登录。所有认领码、账号短链、外部 API Key 和库存账号的导入认领资格会在恢复时撤销，需要重新发放；管理员须将拟交付的库存账号重新批量导入（已有记录选择覆盖），用户才能再次通过导入认领，避免已撤销的访问权限通过旧备份再次生效。恢复旧版本备份时会先迁移，并将其历史资源归属执行恢复的管理员。

## API 端点

### 外部 API（管理员 API Key）

管理员在「系统设置 → 外部 API」生成 Key，完整 Key 仅显示一次。外部程序发送 `Authorization: Bearer <API Key>`，调用 `/api/external/v1` 下的接口，无需登录 Cookie 或 CSRF Token。只勾选「导入账号」权限即可调用 `POST /api/external/v1/accounts/import`，请求 `{ "content": "游戏账号----游戏密码----name----身份证后六位----邮箱----邮箱密码----client_id----刷新令牌" }`，响应 `data.accounts[].share_url` 为完整短链，`data.export_content` 为五字段交付文本。多行账号使用 `\n` 分隔。

导入请求可加 `"expires_in_days": 7` 设置本批次短链有效期，支持 1～3650 的整数天数；传 `null` 为永久有效。不传时，新生成或覆盖导入的短链默认永久有效。默认 `skip` 模式下，已有有效短链保留原期限及访问记录；需更新已有链接期限时使用 `mode: "overwrite"`，有效链接的随机码保留，有限期从本次导入时起重新计算。响应 `share_link_expires_at` 返回实际到期时间，永久有效为 `null`。

另支持账号查询、完整资料读取、短链查看/重置/关闭和双文件夹验证码获取。Key 可设置权限、到期时间、随时撤销，后台显示创建人及最近使用时间。完整字段说明、批量导入、curl 与 Python 示例见 [外部 API 调用文档](docs/external-api.md)。Docker 更新后启动会自动迁移数据库；完整短链使用 `.env` 的 `APP_ORIGIN`，Key 无需写入 `.env`。

后台管理 Key 的接口为 `GET /api/api-keys`（列表）、`POST /api/api-keys`（生成）和 `DELETE /api/api-keys/:id`（撤销），继续使用管理员登录会话和写操作 CSRF 校验，API Key 本身不能管理其他 Key。

### 认证与用户

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/auth/config` | 公开认证配置、初始化状态及匿名 CSRF Token |
| POST | `/api/auth/register` | 创建普通用户并自动登录 |
| POST | `/api/auth/login` | 用户名/密码登录，支持 `remember` |
| GET | `/api/auth/me` | 当前用户及会话 CSRF Token |
| POST | `/api/auth/logout` | 撤销当前会话并退出 |
| PATCH | `/api/auth/profile` | 修改自己的显示名称 |
| PUT | `/api/auth/password` | 校验当前密码后改密，撤销全部会话 |
| GET / POST | `/api/users` | 管理员查询/创建用户 |
| PATCH / DELETE | `/api/users/:id` | 管理员更新/注销用户 |
| POST | `/api/users/:id/reset-password` | 设置临时密码并撤销会话 |
| POST | `/api/users/:id/revoke-sessions` | 强制退出该用户的全部设备 |
| GET / PATCH | `/api/settings` | 管理员读取/修改注册开关 |
| GET | `/api/audit` | 管理员分页查询操作审计 |

响应统一为 `{ code, data, message }`，错误同时返回对应 HTTP 状态；会话失效为 `401`，无权访问为 `403`。用户名不区分大小写，支持 3～32 位字母、数字或下划线。用于登录本平台的用户、被管理的游戏账号和绑定的微软邮箱是三个独立概念。

### 账户 `/api/accounts`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 获取账户列表（支持分页、搜索） |
| GET | `/:id/credentials` | 按权限读取单个邮箱完整凭据并记录审计 |
| POST | `/` | 管理员创建账户，普通用户不允许新增 |
| PUT | `/:id` | 更新账户 |
| DELETE | `/:id` | 删除账户 |
| POST | `/batch-delete` | 批量删除 |
| POST | `/import` | 管理员批量导入；普通用户按所提交资料认领后台库存 |
| POST | `/import-preview` | 管理员预览新增/重复项；用户预览可认领项及资料错误 |
| POST | `/import-confirm` | 管理员确认导入、跳过或覆盖，可选 `generate_share_links`；用户仅确认认领 |
| POST | `/export` | 导出所选或有权限的全部邮箱 |
| POST | `/:id/tags` | 设置邮箱标签 |
| POST | `/transfer` | 管理员移交所选邮箱 |
| POST | `/transfer-resources` | 管理员移交用户全部邮箱、标签和代理 |
| POST | `/claim-pool` | 管理员为自己名下的账号生成一次性认领码，返回明文仅此一次 |
| POST | `/claim-pool/revoke` | 管理员撤销尚未使用的认领码 |
| POST | `/claim` | 用户提交 `{code}` 原子认领一个账号 |
| GET | `/:id/share-link` | 所属用户或管理员查看账号短链状态及当前链接 |
| POST | `/:id/share-link` | 创建或重置账号短链，可选 `expires_in_days`：1～3650 的整数天数，`null` 或不传为永久有效 |
| DELETE | `/:id/share-link` | 关闭账号短链 |

### 公开短链 `/api/share`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/:token` | 无需登录，读取该短链绑定账号的八字段资料 |
| POST | `/:token/verification-code` | 无需登录，仅获取该短链对应邮箱的验证码，JSON 请求体 `{}`，同时检查收件箱和垃圾箱 |

### 邮件 `/api/mails`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/fetch` | 拉取邮件（Graph API → IMAP 降级） |
| POST | `/fetch-new` | 仅拉取新邮件 |
| POST | `/verification-code` | 按 `account_id` 同时读取收件箱和垃圾箱各最近20封邮件，合并验证码候选，可选 `proxy_id` |
| GET | `/cached?account_id=…&mailbox=INBOX` | 分页获取缓存邮件 |
| DELETE | `/clear` | 按请求体的 `account_id` 与 `mailbox` 清空远端邮件及缓存 |

两个验证码接口均固定检查 `INBOX` 和 `Junk`，不需要传 `mailbox`。兼容旧客户端传入的 `INBOX` / `Junk`（仍读取两箱），也接受 `ALL`；其他值返回 `400`。响应包含 `mailbox: "ALL"`、`mailboxes: ["INBOX", "Junk"]`、按邮件时间排序的 `candidates`、`cached`、`partial` 和 `fetched_at`。每个候选带 `mailbox` 和 `cached` 标明来源；`partial: true` 时 `warning` 说明读取失败的文件夹及是否使用历史缓存。`protocol` 可为 `graph`、`imap` 或 `mixed`。两箱均失败且无缓存时返回 `502`；整个双文件夹请求只计一次收信限流。普通邮件查看、缓存浏览和清空接口继续支持按文件夹操作。

### 代理 `/api/proxies`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 获取代理列表 |
| POST | `/` | 创建代理 |
| GET | `/:id/credentials` | 按权限读取代理完整凭据并记录审计 |
| PUT | `/:id` | 更新代理 |
| DELETE | `/:id` | 删除代理 |
| POST | `/:id/test` | 测试连通性 |
| PUT | `/:id/default` | 设为该用户的默认代理 |

### 仪表盘 `/api/dashboard`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/stats` | 获取统计数据 |

## 游戏账号导入与认领

管理员在“账号管理”中粘贴文本批量导入，每行一个账号，八个字段顺序如下：

```
游戏账号----游戏密码----name----身份证后六位----邮箱----邮箱密码----client_id----刷新令牌
```

示例（均为虚构资料）：

```text
game001----GamePass123----张三----00123X----game001@outlook.com----MailPass123----your-client-id----your-refresh-token
```

分隔符可自定义（默认 `----`），字段本身不能含该分隔符或换行。`name` 按原始名称保存；身份证后六位作为字符串保存以保留前导零，末位支持 `X/x`。导入先预览错误与重复项，再由管理员选择跳过或覆盖。列表向账号所属用户和管理员明文显示前五项资料，邮箱密码、刷新令牌仅在编辑等需要时按权限读取，完整八字段导出也仅限有权访问的账号。

管理员导入时可勾选同时生成短链，成功导入后下载交付文本，固定使用 `----` 分隔，每行一个账号：

```text
游戏账号----游戏密码----name----身份证后六位----短链
game001----GamePass123----张三----00123X----https://your-site.example/s/随机码
```

后台页面批量生成的链接默认长期有效。仅为本次成功新增或覆盖的账号生成交付结果，跳过项和失败项没有输出；覆盖已有账号时复用仍有效的链接，未指定期限时将其设为长期有效，已失效的链接会重新生成。批量交付需要完整的游戏账号四项资料。API 在管理员导入请求中接受 `generate_share_links: true`，响应 `share_exports` 数组包含 `game_account`、`game_password`、`real_name`、`id_last_six`、`path`；`path` 是 `/s/随机码` 相对路径，网页使用当前站点地址组合为完整短链后导出。未勾选时不生成交付结果。外部 API 可通过 `expires_in_days` 自定义短链期限，参数及重复导入规则见[外部 API 调用文档](docs/external-api.md)。

普通用户的“导入账号”即认领：可粘贴上述五字段短链文本，或完整八字段资料。账号必须已经由管理员在后台批量导入、仍归有效管理员持有且尚未被其他用户认领；提交资料需与后台记录匹配，五字段格式还要求短链有效。普通用户不能新增任意账号或通过导入覆盖资料；后台不存在、资料不匹配或已被他人认领的行会报错，重复导入自己名下的账号会跳过。导入后账号及邮箱缓存转入该用户，原标签关联清除；有效短链随账号转交，保留原网址、创建时间和有效期，用户点击“短链”即可查看、复制和管理。一次性导入码接收账号也保留有效短链。已关闭、过期或已被旧版本导入流程删除的短链不会自动恢复。

普通用户点击“删除”（含批量删除、删除当前页）时，只从自己的列表移除账号，账号退回原库存管理员名下并重新成为可导入库存。账号资料、绑定邮箱、邮件缓存及仍有效的短链完整保留，短链地址和有效期不变；清除原用户的标签关联和一次性导入码。用户以后可用匹配的五字段或八字段资料重新导入。历史账号未记录原管理员，或原管理员已不可接收时，退回当前可用的管理员；没有可用管理员时操作失败，不改变账号。管理员侧“删除”则永久删除该账号及关联缓存、标签关联和短链，之后普通用户无法再导入该记录，除非管理员重新录入。

管理员导入时可选择“待认领”，或选中自己名下的游戏账号生成认领码。保存并自行交付生成结果，用户登录后在“认领账号”中输入码即可接收账号。认领码有效期7天，只存哈希、只能成功使用一次；重新生成使旧码失效，也可撤销未使用的码。待认领账号仍由发码管理员保管，普通用户无法浏览待认领账号资料。已认领账号需要再次移交时使用管理员转移功能。

管理员仍可导入旧四字段 `邮箱----邮箱密码----client_id----刷新令牌`，已有邮箱与邮件缓存也会保留。此类历史记录会提示补全游戏资料，在编辑中补齐后即可作为游戏账号管理。历史迁移或单条新增的记录如需作为用户导入认领的库存，须由管理员批量导入完整资料。普通用户的认领导入不接受四字段格式。

点击账号的“验证码”会同时读取绑定邮箱收件箱和垃圾箱各最近20封邮件，按验证码关键词提取候选并按时间合并展示，无需选择文件夹；仍找不到时可打开邮件查看器，邮件查看器继续支持切换收件箱和垃圾箱。页面显示邮件时间，“近期”仅表示邮件在最近15分钟内，不代表验证码实际有效期。某一文件夹读取失败时会给出提示，并使用该文件夹的历史缓存（如有）；缓存候选会单独标注，需检查邮件时间或稍后刷新，系统不能保证候选码仍有效。每个账号收信间隔至少3秒，同一用户每分钟最多30次，一次双文件夹取码只计一次操作。真实收信需要有效的微软邮箱授权与可连接的网络/代理。

## 账号短链

管理员可在“系统设置 → 短链设置”中调整短链随机码长度，支持 8～64 位整数，默认 22 位。长度只计算 `/s/` 后面的随机码，不包含域名和路径。保存后，所有账号新生成、重置及批量导入时新建的短链使用该长度；已有短链保留原地址和有效期，仍可访问、获取验证码和用于五字段账号导入。需要更改已有短链长度时，请在该账号的“短链”窗口重置链接，旧链接会立即失效。

管理员设置接口 `GET /api/settings` 返回 `registration_enabled` 和 `short_link_length`；`PATCH /api/settings` 可单独提交 `{ "short_link_length": 12 }`，也可与注册开关一起保存。普通用户无法修改该设置。

在“账号管理”的某个账号上点击“短链”，选择长期有效、7天或30天后生成并复制链接。已有链接可再次查看和复制；重新生成会立即替换旧链接，关闭后旧链接不可继续使用。默认长期有效，直到所有者或管理员关闭、重置，或账号由管理员手动移交、删除。用户导入账号时保留原有有效短链及其有效期。每个账号同时只有一条有效短链，链接不会自动授予平台账号所有权，和一次性认领码相互独立。

管理员“账号管理”列表增加“短链访问”状态：当前没有可用链接时显示“无有效短链”；有效链接尚未成功打开时显示“未访问”；成功打开后显示“已访问”和最近访问时间。刷新账号列表即可查看最新状态。访问以公开账号资料接口成功返回为准；后台查看、复制或导入链接不会标记为已访问，管理员自己打开公开短链也会记录。普通用户的接口响应和公开页面均不包含访问状态。

访问检测从升级后开始，无法追溯升级前的访问。重置链接后新链接重新计为“未访问”；关闭、到期或账号不可用后不展示原链接的访问记录。用户导入认领、删除后退回管理员等保留原有效短链的操作，会保留对应访问状态。状态随数据库持久保存，重启和目录迁移不会清空；数据库字段在应用启动时自动升级。

接收方打开 `/s/随机码` 即可明文查看游戏账号、游戏密码、name、身份证后六位、邮箱、邮箱密码、client_id 和刷新令牌，可逐项复制或复制完整八字段；点击获取验证码后，同时检查该账号绑定邮箱的收件箱和垃圾箱，收信完成会更新页面上的最新刷新令牌。持有短链即具有这些资料的查看和验证码获取权限，请将链接交付给有权使用该账号的人。普通用户只能管理自己账号的短链，管理员可管理所有账号；所属平台用户被停用、注销或被要求强制修改密码时，公开链接不可用。

短链使用当前站点域名生成，不依赖第三方短网址服务。分享给其他人时，请通过他们可访问的域名或 IP 打开平台后生成链接；`localhost` 和 `127.0.0.1` 链接只能在访问者本机使用。反向代理部署继续按前文配置 `APP_ORIGIN`、HTTPS 和可信代理。

公开页面和接口不缓存敏感响应、不发送来源地址，并声明不允许搜索引擎收录；应用日志隐藏链接中的随机码。短链收信复用原有收信间隔、归属用户限流与默认代理，并增加公开访问限流。失效、过期或已关闭的链接统一显示不可用；恢复备份后需重新生成短链。

## 致谢

本项目的 OAuth2 认证流程参考了 [MS_OAuth2API_Next](https://github.com/HChaoHui/MS_OAuth2API_Next)，感谢原作者 [@HChaoHui](https://github.com/HChaoHui) 的开源贡献。

## License

MIT
