
import os
import cv2
import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity as ssim
import json

def load_image(path):
    return np.array(Image.open(path).convert("RGB"))

def save_image(image_np, path):
    img = Image.fromarray(image_np)
    img.save(path)

def mask_ignore_regions(image, regions):
    masked = image.copy()
    for region in regions:
        x, y, w, h = region["x"], region["y"], region["width"], region["height"]
        masked[y:y+h, x:x+w] = 0
    return masked

def detect_dynamic_regions(img1, img2, threshold=30):
    gray1 = cv2.cvtColor(img1, cv2.COLOR_RGB2GRAY)
    gray2 = cv2.cvtColor(img2, cv2.COLOR_RGB2GRAY)
    diff = cv2.absdiff(gray1, gray2)
    _, thresh = cv2.threshold(diff, threshold, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    regions = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w * h > 100:  # Ignore tiny noise
            regions.append({"x": int(x), "y": int(y), "width": int(w), "height": int(h)})
    return regions

def calculate_diff_score(img1, img2):
    grayA = cv2.cvtColor(img1, cv2.COLOR_RGB2GRAY)
    grayB = cv2.cvtColor(img2, cv2.COLOR_RGB2GRAY)
    score, diff = ssim(grayA, grayB, full=True)
    return 1 - score, diff

def generate_diff_image(diff_map):
    heatmap = (diff_map * 255).astype("uint8")
    return cv2.applyColorMap(heatmap, cv2.COLORMAP_JET)

def hybrid_compare(test_path, baseline_path, output_dir, ignore_regions=None, use_ai=True, tolerance=0.05):
    os.makedirs(output_dir, exist_ok=True)

    test_img = load_image(test_path)
    baseline_img = load_image(baseline_path)

    if test_img.shape != baseline_img.shape:
        raise ValueError("Test and baseline images have different dimensions")

    ai_ignore_regions = detect_dynamic_regions(baseline_img, test_img) if use_ai else []
    combined_ignore = (ignore_regions or []) + ai_ignore_regions

    masked_test = mask_ignore_regions(test_img, combined_ignore)
    masked_baseline = mask_ignore_regions(baseline_img, combined_ignore)

    diff_score, diff_map = calculate_diff_score(masked_baseline, masked_test)
    diff_image = generate_diff_image(diff_map)

    save_image(diff_image, os.path.join(output_dir, "diff.png"))
    save_image(test_img, os.path.join(output_dir, "test.png"))
    save_image(baseline_img, os.path.join(output_dir, "baseline.png"))

    result = {
        "diff_score": diff_score,
        "status": "difference_found" if diff_score > tolerance else "match",
        "ai_ignored_regions": ai_ignore_regions,
        "output": {
            "diff_image": "diff.png",
            "test_image": "test.png",
            "baseline_image": "baseline.png"
        }
    }

    with open(os.path.join(output_dir, "metadata.json"), "w") as f:
        json.dump(result, f, indent=2)

    return result
