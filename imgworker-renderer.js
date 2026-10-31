'use strict';
// Gira nella finestra nascosta: ridimensiona e ricomprime una foto in JPEG.
window.imgworker.onJob(async ({ id, bytes, maxMegapixels }) => {
  try {
    const blob = new Blob([bytes]);
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const maxPx = Math.max(0.3, maxMegapixels) * 1e6;
    const scale = Math.min(1, Math.sqrt(maxPx / (bmp.width * bmp.height)));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    window.imgworker.done({ id, bytes: new Uint8Array(await out.arrayBuffer()) });
  } catch (e) {
    window.imgworker.done({ id, error: String(e && e.message || e) });
  }
});
