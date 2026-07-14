# Vibe Plugins

用于统一维护多个独立插件脚本与本地开发工具的轻量 monorepo。

## 目录结构

```text
plugins/              每个插件一个独立目录
codex-usage-monitor/  macOS Codex 剩余用量实时气泡工具
shared/               多个插件共享的代码或资源
scripts/              仓库级构建、检查和发布脚本
```

## 新增插件

1. 复制 `plugins/_template` 并将目录改为插件名称。
2. 在插件自己的 `README.md` 中写明用途、安装方式和运行方法。
3. 将插件依赖、测试和配置保留在插件目录内。
4. 不要提交密钥；需要配置时提供 `.env.example`。

## 已收录插件与工具

- [订单消息助手](./plugins/order-message-assistant/README.md)：在快递助手 ERP 与抖店飞鸽之间处理蓝旗订单消息，并在成功后修改备注旗子状态。
- [Codex 用量气泡工具](./codex-usage-monitor/README.md)：在 macOS 屏幕右下角实时显示本机 Codex 剩余用量，颜色会随剩余比例从绿色渐变到红色。
- [扣子公开视频解析服务](./plugins/coze-video-parser/README.md)：使用自托管 `yt-dlp` 接口解析用户有权处理的公开视频链接，并提供可导入扣子的 OpenAPI 配置。

## 插件约定

- 目录名使用小写英文和连字符，例如 `text-cleaner`。
- 插件应尽量能够独立安装、测试和发布。
- 共用逻辑只有在两个以上插件实际使用时才移入 `shared/`。
- 提交前确保没有凭据、构建产物和本地缓存。

## 版本管理

各插件独立维护版本。发布标签建议使用：

```text
plugin-name-v1.0.0
```
