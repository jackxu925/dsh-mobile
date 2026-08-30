// dsh-mobile host entry: serves the phone-optimized web surface at /m.
// The surface itself talks to the harness's standard /api (same origin, same
// trust fence as the desktop GUI), so this plugin's only job is shipping the
// static assets — with a self-healing mount in case the webServer instance is
// re-created after us (pattern cribbed from dsh-feishu-chat).
import { mountRoutes } from './routes.js'

export async function apply(ctx) {
  const TAG = '[dsh-mobile]'
  let disposed = false
  const log = (...a) => { if (!disposed) console.log(TAG, ...a) }
  const logErr = (...a) => { if (!disposed) console.error(TAG, ...a) }

  let routesState = { server: null, dispose: null }
  function serverKey(server) {
    // ctx.get returns a fresh tracing proxy per call, so object identity is
    // never stable; the underlying node http.Server is the per-instance
    // identity and changes only when the webServer is truly re-created.
    try {
      if (server && server.server) return server.server
    } catch (e) { /* fall through */ }
    return server
  }
  function tryMountRoutes() {
    if (disposed) return
    const server = ctx.get('webServer')
    if (!server) return
    const key = serverKey(server)
    if (routesState.server === key && routesState.dispose) return
    if (routesState.dispose) {
      try { routesState.dispose() } catch (e) { /* ignore */ }
      routesState.dispose = null
    }
    try {
      const dispose = mountRoutes({ webServer: server })
      routesState = { server: key, dispose }
      log('🌐 mobile surface mounted at /m')
    } catch (e) {
      logErr('mount routes failed:', String(e))
    }
  }
  tryMountRoutes()
  const routesTimer = setInterval(tryMountRoutes, 5000)
  if (routesTimer.unref) routesTimer.unref()

  log('🚀 dsh-mobile starting')

  ctx.effect(() => () => {
    disposed = true
    if (routesState.dispose) {
      try { routesState.dispose() } catch (e) { /* ignore */ }
      routesState.dispose = null
    }
    clearInterval(routesTimer)
    log('🛑 dsh-mobile disposed')
  }, 'dsh-mobile: cleanup')
}
