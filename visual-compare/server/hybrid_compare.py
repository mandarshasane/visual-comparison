def hybrid_compare(test_path, baseline_path, output_dir, ignore_regions=None, use_ai=True, tolerance=0.05):
    os.makedirs(output_dir, exist_ok=True)

    test_img = load_image(test_path)
    baseline_img = load_image(baseline_path)

    if test_img.shape != baseline_img.shape:
        raise ValueError("Test and baseline images have different dimensions")

    # AI-based dynamic region detection
    ai_ignore_regions = detect_dynamic_regions(baseline_img, test_img) if use_ai else []

    # Merge all ignore regions
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
