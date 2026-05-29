import { writeFileSync } from 'node:fs'
const wsUrl = process.argv[2]
const out = process.argv[3]
const ws = new WebSocket(wsUrl)
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id === 1) {
    if (m.result?.data) { writeFileSync(out, Buffer.from(m.result.data, 'base64')); console.log('saved', out) }
    else console.log(JSON.stringify(m))
    ws.close(); process.exit(0)
  }
}
ws.onerror = (e) => { console.error('ws error', e.message); process.exit(1) }
setTimeout(() => { console.error('timeout'); process.exit(1) }, 10000)
