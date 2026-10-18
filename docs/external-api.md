# 外部 API v1

外部系统使用管理员生成的 API Key 调用，无需登录会话、Cookie 或 CSRF Token。服务端升级后会自动创建相关数据表，不需要在 `.env` 中添加 Key。

## 生成 Key

管理员登录平台，打开「系统设置 → 外部 API」，填写名称，选择所需权限和有效期，点击生成。完整 Key 仅在本次生成后显示一次，关闭前复制并保存；之后列表仅显示前缀。可以创建多个 Key，分别交给不同的调用程序，并独立撤销。

| 权限 | 用途 |
| --- | --- |
| `accounts:import` | 导入到发放 Key 的管理员名下，自动生成和返回交付短链 |
| `accounts:read` | 查询全站游戏账号、读取单个账号完整八字段资料，以及查看现有短链和访问状态 |
| `share-links:write` | 为全站任意账号生成、重置或关闭短链 |
| `mail:read` | 获取全站任意游戏账号绑定邮箱的验证码 |

只需「导入并获取短链」时，勾选 `accounts:import` 即可。权限以管理员业务范围执行；短链持有者能够查看对应账号完整资料，请按用途分配 Key。

Key 到期或被撤销后立即失效。发放 Key 的管理员被停用、注销、降为普通用户，或被要求修改初始密码时，其 Key 不可使用。恢复数据库备份会撤销所有 Key，需要重新生成；直接迁移整个 `data/` 目录会保留 Key。

## 地址与认证

接口根路径：

```text
https://你的域名/api/external/v1
```

每个请求都发送：

```http
Authorization: Bearer xoyol_这里替换为完整Key
Content-Type: application/json
```

Key 只从 `Authorization` 请求头读取，不接受 URL 查询参数、请求体或登录 Cookie 中的 Key。外部 Key 只能访问 `/api/external/v1` 下的接口，不能用来调用用户管理、系统设置、备份等后台接口。调用方应将 Key 存在服务端环境变量中。

完整短链优先使用服务器 `.env` 的 `APP_ORIGIN` 组合，例如 `APP_ORIGIN=https://game.example.com`。未设置时使用当前请求的协议及域名。Docker 和宝塔部署请填写真实公网访问地址，避免返回本机或容器内地址。

## 导入账号并生成短链

```http
POST /api/external/v1/accounts/import
```

请求 JSON：

```json
{
  "content": "game001----GamePass123----张三----00123X----game001@outlook.com----MailPass123----your-client-id----your-refresh-token",
  "expires_in_days": 7
}
```

`content` 每行一个账号，多行用 JSON 的 `\n` 分隔，固定八字段顺序如下：

```text
游戏账号----游戏密码----name----后六位----邮箱----邮箱密码----client_id----刷新令牌
```

字段本身不能包含 `----` 或换行。后六位作为字符串保存，保留前导零，末位支持 `X`。`name` 在响应中对应 `real_name`，邮箱密码对应 `password`。

| 请求字段 | 必填 | 说明 |
| --- | --- | --- |
| `content` | 是 | 八字段文本；单次最多 5000 行、2 MB |
| `mode` | 否 | 默认 `skip` 跳过已有账号；明确传 `overwrite` 时才覆盖当前发放 Key 的管理员名下记录 |
| `placement` | 否 | 默认 `owned`，账号归发放 Key 的管理员持有并允许用户导入认领；`pool` 额外生成七天有效的一次性认领码 |
| `expires_in_days` | 否 | 本批次短链有效天数，支持 1～3650 的整数；`null` 表示永久有效。不传时，新生成或覆盖导入的短链默认永久有效；跳过的已有有效短链保留原到期时间 |

接口自动生成短链，不需要额外传入 `generate_share_links`，也不接受 `owner_user_id`、自定义分隔符和自定义列顺序。

例如，`"expires_in_days": 1` 为一天，`"expires_in_days": 30` 为三十天，`"expires_in_days": null` 为永久有效。有限期从本次导入时起计算，同一批次使用相同设置；该字段只设置短链期限，不改变 API Key 或认领码的期限。字符串（如 `"7"`）、布尔值、小数、零、负数和超过 3650 的天数均返回 `400`，不会写入本批次账号或短链。

成功响应示例（账号 ID、短链和时间仅作示例；实际响应还包含账号状态等字段）：

