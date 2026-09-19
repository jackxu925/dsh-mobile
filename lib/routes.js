// HTTP routes serving the mobile web surface (a static SPA) under /m.
// All session business goes through the harness's own /api endpoints from the
// browser, so these routes only ship bytes. Files are re-read per request so
// iterating on the UI needs no restart.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'cache-control': 'no-cache',
    'content-type': contentType || 'text/plain; charset=utf-8',
  })
  res.end(body)
}

async function serveFile(res, file) {
  const ext = path.extname(file)
  try {
    const body = await readFile(path.join(WEB_DIR, file))
    res.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
    })
    res.end(body)
  } catch (e) {
    sendText(res, 404, 'not found: ' + file)
  }
}

/**
 * Mount the mobile surface on the host's webServer.
 * @returns a disposer that unregisters all routes.
 */
export function mountRoutes(host) {
  const disposers = []
  const route = (path, handler) => {
    disposers.push(host.webServer.register({ kind: 'exact', path, handler }))
  }

  route('/m', async (req, res) => serveFile(res, 'index.html'))
  route('/m/', async (req, res) => serveFile(res, 'index.html'))
  route('/m/app.js', async (req, res) => serveFile(res, 'app.js'))
  route('/m/style.css', async (req, res) => serveFile(res, 'style.css'))
  route('/m/manifest.webmanifest', async (req, res) => serveFile(res, 'manifest.webmanifest'))
  route('/m/icon.svg', async (req, res) => serveFile(res, 'icon.svg'))
  route('/m/icon-180.png', async (req, res) => serveFile(res, 'icon-180.png'))
  route('/m/icon-512.png', async (req, res) => serveFile(res, 'icon-512.png'))
  route('/m/health', async (req, res) => {
    sendText(res, 200, JSON.stringify({ ok: true, surface: 'dsh-mobile' }), 'application/json; charset=utf-8')
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch (e) { /* ignore */ }
    }
  }
}
