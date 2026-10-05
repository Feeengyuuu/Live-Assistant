# 来源、署名与修改声明 / Attribution and modification notice

本版本由 **EricWang** 开发维护，是 **Licardo（GitHub: L1cardo）** 的
[Live-Assistant](https://github.com/L1cardo/Live-Assistant) 的非官方派生版本。
感谢原作者及上游贡献者开源项目，为本版本提供多平台直播关注整合的基础。

This version is developed and maintained by **EricWang**. It is an independent,
unofficial derivative of **Live-Assistant**, created by **Licardo (L1cardo)** and
its contributors. Thank you to the upstream author and contributors for making
the original project available as free software.

- 原项目 / Upstream: https://github.com/L1cardo/Live-Assistant
- 原作者 / Original author: Licardo / L1cardo
- 当前版本开发维护 / Fork developer and maintainer: EricWang (GitHub: Feeengyuuu)
- 当前版本源码 / Fork source: https://github.com/Feeengyuuu/Live-Assistant
- 上游基点 / Upstream base: `v1.3.3`, commit `8b282d1a4588c6ebb2e92a7772288cf739190ae9`
- 本次修改整理日期 / Modification date: **2026-10-05**
- 本派生版本 / Fork release: **1.3.4**

## 主要修改 / Principal changes

- 按平台渐进加载、请求合并、错误分类、独立成功缓存和稳定卡片渲染。
- 斗鱼直播截图与 B站关键帧补充，保留图片回退。
- 设置页重构，明确保存/取消草稿，恢复默认保留收藏。
- 默认收起、按需加载的未开播名单，以及区分来源的上次直播时间。
- 键盘可访问性、测试、文档和独立 GitHub 发布流程。

Changes include progressive platform loading, request coalescing, error and
freshness handling, stable DOM rendering, live-frame enrichment, redesigned
settings, optional on-demand offline lists with timestamp provenance,
accessibility, regression tests, documentation and a separate release process.
See [the release notes](https://github.com/Feeengyuuu/Live-Assistant/releases/tag/v1.3.4)
and the repository history for details.

## 许可证 / License

本派生版本继续按 **GNU General Public License, version 3（GPLv3）** 发布。
完整许可证见随附的 [LICENSE](LICENSE)。原有署名和许可声明予以保留；
本声明不替换或更改 GPLv3。原项目名称、图标及既有截图的来源仍为上游项目，
不表示原作者为本派生版本提供背书或负责维护。

This derivative remains licensed under the **GNU General Public License,
version 3 (GPLv3)**. The complete license is included in [LICENSE](LICENSE).
Existing attribution and license notices are retained. This notice does not
replace or amend the license. The original project identity, icon and inherited
screenshot come from upstream; their use does not imply upstream endorsement
or maintenance of this fork.

The program is distributed without warranty, as described in the GPLv3.
The release ZIP contains the editable JavaScript/HTML source; the matching
tagged repository also provides development checks, tests and packaging scripts.
