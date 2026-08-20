/** A crop rectangle in the source image's own pixel coordinates. */
export interface PixelCrop {
  x: number
  y: number
  width: number
  height: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image))
    image.addEventListener('error', () =>
      reject(new Error('Could not load the image for cropping.')),
    )
    image.src = src
  })
}

/** Renders the selected region of `imageSrc` onto a canvas and returns it as a PNG blob. */
export async function cropImageToBlob(
  imageSrc: string,
  crop: PixelCrop,
): Promise<Blob> {
  const image = await loadImage(imageSrc)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(crop.width)
  canvas.height = Math.round(crop.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable.')
  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Crop failed to encode.'))
    }, 'image/png')
  })
}
