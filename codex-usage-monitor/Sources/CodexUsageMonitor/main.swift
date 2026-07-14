import Cocoa
import Foundation

struct UsageSnapshot {
    let usedPercent: Double
    let windowMinutes: Int
    let resetDate: Date?
    let planType: String?
    let observedAt: Date

    var remainingPercent: Double { max(0, 100 - usedPercent) }
}

enum UsageReader {
    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func latestSnapshot(in sessionsRoot: URL) -> UsageSnapshot? {
        let fileManager = FileManager.default
        guard let enumerator = fileManager.enumerator(
            at: sessionsRoot,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return nil }

        var candidates: [(url: URL, modified: Date)] = []
        for case let url as URL in enumerator where url.pathExtension == "jsonl" {
            let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
            guard values?.isRegularFile == true else { continue }
            candidates.append((url, values?.contentModificationDate ?? .distantPast))
        }

        // Recent session files contain rate-limit events. Keeping the scan bounded makes
        // updates inexpensive for users with a long Codex history.
        let recentFiles = candidates.sorted { $0.modified > $1.modified }.prefix(40)
        var newest: UsageSnapshot?
        for file in recentFiles {
            guard let data = try? Data(contentsOf: file.url),
                  let text = String(data: data, encoding: .utf8) else { continue }
            for line in text.split(whereSeparator: \.isNewline).reversed() {
                guard line.contains("\"type\":\"token_count\""),
                      line.contains("\"rate_limits\"") else { continue }
                guard let snapshot = parse(String(line)) else { continue }
                if newest == nil || snapshot.observedAt > newest!.observedAt {
                    newest = snapshot
                }
                break
            }
        }
        return newest
    }

    private static func parse(_ line: String) -> UsageSnapshot? {
        guard let data = line.data(using: .utf8),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = record["payload"] as? [String: Any],
              let rateLimits = payload["rate_limits"] as? [String: Any],
              let primary = rateLimits["primary"] as? [String: Any],
              let usedPercent = primary["used_percent"] as? Double,
              let windowMinutes = primary["window_minutes"] as? Int,
              let timestamp = record["timestamp"] as? String,
              let observedAt = iso8601.date(from: timestamp) else { return nil }

        let resetDate: Date?
        if let seconds = primary["resets_at"] as? TimeInterval {
            resetDate = Date(timeIntervalSince1970: seconds)
        } else if let seconds = primary["resets_at"] as? Int {
            resetDate = Date(timeIntervalSince1970: TimeInterval(seconds))
        } else {
            resetDate = nil
        }

        return UsageSnapshot(
            usedPercent: usedPercent,
            windowMinutes: windowMinutes,
            resetDate: resetDate,
            planType: rateLimits["plan_type"] as? String,
            observedAt: observedAt
        )
    }
}

final class BubbleView: NSView {
    var value = "—" { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .semibold),
            .foregroundColor: NSColor.white
        ]
        let textSize = (value as NSString).size(withAttributes: attributes)
        let textRect = NSRect(
            x: bounds.midX - textSize.width / 2,
            y: bounds.midY - textSize.height / 2,
            width: textSize.width,
            height: textSize.height
        )
        (value as NSString).draw(in: textRect, withAttributes: attributes)
    }
}

final class UsageBadgePanel: NSPanel {
    private let bubble = BubbleView()

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 58, height: 58),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        ignoresMouseEvents = true

        bubble.frame = contentView!.bounds
        bubble.autoresizingMask = [.width, .height]
        bubble.wantsLayer = true
        bubble.layer?.backgroundColor = NSColor(
            calibratedRed: 0.03,
            green: 0.16,
            blue: 0.28,
            alpha: 0.97
        ).cgColor
        bubble.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
        bubble.layer?.borderWidth = 1
        bubble.layer?.cornerRadius = 29
        bubble.layer?.masksToBounds = true
        contentView = bubble

    }

    func update(value: String, remaining: Int?, toolTip: String) {
        bubble.value = value
        bubble.toolTip = toolTip
        bubble.layer?.backgroundColor = color(forRemaining: remaining).cgColor
    }

    private func color(forRemaining remaining: Int?) -> NSColor {
        guard let remaining else {
            return NSColor(calibratedWhite: 0.28, alpha: 0.72)
        }

        // 100% -> green (120°); 10% -> red (0°); lower values remain red.
        let clamped = min(100, max(10, remaining))
        let hue = (CGFloat(clamped - 10) / 90) / 3
        return NSColor(
            calibratedHue: hue,
            saturation: 0.72,
            brightness: 0.68,
            alpha: 0.72
        )
    }
}

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let refreshInterval: TimeInterval = 10
    private let sessionsRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".codex/sessions", isDirectory: true)
    private let badgePanel = UsageBadgePanel()
    private var timer: Timer?

    static func runOnce() {
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/sessions", isDirectory: true)
        guard let snapshot = UsageReader.latestSnapshot(in: root) else {
            print("No Codex usage record found in \(root.path)")
            return
        }
        let remaining = Int(snapshot.remainingPercent.rounded())
        print("Codex remaining: \(remaining)% (used \(Int(snapshot.usedPercent.rounded()))%)")
        if let resetDate = snapshot.resetDate {
            print("Resets: \(ISO8601DateFormatter().string(from: resetDate))")
        }
    }

    static func main() {
        if CommandLine.arguments.contains("--once") {
            runOnce()
            return
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: refreshInterval, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    private func refresh() {
        guard let snapshot = UsageReader.latestSnapshot(in: sessionsRoot) else {
            badgePanel.update(
                value: "—",
                remaining: nil,
                toolTip: "未找到本机 Codex 用量记录"
            )
            positionBadge()
            badgePanel.orderFrontRegardless()
            return
        }

        let remaining = Int(snapshot.remainingPercent.rounded())
        badgePanel.update(
            value: "\(remaining)%",
            remaining: remaining,
            toolTip: "来自本机最新 Codex 限额日志；每 \(Int(refreshInterval)) 秒刷新。"
        )
        positionBadge()
        badgePanel.orderFrontRegardless()
    }

    private func positionBadge() {
        // Fixed screen placement deliberately avoids Accessibility permission. It is
        // intended for a maximized Codex window and does not attempt to inspect it.
        let screen = NSScreen.main ?? NSScreen.screens[0]
        badgePanel.setFrameOrigin(
            NSPoint(
                x: screen.visibleFrame.maxX - badgePanel.frame.width - 70,
                y: screen.visibleFrame.minY + 70
            )
        )
    }
}
