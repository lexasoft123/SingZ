import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  // Retain the React runtime and its root controller across scene reconnection.
  // A fold/resize changes the scene's geometry, never the audio runtime.
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  var rootViewController: UIViewController?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Singers read lyrics hands-free — never dim or lock while SingZ is up.
    // iOS re-enables the idle timer automatically while backgrounded.
    application.isIdleTimerDisabled = true

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    self.launchOptions = launchOptions

    return true
  }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let app = UIApplication.shared.delegate as? AppDelegate,
          let factory = app.reactNativeFactory else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    if let controller = app.rootViewController {
      window.rootViewController = controller
      window.makeKeyAndVisible()
    } else {
      factory.startReactNative(
        withModuleName: "SingZPlayer",
        in: window,
        launchOptions: app.launchOptions
      )
      app.rootViewController = window.rootViewController
    }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    // Release the scene's window, retaining the single React tree in AppDelegate.
    window?.rootViewController = nil
    window = nil
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func createRootViewController() -> UIViewController {
    SingZRootViewController()
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

// Custom React headers don't get UIKit's automatic bar displacement. Publish
// scene-local occlusions as safe-area insets so the existing RN safe-area
// provider updates both routes and navigation after a fold or window resize.
class SingZRootViewController: UIViewController {
  // Inherit UIKit/react-native-screens orientation delegation. View bounds may
  // be zero at connection or narrow during a resize; they must never decide
  // which rotations UIKit is allowed to perform. Layout adapts to bounds in JS.
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    updateReservedInsets()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    updateReservedInsets()
  }

  private func updateReservedInsets() {
    guard #available(iOS 27.1, *), let scene = view.window?.windowScene,
          !view.bounds.isEmpty else { return }

    // Subtract our previous contribution to avoid accumulating it each layout.
    let current = additionalSafeAreaInsets
    let base = UIEdgeInsets(
      top: max(0, view.safeAreaInsets.top - current.top),
      left: max(0, view.safeAreaInsets.left - current.left),
      bottom: max(0, view.safeAreaInsets.bottom - current.bottom),
      right: max(0, view.safeAreaInsets.right - current.right)
    )
    let safeFrame = view.bounds.inset(by: base)
    // Xcode 27.1 ships this API with Swift 6.4. Runtime availability alone
    // cannot hide unknown SDK members from older compilers used by CI.
#if compiler(>=6.4)
    var frames = view.reservedRegions(kind: .occlusion).map(\.frame)
#else
    var frames: [CGRect] = []
#endif
    if let statusFrame = scene.statusBarManager?.statusBarFrame, !statusFrame.isEmpty {
      frames.append(view.convert(statusFrame, from: scene.coordinateSpace))
    }
    var required = base
    for frame in frames {
      let rect = frame.intersection(view.bounds)
      guard !rect.isNull, rect.intersects(safeFrame) else { continue }
      if rect.minX >= view.bounds.midX {
        required.right = max(required.right, view.bounds.maxX - rect.minX)
      } else if rect.maxX <= view.bounds.midX {
        required.left = max(required.left, rect.maxX - view.bounds.minX)
      } else if rect.midY < view.bounds.midY {
        required.top = max(required.top, rect.maxY - view.bounds.minY)
      } else {
        required.bottom = max(required.bottom, view.bounds.maxY - rect.minY)
      }
    }
    let next = UIEdgeInsets(top: required.top - base.top, left: required.left - base.left,
                            bottom: required.bottom - base.bottom, right: required.right - base.right)
    if next != current { additionalSafeAreaInsets = next }
  }
}
