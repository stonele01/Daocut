# Daocut 公司服务

面向同一公司局域网的小规模部署：员工账号、登录与停用、密码重置、反馈与诊断处理、员工 Token 用量统计与日/月额度、安装包更新文件。员工的 AI API Key 仍保存在各自电脑；本服务对接新版 Daocut 的 AI 请求预留与结算，不转发模型内容、不代付费用，不含公司通用要求和记忆同步。

要求 Node.js 24.15 或更新版本。独立 npm 包，与桌面应用的 pnpm 依赖树分开。

## 安装与本机验证

```powershell
cd D:\CodexWork\Daocut
npm --prefix apps/company-service ci
npm --prefix apps/company-service test
npm --prefix apps/company-service start
```

本机模式只监听 `127.0.0.1:4715`。打开 `http://127.0.0.1:4715/admin`，由管理员本人填写姓名、账号和密码。没有默认账号或默认密码；创建完成后不能再次执行初始设置。

## 局域网运行

```powershell
npm --prefix apps/company-service run setup:lan
npm --prefix apps/company-service run start:lan
```

存在多张网卡时，设置命令会让操作者选择公司局域网网卡。也可明确指定当前电脑的局域网 IP：

```powershell
npm --prefix apps/company-service run setup:lan -- --ip 192.168.1.20
```

设置只生成本服务自己的证书，不修改 Windows 证书信任库、防火墙或系统自动启动。默认数据目录为 `D:\Daocut\CompanyData`，包含：

- `company.sqlite`、`company.sqlite-wal`、`company.sqlite-shm`：账号、会话、反馈（含主动附加的诊断和截图）、用量统计
- `auth-secret`：认证签名密钥
- `server-key.pem`、`server-cert.pem`：服务私钥与证书
- `server-config.json`：监听地址与文件路径
- `Daocut-公司连接.json`：可分发给员工的连接文件，只含公司名称、HTTPS 地址和公开证书
- `updates\win\x64\`：发布后的 Windows 安装包、更新清单和 blockmap 文件

**仅向员工分发 `Daocut-公司连接.json`，不要分发整个数据目录。** 员工在 Daocut 中导入该文件，应用使用其中证书进行正常的 TLS 证书、有效期与主机名校验。

首次管理员设置必须在服务器电脑上访问 `https://localhost:4715/admin`。浏览器会提示此证书未受系统信任，这是本服务生成的专用证书；确认地址为本机 localhost 后进入即可。局域网远端不能创建首位管理员。此后管理员可以创建员工、重置密码、启用或停用账号、处理反馈。

确保员工电脑可以访问选定 IP 的 TCP 4715 端口；按实际网络策略配置 Windows 防火墙的专用网络入站规则。运行期间服务器电脑须保持开机、不休眠；当前启动命令前台运行，关闭终端会停止服务。建议为服务器保留固定的局域网 IP。证书有效期为一年；更换 IP 或更新证书后须重新向员工分发连接文件。重复运行设置会保留仍有效且 IP 匹配的证书。

自定义数据目录可设置环境变量 `DAOCUT_COMPANY_DATA`。证书、数据库和测试临时数据都应保留在 D 盘。备份时先停止服务，再备份整个数据目录，恢复时保持 `auth-secret` 与数据库配套。

## 更新文件

将审核完成的发布文件复制到 `D:\Daocut\CompanyData\updates\win\x64`。`/updates/win/x64/<文件名>` 支持 GET、HEAD 和单区间 Range 请求；不提供目录列表，拒绝路径越界，只提供 `.exe`、`.zip`、`.blockmap`、`.yml`、`.yaml`、`.json` 文件。此路径无需账号即可下载公开给员工的安装包；不要放置私人素材、配置或密钥。

## 接口约定

