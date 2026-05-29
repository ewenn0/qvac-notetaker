const wsUrl = process.argv[2]
const expr = process.argv[3]
const ws = new WebSocket(wsUrl)
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id === 1) {
    console.log(JSON.stringify(m, null, 2))
    ws.close()
    process.exit(0)
  }
}
ws.onerror = (e) => { console.error('ws error', e.message); process.exit(1) }
setTimeout(() => { console.error('timeout'); process.exit(1) }, 60000)
