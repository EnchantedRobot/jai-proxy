"""Crop and resize a card's avatar before it's embedded in the PNG.

JanitorAI creators use two avatar shapes: a single portrait, or a 3-image
stack (3 portraits composited top-to-bottom into one very tall image, e.g.
Akane Kujo). Stacks render terribly in SillyTavern's fixed avatar frame --
by the time it's shrunk to fit, it's a narrow sliver. Every stack observed
across creators uses exactly 3 panels, so a tall-enough image is assumed to
be one and cropped down to its top third, which is always the primary
portrait. Everything is then downscaled (never upscaled) so its longest
side is at most _MAX_DIMENSION.
"""

from __future__ import annotations

from PIL import Image

# height / width at or above this is treated as a 3-image stack. A single
# portrait tops out around 1.78 (9:16); three stacked portraits land well
# above that.
_STACK_RATIO = 2.0
_MAX_DIMENSION = 1920


def normalize_avatar(image: Image.Image) -> Image.Image:
    width, height = image.size
    if width > 0 and height / width >= _STACK_RATIO:
        image = image.crop((0, 0, width, height // 3))
        width, height = image.size

    longest = max(width, height)
    if longest > _MAX_DIMENSION:
        scale = _MAX_DIMENSION / longest
        new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        image = image.resize(new_size, Image.LANCZOS)

    return image
