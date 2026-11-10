<p align="center">
  <img src="docs/logo-light.svg#gh-light-mode-only" alt="Daocut" height="72">
  <img src="docs/logo-dark.svg#gh-dark-mode-only" alt="Daocut" height="72">
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

# Daocut

Daocut 是用于直播商品切片的本地 AI 视频剪辑工作台，把时间轴编辑、AI 对话、商品话术分析和结构视频方案放在一起。Windows 公司版支持员工账号、问题反馈和可选的公司内网更新。模型密钥和个人工程保存在各自电脑上。

## 商品切片流程

1. 先拆整场直播的商品讲解，核对商品名称和起止范围。
2. 选择某个商品的**一次讲解**进行分析，优先复用已保存的结果。同一商品返场时另选一次讲解。
3. 点击「拼结构」，使用已确认的话术和已保存的画面核查结果组合方案。保留完整原话，列出规则范围内的有效组合，信息不足时提示核对。
4. 在右侧查看和预览方案。预览不改变当前时间轴；点击「编辑这条」才打开个人独立草稿，各条修改分别保存，切换和重开后继续编辑。
5. 勾选方案，通过已有导出入口分别导出剪映草稿；有个人修改时优先使用对应草稿。

剪辑器仍支持视频、图片、音频、HTML 场景、字幕和原有导出格式。工程是包含 `film.html` 与素材的文件夹，详见[使用手册](packages/daocut/MANUAL.md)和[工程格式](packages/daocut/SPEC.md)。

最新的拼结构与看图核查流程已用隔离工程、合成音画和模拟模型返回验证；真实模型判断准确率及真实共享存储仍需另行验收。[开发说明](docs/DEVELOPMENT.md)记录了实现位置和已验证范围。

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

## 一起开发

先读[协作指南](CONTRIBUTING.md)和[开发说明](docs/DEVELOPMENT.md)，通过 Pull Request 提交改动，并说明验证结果。问题反馈请到 [Daocut Issues](https://github.com/stonele01/Daocut/issues)。

## 许可

源码采用 [MIT 许可证](LICENSE)，分发时须保留版权和许可声明。第三方组件说明见 [THIRD_PARTY_NOTICES.md](packages/daocut/THIRD_PARTY_NOTICES.md)，适用的上游商标声明保留在 [TRADEMARK.md](TRADEMARK.md)。