```json
{
  "code": 200,
  "data": {
    "imported": 1,
    "skipped": 0,
    "errors": [],
    "accounts": [
      {
        "id": 123,
        "owner_user_id": 1,
        "game_account": "game001",
        "game_password": "GamePass123",
        "real_name": "张三",
        "id_last_six": "00123X",
        "email": "game001@outlook.com",
        "share_link_enabled": true,
        "share_path": "/s/A1b2C3d4E5f6G7h8I9j0Kl",
        "share_url": "https://game.example.com/s/A1b2C3d4E5f6G7h8I9j0Kl",
        "share_link_last_accessed_at": null,
        "share_link_expires_at": "2026-10-25T12:00:00.000Z"
      }
    ],
    "export_content": "game001----GamePass123----张三----00123X----https://game.example.com/s/A1b2C3d4E5f6G7h8I9j0Kl"
  },
  "message": "ok"
}
```

`accounts[].share_url` 是完整短链；`accounts[].share_link_expires_at` 为实际到期时间，永久有效时为 `null`。`export_content` 可直接保存为交付文本，格式为 `游戏账号----游戏密码----name----后六位----短链`，一行一个。

默认跳过重复项时，若八字段与管理员名下已有记录完全一致，仍在 `accounts` 中返回其交付结果，`imported` 为 0、`skipped` 增加。即使传入 `expires_in_days`，已有有效链接及其访问记录、到期时间也保持不变，重试导入不会续期。若该账号没有有效短链，会按本次请求的期限生成新链接。若重复资料不一致，跳过该行并在 `errors` 中说明，不返回已有资料或短链。

使用 `overwrite` 时会覆盖管理员自己名下的匹配账号。已有有效短链保留随机码及访问记录，并按本次请求更新期限；传天数时从本次导入时间重新计算，传 `null` 或不传时改为永久有效。已失效的链接会按本次请求的期限重新生成。导入中的账号格式错误按行返回，其他有效行可成功导入；若遇到其他用户名下的账号、游戏账号与邮箱指向不同记录，或多行指向同一记录等归属冲突，则整批返回 `409`，不写入账号或短链。

将已有账号的短链改为永久有效时，传入完整八字段资料，并明确指定 `overwrite`：

```json
{
  "content": "game001----GamePass123----张三----00123X----game001@outlook.com----MailPass123----your-client-id----your-refresh-token",
  "mode": "overwrite",
  "expires_in_days": null
}
```

API 导入的账号与后台批量导入一致。用户可以导入收到的五字段交付文本或完整八字段资料来认领，认领时保留有效短链及访问状态。

Linux / 宝塔命令示例：先在调用环境设置 `XOYOL_API_KEY`，将域名替换为实际站点。

```bash
curl --request POST 'https://game.example.com/api/external/v1/accounts/import' \
  --header "Authorization: Bearer ${XOYOL_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{"content":"game001----GamePass123----张三----00123X----game001@outlook.com----MailPass123----your-client-id----your-refresh-token","expires_in_days":7}'
```

上例生成七天有效的短链。批量调用时，把请求保存为 UTF-8 的 `import.json`，然后发送文件；下面示例生成永久有效的短链：

```json
{
  "content": "game001----GamePass123----张三----00123X----game001@outlook.com----MailPass123----client001----refresh001\ngame002----GamePass456----李四----001234----game002@outlook.com----MailPass456----client002----refresh002",
  "expires_in_days": null
}
```

```bash
curl --request POST 'https://game.example.com/api/external/v1/accounts/import' \
  --header "Authorization: Bearer ${XOYOL_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data-binary @import.json
```

Python 示例（使用标准库）：

```python
import json
import os
import urllib.request

request = urllib.request.Request(
    "https://game.example.com/api/external/v1/accounts/import",
    data=json.dumps({
        "content": "game001----GamePass123----张三----00123X----game001@outlook.com----MailPass123----your-client-id----your-refresh-token",
        "expires_in_days": 7,  # 1～3650 天；永久有效改为 None
    }, ensure_ascii=False).encode("utf-8"),
    headers={
        "Authorization": "Bearer " + os.environ["XOYOL_API_KEY"],
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=60) as response:
    result = json.load(response)["data"]
for account in result["accounts"]:
    print(account["game_account"], account["share_url"])
```

## 查询与短链管理

