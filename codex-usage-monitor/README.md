# Codex Usage Monitor

macOS Codex 对话区右下角的用量气泡：在 Codex 激活时，显示本机最近记录的**剩余用量百分比**，并每 10 秒刷新一次。它不创建 macOS 菜单栏项目，也不需要辅助功能授权。

它只读取 `~/.codex/sessions` 中由 Codex 写入的限额事件；不调用未公开接口，不读取或上传 `auth.json`，也不会影响 Codex 的用量。

## 运行

需要 macOS 和 Xcode Command Line Tools（含 Swift）。在本目录执行以下命令：

```bash
swift build
nohup .build/arm64-apple-macosx/debug/CodexUsageMonitor >/tmp/codex-usage-monitor.log 2>&1 &
```

第二行会在后台启动，不会额外打开终端窗口。更新程序后，先执行 `pkill -x CodexUsageMonitor`，再重新运行第二行。

Codex 对话区右下角会出现一个半透明圆形气泡，例如 `45%`。数字按字符实际尺寸严格居中；剩余 100% 时为绿色，随后随用量降低渐变至红色，剩余 10% 或更低时保持红色。它可以与原有包包宠物同时使用，但不会改动原有宠物，也不会显示在 macOS 顶部菜单栏。

气泡使用固定屏幕坐标，因此不需要辅助功能授权。它适用于最大化的 Codex 窗口；拖动或缩放窗口时，气泡不会跟随窗口移动。

先验证读取是否正常：

```bash
swift run CodexUsageMonitor --once
```

## 开机自动启动（可选）

先构建 Release 版本：

```bash
swift build -c release
```

然后将 `com.local.codex-usage-monitor.plist.example` 里的 `PROGRAM_PATH` 替换为本机绝对路径，再保存到 `~/Library/LaunchAgents/com.local.codex-usage-monitor.plist` 并执行：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.codex-usage-monitor.plist
```

## 注意

展示的数据来自本机最新的 Codex 会话日志，因此会在 Codex 写入新的用量事件后更新。Codex 的“使用量”弹窗来自服务端快照，两者在某些时刻可能短暂不同；这个工具不会把本地日志值伪装成弹窗的权威数据。日志格式不是公开稳定 API；若未来 Codex 改动了记录格式，工具会显示 `Codex —`，但不会触碰你的账号数据。
