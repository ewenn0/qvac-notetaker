const wsUrl = process.argv[2]
const ws = new WebSocket(wsUrl)
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.getWindowForTarget', params: {} }))
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  console.log(JSON.stringify(m))
  ws.close(); process.exit(0)
}
ws.onerror = (e) => { console.error('ws error', e.message); process.exit(1) }
setTimeout(() => { console.error('timeout'); process.exit(1) }, 8000)
