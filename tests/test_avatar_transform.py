from PIL import Image

from proxy.avatar_transform import normalize_avatar


def _image(width: int, height: int, color=(200, 100, 50, 255)) -> Image.Image:
    return Image.new("RGBA", (width, height), color)


def test_normalize_avatar_crops_detected_stack_to_top_third():
    # height/width == 3.0, well past the 2.0 stack threshold. Fill each third
    # with a distinct color so we can confirm the top panel survives.
    width, panel = 300, 300
    stacked = Image.new("RGBA", (width, panel * 3), (0, 0, 0, 255))
    stacked.paste(_image(width, panel, (10, 20, 30, 255)), (0, 0))
    stacked.paste(_image(width, panel, (40, 50, 60, 255)), (0, panel))
    stacked.paste(_image(width, panel, (70, 80, 90, 255)), (0, panel * 2))

    result = normalize_avatar(stacked)

    assert result.size == (width, panel)
    assert result.getpixel((0, 0)) == (10, 20, 30, 255)


def test_normalize_avatar_leaves_normal_portrait_uncropped():
    # 9:16 portrait -- ratio 1.78, under the 2.0 stack threshold.
    portrait = _image(900, 1600)
    result = normalize_avatar(portrait)
    assert result.size == (900, 1600)


def test_normalize_avatar_downscales_when_over_max_dimension():
    oversized = _image(4000, 2000)
    result = normalize_avatar(oversized)
    assert max(result.size) == 1920
    assert result.size == (1920, 960)


def test_normalize_avatar_does_not_upscale_small_images():
    small = _image(256, 256)
    result = normalize_avatar(small)
    assert result.size == (256, 256)


def test_normalize_avatar_crops_then_resizes_oversized_stack():
    width, panel = 1200, 1200
    stacked = _image(width, panel * 3)
    result = normalize_avatar(stacked)
    # Cropped to (1200, 1200) first, already within the 1920 cap.
    assert result.size == (1200, 1200)


def test_normalize_avatar_crop_result_still_downscaled_when_over_cap():
    width, panel = 2500, 2500
    stacked = _image(width, panel * 3)
    result = normalize_avatar(stacked)
    # Cropped to (2500, 2500), then downscaled so the longest side is 1920.
    assert result.size == (1920, 1920)