所有公司接口的前缀为 `/api/company`，请求与返回使用 JSON。桌面主进程持有登录令牌，请求头使用 `Authorization: Bearer <token>`；管理台使用 HttpOnly 会话 Cookie。错误格式：`{"error":{"code":"...","message":"..."}}`。

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| `GET /health` | `{ok, setupRequired, service, version}` |
| `POST /setup` | 仅本机、仅首次；`{username,name,password}` → `{user}` |
| `POST /login` | `{username,password}` → `{user,token,expiresAt}` |
| `GET /session` | `{user,expiresAt}`，每次读取当前数据库会话及账号状态 |
| `POST /logout` | `{}` → `{ok:true}`，撤销当前会话 |
| `POST /password` | `{currentPassword,newPassword}`，修改本人密码并撤销其他会话 |
| `GET /users` | 管理员；`{users:[]}` |
| `POST /users` | 管理员；`{username,name,password}` → `{user}`，创建普通员工 |
| `POST /users/:id/password` | 管理员；`{password}`，重置并撤销该账号全部会话 |
| `POST /users/:id/status` | 管理员；`{enabled:boolean}`，停用会撤销该账号全部会话 |
| `POST /feedback` | `{category,title,description,appVersion?,platform?,diagnostics?,attachments?}` → `{feedback}` |
| `GET /feedback` | `{feedback:[]}`，员工仅本人，管理员全部，最近 500 条 |
| `GET /feedback/:id` | `{feedback}`，本人/管理员获取诊断详情与附件元数据 |
| `GET /feedback/:id/attachments/:attachmentId` | 本人/管理员获取图片，不提供公开附件链接 |
| `PATCH /feedback/:id` | 管理员；`{status,adminNote?}` → `{feedback}` |
| `POST /usage` | `{events:[...]}` → `{accepted,ids,syncedAt}`，身份取自登录会话 |
| `GET /usage?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=&model=` | 管理员查看全员/筛选员工，员工仅本人；按北京时间汇总 |
| `GET /quota` | 本人当前日/月额度、已用、预留、剩余；`{quota,timeZone}` |
| `GET /quotas` | 管理员；所有员工当前额度；`{quotas:[],timeZone}` |
| `PUT /users/:id/quota` | 管理员；`{dailyLimit,monthlyLimit}`，`null` 不限，`0` 禁止开始新 AI 请求；返回 `{quota,timeZone}` |
| `POST /quota/reserve` | `{id,model,reservedTokens,appVersion?}`，原子预留；返回 `{id,status,quota,timeZone}` |
| `POST /quota/settle` | `{event}`，`event` 与用量记录同结构且 `event.id` 等于预留请求 ID；返回 `{id,status,settled,quota,timeZone}` |
| `POST /quota/release` | `{id,reason:"not-sent"}`，仅客户端确认尚未调用模型 transport；返回 `{id,status,released,quota,timeZone}` |

`user` 为 `{id,username,name,role,enabled}`，`role` 为 `admin` 或 `user`。账号为 3–32 位英文字母、数字、点、下划线、短横线，首位须是字母或数字；密码为 10–128 字符。姓名最多 80 字符。

反馈 `category` 为 `bug`、`suggestion`、`other`；标题最多 120 字符，描述最多 8000 字符，版本最多 80 字符，系统最多 120 字符。`status` 为 `new`、`in_progress`、`resolved`、`closed`，处理说明最多 4000 字符，反馈人可见。反馈对象还含 `id,userId,userName,username,createdAt,updatedAt,hasDiagnostics,attachments`。列表和提交回执不返回诊断正文或图片二进制；详情接口才返回 `diagnostics`，管理台转义为纯文本显示。

诊断为 `{report:string,details?:string}`：基础报告最多 64 KiB、可选详细记录最多 256 KiB（UTF-8 字节数）。截图为 `[{name,mimeType,data}]`，`data` 为标准 Base64；最多 3 张，每张解码后最多 2 MiB，仅 PNG/JPEG/WebP，验证内容魔数。图片存在 SQLite BLOB，由受登录与反馈归属校验的接口读取。仅反馈提交的 JSON 上限为 10 MiB，用量提交为 256 KiB，原账号接口仍为 24 KiB。客户端在员工明确发送时才提交诊断/截图；公司服务不调用模型。

## 员工 Token 用量

