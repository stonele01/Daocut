<p align="center">
  <img src="docs/logo-light.svg#gh-light-mode-only" alt="Daocut" height="72">
  <img src="docs/logo-dark.svg#gh-dark-mode-only" alt="Daocut" height="72">
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

# Daocut

Daocut 是用于直播商品切片的本地 AI 视频剪辑工作台，把时间轴编辑、AI 对话、商品话术分析和结构视频方案放在一起。Windows 公司版支持员工账号、问题反馈和可选的公司内网更新。模型密钥和个人工程保存在各自电脑上。

## 商品切片流程

1. 使用「转写并拆品」准备整场直播。可人工修改商品名称和范围，后续分析使用已保存的人工范围。
2. 选择某个商品的**一次讲解**进行分析，优先复用已保存的结果。同一商品返场时另选一次讲解。
3. 点击「拼结构」，每条包含产品介绍、卖点、真实报价和逼单，价格机制与福利机制分开。同一开头最多三条有实质区别的方案，素材不足就少出。
4. 在右侧查看和预览方案。预览不改变当前时间轴；点击「编辑这条」才打开个人独立草稿，各条修改分别保存，切换和重开后继续编辑。
5. 勾选方案，通过已有导出入口分别导出剪映草稿；有个人修改时优先使用对应草稿。

剪辑器仍支持视频、图片、音频、HTML 场景、字幕和原有导出格式。工程是包含 `film.html` 与素材的文件夹，详见[使用手册](packages/daocut/MANUAL.md)和[工程格式](packages/daocut/SPEC.md)。

当前版本为 **0.2.51**。已完成包内测试、实际桌面播放与拖动、冷启动字幕和一组真实分析／拼结构验收。不同电脑、长视频与多人共享场景还需上线验收。[版本说明](docs/HANDOFF-0.2.51.md)记录了准确的验证范围，[开发说明](docs/DEVELOPMENT.md)记录实现位置。

## 使用与开发

员工使用管理员提供的安装包。部署方法见[公司版发布说明](docs/DAOCUT-COMPANY-RELEASE.md)和[公司服务指南](apps/company-service/README.md)。

源码开发使用 Node 24（最低 22.18）、pnpm 9.15.9、Git、FFmpeg 和 ffprobe：

```sh
git clone https://github.com/stonele01/Daocut.git
cd Daocut
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

启动网页或桌面开发环境前，按[协作指南](CONTRIBUTING.md)配置独立的工程库、共享配置目录、导出目录和端口，避免默认设置复用已有工程库。测试使用模拟返回和合成素材。
