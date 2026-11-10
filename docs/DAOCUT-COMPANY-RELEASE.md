# Daocut 公司 Windows 发布

员工使用管理员提供的安装包，不需要 GitHub 账号或仓库令牌。公司服务可通过 HTTPS 的 `/updates` 目录提供更新；员工自己的模型 API Key 和个人工程不经过更新目录。

公司服务的首次配置、账号管理和数据目录见[公司服务指南](../apps/company-service/README.md)。本地打包参数见[Windows 构建指南](../apps/desktop/scripts/BUILD-DAOCUT.md)。安装、更新或部署与源码开发验收分开进行。

## 生成安装包

`.github/workflows/daocut-windows.yml` 仅通过 `workflow_dispatch` 手动运行。选择经过检查的提交或标签，填写与 `apps/desktop/package.json` 一致的 `version`。工作流构建并上传 Actions 产物，不会创建 GitHub Release、推送代码或自动部署公司服务。

`updates_url` 使用公司 HTTPS 更新根地址，例如 `https://updates.example.com/updates`。留空时读取仓库变量 `DAOCUT_UPDATES_URL`；两处均为空则不配置自动更新。关闭更新的安装包不会自行发现后续地址，须由管理员单独分发启用更新的新安装包。

公司连接配置使用仓库 Secret 或 Variable `DAOCUT_COMPANY_PROFILE_JSON`。只允许以下字段：

- `name`：公司显示名称。
- `serverUrl`：公司 HTTPS 服务根地址，不带路径。
- `caPem`：本服务自签公共证书；使用公开可信证书时可留空。

不得包含私钥、管理员密码、员工令牌或模型 API Key。工作流将配置写入临时构建目录，验证后随安装包分发，不写回源码。员工版同时启用公司登录要求。

构建环境和依赖版本以工作流、`packageManager` 及锁文件为准。FFmpeg 使用仓库记录的校验值，Chromium 和 Electron 使用锁定依赖对应的版本。公司后台有独立安装目录和锁文件，不参与桌面依赖部署。

下载 `Daocut-Windows-<版本>` 产物。配置更新时，完整保留 builder 生成的安装包、`.blockmap` 和 `latest.yml`，不要手工重写文件名或哈希。

## 发布到公司更新目录

构建器会在更新根地址后追加 `/win/x64`，服务对应目录为：

```text
/updates/win/x64/
  Daocut-Setup-<version>-x64.exe
  Daocut-Setup-<version>-x64.exe.blockmap
  latest.yml
```

从仓库根目录调用已有发布器，并将示例数据目录替换为实际公司服务目录：

```powershell
node apps/desktop/scripts/publish-lan-update.mjs --from=apps/desktop/.release/win-x64/out --data-dir=D:/Daocut/CompanyData
```

从 GitHub Actions 下载的产物，应将 `--from` 指向完整解压目录。发布器校验 manifest、安装包 SHA-512 和大小，拒绝相同版本、降级或同名不同内容。它先复制安装包与 `.blockmap`，最后原子替换 `latest.yml`；失败时保留原 feed。该命令不替员工启动安装。

服务须支持 `GET`、`HEAD` 和单区间 `Range`，直接返回文件，不返回网页登录页。客户端 generic provider 使用 `useMultipleRangeRequest: false`。保留上一版文件，供已开始的下载继续使用；`latest.yml` 需要重新验证缓存或禁用缓存。

公司更新目录的写入权限应仅给发布管理员。更新 URL 和客户端不包含 GitHub 令牌。自签连接只信任配置中的服务主机及匹配证书，并继续检查证书有效期和主机名；其他目标使用系统证书验证。更换服务证书后，需要按公司配置流程向员工分发新连接文件，不修改系统信任来绕过验证。

## 先验收再分发

1. 在独立测试电脑上确认安装、公司登录、退出和会话恢复。
2. 使用合成素材确认工程打开、个人编辑、保存重开和导出。
3. 发布较高版本的测试更新，核对版本发现、下载进度、退出安装和重开结果。
4. 验证更新不可达，以及 AI 任务或导出进行中时的退出保护。
5. 核对原工程、员工配置和旧版本数据保留后，再扩大分发。

上述步骤是每次发布的检查要求，不代表当前安装包已经完成真实环境验收。签名、公司地址、证书和部署权限由具体发布环境提供。保留仓库中的许可证、第三方组件和 FFmpeg 来源说明。

更新机制参考 [electron-builder 自动更新文档](https://www.electron.build/v26/docs/features/auto-update/)；源码开发和模拟测试入口见[开发说明](DEVELOPMENT.md)。