记录结构：`{id,at,model,input,output,cacheRead,cacheWrite,reasoning,total,reported,incomplete,costs?,appVersion?}`。每批 1–200 条，`id` 是客户端稳定生成的 UUID/hash，`at` 是带时区的 ISO 时间，Token 字段须为非负安全整数。`input` 是标准化后的**未缓存输入**，`total = input + output + cacheRead + cacheWrite`；`reasoning` 已含在 `output` 内，不再额外相加。`reported=false` 会强制标记为不完整，缺失回执不能显示成完整的零消耗。

数据库以 `(userId,id)` 为唯一键：断网补传或重试不会累加同一事件；迟到的完整回执可更新缺失记录，旧的不完整重试不能覆盖完整记录。账户由会话决定，不接受客户端指定员工身份。只记录客户端启用功能后产生的事件，不扫描或导入历史日志，也不能统计同一 Key 在其他应用里的消耗。

查询默认本月，`from`/`to` 按 `Asia/Shanghai` 的含首尾日期转换 UTC 边界。返回 `{from,to,timeZone,totals,daily,employees,models,availableModels,lastSyncedAt}`，每组包含 `requests,reportedRequests,incompleteRequests,input,output,cacheRead,cacheWrite,reasoning,total,lastSyncedAt,costs?`；员工行还含 `userId,name,username`。员工“最近同步”独立于筛选期间，未上传过的员工显示“尚未同步”。`costs` 按货币分别汇总；组内任一事件缺价或用量不完整时不返回汇总金额，避免把部分金额当总费用。

首次启动自动增量迁移旧数据库，保留账号、会话与原有反馈。管理台“Token 用量”提供日期、员工、模型筛选和按员工/模型/日期的表格；“反馈收件箱”可按需查看诊断和截图并更新处理状态。

## 员工日/月 Token 额度

新账号和原有账号默认均不限额，不自动替管理员设置预算。管理员可在 Token 管理页分别设置员工的每日、每月额度；两者同时设置时，两项都须有剩余额度。按北京时间的自然日、自然月更新，无须定时清空数据库。额度口径与原用量统计相同：未缓存输入、输出、缓存读取和缓存写入相加；推理已含在输出中。Token 额度不是固定金额额度，各模型和缓存输入的单价可能不同。

`quota` 返回 `{userId,name,username,enabled,limited,daily,monthly}`；`daily`/`monthly` 各含 `{period,limit,used,reserved,remaining,resetAt}`，日期分别为 `YYYY-MM-DD` 和 `YYYY-MM`，`resetAt` 是带时区的 ISO 时刻，`limit`/`remaining` 为 `null` 表示不限额。历史用量筛选不会改变当前额度周期。上线前已有的当日、当月用量继续计入 `used`，不会因启用额度归零。

新版客户端在每个实际模型请求前，以输入估算加该请求最大输出申请预留；服务用 SQLite `IMMEDIATE` 事务检查并占用余额，避免同员工多个项目或电脑重复拿到同一份额度。身份始终取自登录会话；同一请求 ID 与相同参数可安全重试，参数改变会返回 `QUOTA_REQUEST_CONFLICT`，已经结算或释放的 ID 不会再次准许执行。额度不足返回业务错误 `QUOTA_EXCEEDED`，不撤销员工登录或删除已完成的剪辑。客户端应暂停新的 AI 请求，人工编辑、预览和导出仍可使用。

完整回执按实际 Token 写入原 `company_usage` 并结算预留；直接 `/quota/settle` 与原 `/usage` 迟到补传使用同一请求 ID，不重复累加。新预留请求的用量时间固定为服务端准入时间，跨日补传不会挪到新周期。部分回执保留未核实的预算，`已用 + 预留` 等于已知用量与原预留中的较大者，不将同一请求算两次；有预留的完整回执不能被同 ID 的较低数字或不一致数字改写。

断网、程序退出或取消后没有完整用量回执，并不表示没有产生费用，因此预留不按超时自动清零。完整回执补传后自动结算；真正尚未发送给模型的请求才可用 `reason:"not-sent"` 释放。已有任何回执的请求不能按未发送释放。没有回执的预留只影响请求所属的日/月周期；管理员可按实际情况调整额度，首版没有自动推断账单或人工核销功能。