| 方法 | 路径（相对于外部 API 根路径） | 所需权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/accounts` | `accounts:read` | 查询账号及短链访问状态 |
| GET | `/accounts/:id` | `accounts:read` | 获取单个账号完整八字段资料及短链 |
| GET | `/accounts/:id/share-link` | `accounts:read` | 查看有效短链及最后访问时间，不计入公开访问 |
| POST | `/accounts/:id/share-link` | `share-links:write` | 创建或重置短链，旧链接立即失效 |
| DELETE | `/accounts/:id/share-link` | `share-links:write` | 关闭短链 |
| POST | `/accounts/:id/verification-code` | `mail:read` | 合并获取收件箱与垃圾箱的验证码 |

账号列表接受 `page`（默认 1）、`pageSize`（默认 20，最大 200）、`search`（最多 200 字符）、`owner_user_id`（可选归属 ID）、`claim_status`（`assigned` 或 `available`）。返回 `data: {list, total, page, pageSize}`。列表明文包含游戏资料及绑定邮箱，邮箱密码、`client_id` 和刷新令牌使用单个账号详情接口获取。

创建/重置短链需要 JSON 请求体，例如 `{ "expires_in_days": 7 }`，支持 1～3650 的整数天数；`{ "expires_in_days": null }` 或 `{}` 表示永久有效。参数校验与导入接口一致。有限期从创建/重置时起计算，重置始终生成新随机码；随机码长度沿用管理员的短链长度设置。成功返回：

```json
{
  "code": 200,
  "data": {
    "enabled": true,
    "path": "/s/A1b2C3d4E5f6G7h8I9j0Kl",
    "url": "https://game.example.com/s/A1b2C3d4E5f6G7h8I9j0Kl",
    "created_at": "2026-10-18 12:00:00",
    "expires_at": "2026-10-25T12:00:00.000Z",
    "last_accessed_at": null
  },
  "message": "ok"
}
```

查询短链接口返回相同结构；没有有效短链时为 `{ "enabled": false }`。生成、查看和复制短链均不计为公开访问，只有成功打开公开短链资料才记录。重置短链会清空访问状态，外部 API 的访问状态字段仅通过管理员授权的 Key 读取，普通用户界面及其接口仍不显示。

## 获取邮箱验证码

```http
POST /api/external/v1/accounts/123/verification-code
Content-Type: application/json
Authorization: Bearer xoyol_你的Key

{}
```

固定检查收件箱和垃圾箱各最近 20 封邮件，复用账号所属用户的默认代理和现有收信策略。请求不需要传文件夹，也不允许指定其他账号 ID 或代理。响应包含 `account_id`、`email`、`mailbox: "ALL"`、`mailboxes: ["INBOX", "Junk"]`、`candidates`、`cached`、`partial`、`protocol` 和 `fetched_at`。候选中包含验证码 `code`、邮件时间、主题、发件人及来源文件夹；没有候选时返回空数组。

部分文件夹读取失败会返回 `partial: true` 和 `warning`，并标明是否使用缓存。两箱均失败且无缓存时返回 `502`。邮件操作过程中再次检查 Key 权限及账号绑定；Key 被撤销时不会继续返回验证码。

## 状态码、限流与审计

所有 JSON 响应统一为 `{ "code": 200, "data": ..., "message": "ok" }`；错误的 `code` 与 HTTP 状态码一致，`data` 为 `null`。

| HTTP 状态 | 含义 |
| --- | --- |
| `200` | 请求完成；批量导入仍应检查 `imported`、`skipped`、`errors` |
| `400` | 参数、字段格式或分页无效 |
| `401` | 未发送 Key、Key 无效/过期/撤销，或发放管理员不可用 |
| `403` | Key 缺少该接口要求的权限 |
| `404` | 账号不存在或 Key 管理记录不存在 |
| `409` | 导入归属冲突、资源正在收信，或账号绑定发生变化 |
| `413` | 请求体超限 |
| `415` | 写接口未发送 `application/json` |
| `429` | 请求超过限流，请稍后重试 |
| `502` | 邮箱收信失败且无可用缓存 |
| `503` | 数据恢复中或站点地址配置无效 |

外部 API 每个 Key 每分钟最多 120 次，同一来源 IP 每分钟最多 240 次。导入沿用发放管理员每分钟 10 次的预算，生成/重置短链每分钟 30 次；收信沿用管理员每分钟 30 次、每个邮箱至少间隔 3 秒的限制。IP/Key 级限流返回 `Retry-After` 秒数，业务限流可稍后重试。限流为当前进程内计数，重启会清空。

Key 的创建/撤销、外部账号查询/导入、短链管理和验证码获取均记录操作审计。Key 完整值、账号密码、刷新令牌和邮件正文不进入操作审计，Key 数据库记录仅保存哈希与显示用前缀。后台 Key 列表会显示最近一次通过认证的请求时间；外部访问日志不记录查询字符串。
