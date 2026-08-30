// dsh-mobile client bundle: adds 设置 → 手机端 with the mobile surface URL.
// Hand-authored CJS bundle for window.__ModuleLoader__ (no build step).
window.__ModuleLoader__.load({ id: "dsh-mobile", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react')
const h = React.createElement
const { useState } = React

const name = "dsh-mobile"
const inject = ["slots"]

function MobileSettingsPage() {
  const url = (typeof location !== 'undefined' ? location.origin : '') + '/m/'
  const [copied, setCopied] = useState(false)
  const cardStyle = { border: '1px solid rgba(128,128,128,0.28)', borderRadius: '8px', padding: '14px 16px', margin: '0 0 12px', maxWidth: '560px', width: '100%', boxSizing: 'border-box', background: 'transparent' }
  const titleStyle = { fontWeight: 600, fontSize: '14px', margin: '0 0 10px' }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }
  const urlStyle = { flex: 1, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '13px', background: 'rgba(128,128,128,0.12)', borderRadius: '6px', padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  const btnStyle = { padding: '6px 16px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '13px', background: 'var(--accent, #2f81f7)', color: '#fff' }
  return h('div', { style: { padding: '4px' } },
    h('div', { style: cardStyle },
      h('div', { style: titleStyle }, '📱 手机端入口'),
      h('div', { style: { fontSize: '12px', opacity: 0.8, margin: '0 0 10px', lineHeight: 1.6 } },
        '手机（同一 Tailscale 网络或局域网）浏览器打开下面的地址即可。iOS/Android 都可以「添加到主屏幕」获得全屏 App 体验。注意：地址的 Host 必须在 dsh web 的 trusted hosts 里（和现在桌面端 GUI 的要求相同）。'),
      h('div', { style: rowStyle },
        h('span', { style: urlStyle }, url),
        h('button', {
          style: btnStyle,
          onClick: () => {
            const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500) }
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done)
            else done()
          },
        }, copied ? '已复制 ✓' : '复制')),
      h('div', { style: { marginTop: '10px', fontSize: '12px' } },
        h('a', { href: '/m/', target: '_blank', rel: 'noopener', style: { color: '#588cff' } }, '在本机打开预览 ↗'))))
}

function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mobile',
    order: 40,
    label: () => '手机端',
  }, () => h(MobileSettingsPage, null)))
}

exports.name = name
exports.inject = inject
exports.apply = apply
return module.exports;
} });
