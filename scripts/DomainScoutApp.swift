import Cocoa
@preconcurrency import WebKit

struct DomainScoutConfig {
  let projectRoot: String
  let port: Int
  let nodeBin: String
  let logDir: String

  static func load() -> DomainScoutConfig {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    var values: [String: Any] = [:]

    if let url = Bundle.main.url(forResource: "DomainScoutConfig", withExtension: "plist"),
       let data = try? Data(contentsOf: url),
       let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
       let dict = plist as? [String: Any] {
      values = dict
    }

    let root = values["ProjectRoot"] as? String ?? "\(home)/Desktop/Projects/DomainScout"
    let node = values["NodeBin"] as? String ?? "/opt/homebrew/bin/node"
    let logDir = values["LogDir"] as? String ?? "\(home)/Library/Logs/DomainScout"

    let portValue = values["Port"]
    let port: Int
    if let number = portValue as? NSNumber {
      port = number.intValue
    } else if let string = portValue as? String, let parsed = Int(string) {
      port = parsed
    } else {
      port = 3737
    }

    return DomainScoutConfig(projectRoot: root, port: port, nodeBin: node, logDir: logDir)
  }
}

final class DomainScoutApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  private let config = DomainScoutConfig.load()
  private let launchAgentLabel = "com.hamp.domainscout"
  private var window: NSWindow!
  private var webView: WKWebView!
  private var statusLabel: NSTextField!
  private var serverProcess: Process?
  private var serverStartedByApp = false
  private var logHandles: [FileHandle] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    log("applicationDidFinishLaunching")
    buildMenu()
    buildWindow()
    startServerAndLoad()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationWillTerminate(_ notification: Notification) {
    if serverStartedByApp, let process = serverProcess, process.isRunning {
      process.terminate()
    }

    for handle in logHandles {
      try? handle.close()
    }
  }

  private func buildMenu() {
    let mainMenu = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Quit DomainScout", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    mainMenu.addItem(appItem)

    let viewItem = NSMenuItem()
    let viewMenu = NSMenu(title: "View")
    viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
    viewItem.submenu = viewMenu
    mainMenu.addItem(viewItem)

    NSApp.mainMenu = mainMenu
  }

  private func buildWindow() {
    let configuration = WKWebViewConfiguration()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

    if #available(macOS 11.0, *) {
      let pagePreferences = WKWebpagePreferences()
      pagePreferences.allowsContentJavaScript = true
      configuration.defaultWebpagePreferences = pagePreferences
    }

    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.translatesAutoresizingMaskIntoConstraints = false

    statusLabel = NSTextField(labelWithString: "Starting DomainScout...")
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    statusLabel.font = NSFont.systemFont(ofSize: 15, weight: .medium)
    statusLabel.textColor = NSColor.secondaryLabelColor

    let contentView = NSView()
    contentView.addSubview(webView)
    contentView.addSubview(statusLabel)

    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      webView.topAnchor.constraint(equalTo: contentView.topAnchor),
      webView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),

      statusLabel.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
      statusLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
    ])

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "DomainScout"
    window.minSize = NSSize(width: 1040, height: 680)
    window.collectionBehavior.insert(.fullScreenPrimary)
    window.contentView = contentView
    window.center()
    window.makeKeyAndOrderFront(nil)

    NSApp.activate(ignoringOtherApps: true)
  }

  private func startServerAndLoad() {
    log("checking server readiness")
    if isServerListening() {
      log("server is already listening")
      loadDomainScout()
      return
    }

    let kicked = kickStartLaunchAgent()
    log("launch agent kickstart result: \(kicked)")
    if kicked {
      waitForServer(attempt: 0)
      return
    }

    do {
      log("starting server directly")
      try startServer()
      waitForServer(attempt: 0)
    } catch {
      log("direct server start failed: \(error.localizedDescription)")
      showStatus("Could not start DomainScout server: \(error.localizedDescription)")
    }
  }

  private func startServer() throws {
    guard let nodeBin = resolveNodeBin() else {
      throw NSError(domain: "DomainScout", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "Node was not found. Reinstall the app after installing Node."
      ])
    }

    try FileManager.default.createDirectory(atPath: config.logDir, withIntermediateDirectories: true)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodeBin)
    process.currentDirectoryURL = URL(fileURLWithPath: config.projectRoot)
    process.arguments = ["server/index.js"]

    var env = ProcessInfo.processInfo.environment
    env["PORT"] = String(config.port)
    env["DOMAINSCOUT_SKIP_DB_MAINTENANCE"] = "1"
    env["DOMAINSCOUT_TLD_ACCURACY_WORKER"] = "1"
    env["TLDS_WORKER_SCOPE"] = "auction"
    env["TLDS_WORKER_BATCH"] = "25"
    env["TLDS_WORKER_DNS_CONCURRENCY"] = "160"
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    process.environment = env

    if let stdout = appendHandle(path: "\(config.logDir)/server.log") {
      process.standardOutput = stdout
    }
    if let stderr = appendHandle(path: "\(config.logDir)/server.err.log") {
      process.standardError = stderr
    }

    try process.run()
    log("direct server process started: \(process.processIdentifier)")
    serverProcess = process
    serverStartedByApp = true
  }

  private func kickStartLaunchAgent() -> Bool {
    let target = "gui/\(getuid())/\(launchAgentLabel)"
    return runCommand("/bin/launchctl", ["kickstart", "-k", target]) == 0
  }

  private func runCommand(_ executable: String, _ arguments: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = Pipe()
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus
    } catch {
      return -1
    }
  }

  private func isServerListening() -> Bool {
    runCommand("/usr/sbin/lsof", ["-nP", "-iTCP:\(config.port)", "-sTCP:LISTEN"]) == 0
  }

  private func resolveNodeBin() -> String? {
    let candidates = [
      config.nodeBin,
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ].filter { !$0.isEmpty }

    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  private func appendHandle(path: String) -> FileHandle? {
    if !FileManager.default.fileExists(atPath: path) {
      FileManager.default.createFile(atPath: path, contents: nil)
    }

    guard let handle = FileHandle(forWritingAtPath: path) else { return nil }
    handle.seekToEndOfFile()
    logHandles.append(handle)
    return handle
  }

  private func waitForServer(attempt: Int) {
    checkServerReady { [weak self] ready in
      guard let self else { return }
      DispatchQueue.main.async {
        if ready {
          self.log("server ready after \(attempt) attempts")
          self.loadDomainScout()
        } else if attempt < 160 {
          self.showStatus("Starting DomainScout server...")
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.waitForServer(attempt: attempt + 1)
          }
        } else {
          self.log("server did not become ready")
          self.showStatus("DomainScout server did not become ready. Check \(self.config.logDir)/server.err.log.")
        }
      }
    }
  }

  private func checkServerReady(completion: @escaping (Bool) -> Void) {
    completion(isServerListening())
  }

  private func loadDomainScout() {
    guard let url = URL(string: "http://127.0.0.1:\(config.port)/") else { return }
    log("loading \(url.absoluteString)")
    showStatus("Loading DomainScout...")
    webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
  }

  private func log(_ message: String) {
    try? FileManager.default.createDirectory(atPath: config.logDir, withIntermediateDirectories: true)
    let path = "\(config.logDir)/app.log"
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    guard let data = line.data(using: .utf8) else { return }

    if !FileManager.default.fileExists(atPath: path) {
      FileManager.default.createFile(atPath: path, contents: nil)
    }

    guard let handle = FileHandle(forWritingAtPath: path) else { return }
    handle.seekToEndOfFile()
    handle.write(data)
    try? handle.close()
  }

  private func showStatus(_ message: String) {
    statusLabel.stringValue = message
    statusLabel.isHidden = false
  }

  @objc private func reloadPage() {
    webView.reload()
  }

  private func isLocalDomainScoutURL(_ url: URL) -> Bool {
    guard let host = url.host else { return true }
    let localHosts = ["localhost", "127.0.0.1", "::1"]
    return localHosts.contains(host) && (url.port == nil || url.port == config.port)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    statusLabel.isHidden = true
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    showStatus("DomainScout failed to load: \(error.localizedDescription)")
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showStatus("DomainScout failed to load: \(error.localizedDescription)")
  }

  func webView(_ webView: WKWebView,
               decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.allow)
      return
    }

    if isLocalDomainScoutURL(url) {
      decisionHandler(.allow)
      return
    }

    if url.scheme == "http" || url.scheme == "https" {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
      return
    }

    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView,
               createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url, !isLocalDomainScoutURL(url) {
      NSWorkspace.shared.open(url)
    }
    return nil
  }
}

let app = NSApplication.shared
let delegate = DomainScoutApp()
app.delegate = delegate
app.run()
