// Public, unauthenticated tracking page opened straight from the WhatsApp
// link — no app install, no login. Polls the public track API every few
// seconds and renders whatever status the visitor's record is currently in.
function renderTrackPage(id) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>KIMS Hospital Parking — Track My Car</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #0f6e5a, #0b4f42); padding: 20px;
  }
  .card {
    width: 100%; max-width: 420px; background: #fff; border-radius: 20px; padding: 28px 24px;
    box-shadow: 0 20px 50px rgba(0,0,0,0.25);
  }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: 1px; color: #0f6e5a; margin-bottom: 4px; }
  h1 { font-size: 20px; margin: 0 0 20px; color: #111; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; font-size: 14px; }
  .row:last-of-type { border-bottom: none; }
  .label { color: #777; font-weight: 600; }
  .value { color: #111; font-weight: 700; text-align: right; }
  .steps { display: flex; justify-content: space-between; margin: 24px 0 8px; position: relative; }
  .steps::before { content: ''; position: absolute; top: 13px; left: 8%; right: 8%; height: 3px; background: #e5e5e5; z-index: 0; }
  .steps .fill { position: absolute; top: 13px; left: 8%; height: 3px; background: #25D366; z-index: 1; transition: width .4s; }
  .step { position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; width: 25%; }
  .dot { width: 28px; height: 28px; border-radius: 50%; background: #e5e5e5; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .dot.done { background: #25D366; color: #fff; }
  .dot.active { background: #0f6e5a; color: #fff; }
  .step-label { font-size: 10px; color: #777; text-align: center; font-weight: 600; }
  .msg { margin-top: 20px; text-align: center; font-size: 13px; color: #555; line-height: 1.5; }
  .error { text-align: center; color: #c0392b; font-size: 14px; }
  .footer { margin-top: 20px; text-align: center; font-size: 11px; color: #aaa; }
</style>
</head>
<body>
  <div class="card" id="card">
    <div class="brand">🏥 KIMS HOSPITAL PARKING</div>
    <h1>Track My Car</h1>
    <div id="content">Loading…</div>
  </div>
  <script>
    const ID = ${JSON.stringify(id)};
    const STEPS = [
      { key: 'received', label: 'Received' },
      { key: 'parked', label: 'Parked' },
      { key: 'requested', label: 'Requested' },
      { key: 'retrieved', label: 'Ready' },
    ];

    function stepIndex(v) {
      if (v.status === 'retrieved') return 3;
      if (v.status === 'parked' && v.retrievalRequested) return 2;
      if (v.status === 'parked') return 1;
      return 0;
    }

    function render(v) {
      const idx = stepIndex(v);
      const fillPct = (idx / (STEPS.length - 1)) * 84; // matches steps::before inset
      const dots = STEPS.map((s, i) => {
        const cls = i < idx ? 'done' : i === idx ? 'active' : '';
        return '<div class="step"><div class="dot ' + cls + '">' + (i < idx ? '✓' : (i + 1)) + '</div><div class="step-label">' + s.label + '</div></div>';
      }).join('');

      let statusMsg;
      if (v.status === 'pending' && !v.driverName) statusMsg = 'Your car has been received by our valet team. A driver is being assigned.';
      else if (v.status === 'pending' && v.driverName) statusMsg = v.driverName + ' is on the way to park your car.';
      else if (v.status === 'parked' && !v.retrievalRequested) statusMsg = 'Your car is safely parked' + (v.slotId ? ' at slot ' + v.slotId : '') + '. Contact the valet desk when you are ready to leave.';
      else if (v.status === 'parked' && v.retrievalRequested) statusMsg = 'Retrieval requested — your car is on its way to the valet counter.';
      else if (v.status === 'retrieved') statusMsg = 'Your car has been retrieved. Thank you for visiting KIMS Hospital!';
      else statusMsg = '';

      document.getElementById('content').innerHTML =
        '<div class="row"><span class="label">Name</span><span class="value">' + escapeHtml(v.name) + '</span></div>' +
        '<div class="row"><span class="label">Car Number</span><span class="value">' + escapeHtml(v.carNumber) + '</span></div>' +
        (v.slotId ? '<div class="row"><span class="label">Slot</span><span class="value">' + escapeHtml(v.slotId) + '</span></div>' : '') +
        (v.driverName ? '<div class="row"><span class="label">Driver</span><span class="value">' + escapeHtml(v.driverName) + '</span></div>' : '') +
        '<div class="steps"><div class="fill" style="width:' + fillPct + '%"></div>' + dots + '</div>' +
        '<div class="msg">' + statusMsg + '</div>' +
        '<div class="footer">Auto-refreshing · KIMS Smart Parking</div>';
    }

    function escapeHtml(str) {
      return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    async function poll() {
      try {
        const res = await fetch('/api/track/' + encodeURIComponent(ID));
        if (!res.ok) throw new Error('not found');
        const { visitor } = await res.json();
        render(visitor);
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="error">This tracking link is invalid or has expired.</div>';
      }
    }

    poll();
    setInterval(poll, 4000);
  </script>
</body>
</html>`;
}

module.exports = { renderTrackPage };
