# 0.2.51 上线准备审查

审查日期：2026-11-13。已验收的本机编辑流程可以小范围使用；功能修复完成不等于所有电脑、共享盘和升级路径都完成上线验收。本次做源码同步和发布准备调查，没有分发安装包、修改公司服务或接入新的遥测服务。

## 本次同步已处理

- 同步 0.2.51 源码、测试、版本记录和提示词基准，保留生产素材、个人工程及现场记录在本地。
- 补齐根 `package.json`，使新拉取的仓库能使用文档中的 pnpm 命令与固定版本。
- 本次 190 项针对性源码测试、四个 TypeScript 项目检查通过。提交前 141 个源码／测试文件与先前验收构建输入一致；包内和真实 UI 验收范围见 [0.2.51 说明](HANDOFF-0.2.51.md)。
- GitHub 干净环境首次检查发现公司服务联动测试缺少桌面依赖，已为该作业补上独立的锁定 workspace 安装；服务本身仍使用自己的 npm 锁文件。
- 历史扫描命中一条用于测试反馈脱敏的明确假密钥。只对白名单中的精确字符串和精确测试文件放行；完整可达历史扫描仍开启，本地重扫无发现。

GitHub 检查的最终状态以 [PR #1](https://github.com/stonele01/Daocut/pull/1) 和 [Actions](https://github.com/stonele01/Daocut/actions/workflows/ci.yml) 为准，不以工作流文件存在代替执行通过。

## 上线前必须先做

| 优先级 | 实际发现／缺少的证据 | 完成标准 |
| --- | --- | --- |
| 最高 | **工程备份漏 AI 方案记录**：`project-backup.mjs` 的目录白名单没有 `ai-structure-plans`，而方案保存在该目录。隔离合成工程实测：字幕和商品分析进入备份，方案文件没有进入 | 修复备份与恢复；在另一独立目录恢复后，全部方案、版本、人工范围、个人副本和字幕仍可读取、编辑、导出，不重新付费生成 |
| 高 | 新电脑安装、旧版本升级和回退尚未在本轮完成实机验收 | 普通员工权限安装、登录、打开工程、保存重开、导出均成功；升级失败可恢复程序及匹配的数据备份 |
| 高 | 本轮播放验收是单机、单组素材；还不能代替长直播和多机共享试用 | 选两台代表性电脑和少量员工，完成完整业务流程；覆盖长视频、连续多次编辑、NAS 断连重连、空间不足、任务中断。工程不损坏，恢复不重复提交付费任务，内存／磁盘占用不持续失控 |
| 高 | CI 已有类型、授权、更新、公司服务和密钥检查，但未自动覆盖全部新商品流程和实际播放器 | 将现成关键回归用例加入 CI；发布包另测冷启动字幕、跨片段播放、回拖、保存重开和导出。保留实际操作验收 |
| 中 | 公司服务已有启动器、日志和健康接口；本次没有验证服务器重启后的自动恢复及备份计划 | 服务器重启、服务异常退出和磁盘异常能被发现；数据库与认证密钥成套备份，做一次恢复演练；NAS 原片独立备份 |

备份问题本次只定位和复现，**尚未修改产品实现**。工程备份也不会复制共享盘上的引用原片，不能替代 NAS 原片备份。当前发布器拒绝低版本覆盖，因此不能把“把旧版本写回更新清单”当作现成回退方案；需演练管理员恢复或更高版本的修复包。

相关实现：[工程备份](../packages/daocut/studio/server/project-backup.mjs)、[方案保存](../packages/daocut/studio/server/ai-structure-plans.mjs)、[内网发布器](../apps/desktop/scripts/publish-lan-update.mjs)、[公司服务](../apps/company-service/README.md)。

## GitHub 上的现成做法与取舍

| 方案 | 对本项目的用途 | 建议 |
| --- | --- | --- |
| [GitHub 必需状态检查](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | 把通过 CI 作为主分支合并条件 | 优先使用现有 Actions；分支保护的实际启用状态本次未核实，不声称已经开启 |
| [Microsoft Playwright](https://github.com/microsoft/playwright) | 自动点击、打开工程、保存、播放和导出回归 | 复用现有依赖与用例。官方 [Electron 接口仍标为实验性](https://playwright.dev/docs/api/class-electron)，安装包仍保留实际操作验收 |
| [Gitleaks](https://github.com/gitleaks/gitleaks) 与 [Dependabot](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts) | 前者查误提交的密钥；后者提示依赖的已知漏洞 | Gitleaks 已使用；Dependabot 设置需核实，不自动升级 Electron 等关键依赖，升级后做回归 |
| [OpenSSF Scorecard](https://github.com/ossf/scorecard) | 检查分支保护、依赖固定、CI、发布等仓库维护实践 | 可作为补充审查工具；分数不代表播放流畅、业务正确或长期运行稳定，无须为评分搭新平台 |
| [Sentry Electron SDK](https://github.com/getsentry/sentry-electron) | 收集主进程、渲染进程异常与原生崩溃 | 当前先复用已有日志和员工主动反馈。多人使用后若定位成本高，再评估接入；需要决定数据发送范围、存储位置与成本 |
| [electron-updater](https://www.electron.build/v26/docs/features/auto-update/) | 安装更新、进度及分批发布能力 | 项目已经使用，无须换更新系统；优先验证真实安装应用的升级路径 |

Electron 官方还提供 [安全检查清单](https://www.electronjs.org/docs/latest/tutorial/security)。源码已有上下文隔离、沙箱、关闭 Node 集成、导航限制和 IPC 来源检查，但这不是完整安全审计结论。当前构建脚本明确关闭 Windows 可执行文件签名；正式广泛分发前应决定可信签名方案，并完成目标机器的安装验证。TLS 和文件哈希不等于安装包代码签名。

## 推荐顺序

先补工程备份遗漏并完成一次恢复，再把已有业务回归接入 CI；随后在两台电脑上做安装、升级、回退、长视频和共享盘试用。通过后逐步扩大使用。集中监控和 Scorecard 可以后补，不需要先部署一整套新的运维平台。
