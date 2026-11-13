const { nativeImage } = require('electron');

function transportIcon(kind) {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xx = kind === 'previous' ? size - 1 - x : x;
      const triangle = xx >= 10 && xx <= 23 && Math.abs(y - 15.5) <= (23 - xx) * 0.75;
      const bar = xx >= 24 && xx <= 26 && y >= 6 && y <= 25;
      const pause = (x >= 8 && x <= 12 || x >= 19 && x <= 23) && y >= 6 && y <= 25;
      if (kind === 'pause' ? pause : triangle || kind !== 'play' && bar) pixels.fill(255, (y * size + x) * 4, (y * size + x) * 4 + 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}

module.exports = { transportIcon };
