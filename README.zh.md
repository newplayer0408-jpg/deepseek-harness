# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 非官方社区构建

DeepSeek Harness 的非官方社区构建。本项目及其二进制发行版并非由 DeepSeek 发布、认可或提供支持，基于开源 DeepSeek Harness 项目构建。社区版本的发行包发布在社区仓库 `newplayer0408-jpg/deepseek-harness`。

**更新社区构建。** 社区构建通过自己的更新通道升级，官方产品不会使用该通道。迁移到社区版 v0.2.1 需要手动操作：请前往社区 GitHub Releases 页面下载 v0.2.1 安装包并手动安装一次。社区版 v0.2 也在其列，因为它的更新检查无法读取发布清单，只会报告失败而不会提供更新——v0.2 不会自行升级到 v0.2.1。从 v0.2.1 开始，应用可以在需要时检查社区版更新——应用菜单中的“检查社区版更新…”入口会显示当前运行版本与最新已发布版本，如果存在更新的稳定版本，则提供下载。更新服务下载的是该版本 `latest-community.json` 清单所指向的安装包；只有在下载文件的 SHA-256 与清单中记录的摘要一致时，该下载才会被视为就绪。安装始终由你本人完成：社区构建不会静默安装更新，不会替你运行安装程序，也不会自行关闭应用。

**社区更新与上游状态相互独立。** 社区构建不会调用官方更新程序，也不会读取官方更新源。社区构建基于哪个官方版本，只会作为只读事实显示在“关于”对话框与“社区诊断”中，并且绝不会触发下载。

**已知限制。** 同一台机器上不能同时使用社区构建与官方 DeepSeek Harness 构建：请先关闭其中一个，再启动另一个。具体原因尚未定位。社区构建会把自己的应用数据与官方构建分开保存，因此安装、卸载或更新其中一方都不会影响另一方的状态。“社区诊断”会说明当前运行的构建，包括其更新来源与最近一次更新检查的结果，其版本信息显示在“关于”对话框中。

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