**限制边界：** 模型仍由员工电脑持自己的 Key 直连，本服务不能约束该 Key 在其他软件、旧版客户端或被修改客户端中的消费。公司应使用已接入额度检查的新版 Daocut；受限账号的原生外部 Agent 入口须由新版客户端拒绝，不能声称服务端已经代理或拦截所有模型网络流量。额度检查失败时新版受限使用不能离线放行。输入是估算值，模型已经接收的请求仍可能计费，实际回执高于预留时照实记录并阻止后续请求，不承诺精确到最后 1 Token 的绝对封顶。仅上传用量数字、请求 ID、模型名和版本，不增加第二次模型审核。

合成额度测试：`node --test apps/company-service/test/quota.test.mjs`，覆盖默认不限、管理员权限、历史用量、并发预留、幂等、部分和迟到回执、重启恢复、上海跨日/月、未发送释放和实际超出估算；仅使用 D 盘临时数据。

## 实现与验证

密码处理、会话和账号管理复用固定版本 Better Auth `1.7.12` 的 username/admin/bearer 插件；Bearer 要求签名，关闭 Cookie 会话缓存。数据库使用 Better Auth 官方明确推荐的成熟驱动 `better-sqlite3 13.0.3`，迁移由 Better Auth 执行。该版本在本机 Node 24 的 Windows 预编译模块已通过加载与端到端测试，没有安装编译工具。证书由固定版本 `selfsigned 5.5.0` 生成。

合成测试覆盖账号权限、反馈可见范围、停用/重置/退出后会话失效、旧密码拒绝、TLS 信任及错误证书拒绝、下载范围与路径边界。测试使用 `D:\Daocut\CompanyTests` 下的随机目录，完成后清理，不包含真实员工账号或素材。

新增功能测试还覆盖重复/迟到用量、员工隔离、上海日期边界、缺失回执、费用完整性、附件格式与大小、旧数据库迁移。可设置 `DAOCUT_COMPANY_TEST_ROOT` 将所有合成数据放到项目 D 盘目录。`node apps/company-service/scripts/company-ui-smoke.mjs` 使用现成 Playwright/Chromium 验证用量筛选、错误/空态、诊断文本转义、截图、处理进度和手机布局，截图写到 `.release/company-ui-smoke/`；可用 `DAOCUT_TEST_BROWSER` 指定已安装 Chromium，不下载新运行时。

官方依据：[SQLite 适配器](https://better-auth.com/docs/adapters/sqlite)、[Admin 插件](https://better-auth.com/docs/plugins/admin)、[Username 插件](https://better-auth.com/docs/plugins/username)、[Bearer 插件](https://better-auth.com/docs/plugins/bearer)、[程序化迁移](https://better-auth.com/docs/concepts/database)、[selfsigned 证书生成](https://github.com/jfromaniello/selfsigned)。

## Windows 双击控制

从源码重新部署启动脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/company-service/scripts/Install-Launchers.ps1
```

默认生成 `D:\Daocut\CompanyService`，其中有 `启动公司服务.cmd`、`停止公司服务.cmd`、`打开管理台.cmd`。服务以隐藏 Node 进程运行，关闭启动提示窗口不会停止它；stdout 与 stderr 分别写入 `D:\Daocut\CompanyData\logs`。启动前通过专用证书验证 HTTPS health，防止重复启动。停止脚本只处理记录的 PID，并同时核验 Node 可执行文件、完整服务入口、命令行及创建时间，不结束其他 Node 程序。脚本不会配置系统自动启动、防火墙或系统证书信任。

复用边界：账号、密码哈希、会话签名与验证、停用和重置由 Better Auth 官方插件处理；SQL 驱动采用官方推荐的 better-sqlite3；X.509 证书由 selfsigned 生成。本项目自行编写的部分只有公司 API 适配、反馈记录、管理页面和本机启动脚本，没有自行实现密码算法、认证协议、X.509 或 AI 代理。
