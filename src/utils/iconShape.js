/**
 * Returns true when the image needs a synthetic rounded-square frame.
 * Opaque, edge-filling square artwork is already suitable as an app icon.
 */
export function needsRoundedSquareFrame(img, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || !img?.naturalWidth || !img?.naturalHeight) return true;

  const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
  const width = img.naturalWidth * scale;
  const height = img.naturalHeight * scale;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, (size - width) / 2, (size - height) / 2, width, height);

  try {
    const pixels = ctx.getImageData(0, 0, size, size).data;
    let minX = size;
    let minY = size;
    let maxX = -1;
    let maxY = -1;
    let opaque = 0;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (pixels[(y * size + x) * 4 + 3] < 22) continue;
        opaque += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX || maxY < minY) return true;
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const fillRatio = opaque / Math.max(1, boxWidth * boxHeight);
    const widthRatio = boxWidth / size;
    const heightRatio = boxHeight / size;
    const aspect = boxWidth / Math.max(1, boxHeight);

    return !(
      widthRatio >= 0.9
      && heightRatio >= 0.9
      && aspect >= 0.86
      && aspect <= 1.16
      && fillRatio >= 0.86
    );
  } catch (err) {
    return true;
  }
}
