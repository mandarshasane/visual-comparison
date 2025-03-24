
import requests
import os

class VisualCompareClient:
    def __init__(self, base_url="http://localhost:8000"):
        self.base_url = base_url

    def compare_image(self, screenshot_path, component_name, baseline_version="v1.0", tag="default",
                      tolerance=0.05, ignore_regions=None, use_ai=True):
        if not os.path.exists(screenshot_path):
            raise FileNotFoundError("Screenshot not found")

        files = {"test_image": open(screenshot_path, "rb")}
        data = {
            "component_name": component_name,
            "baseline_version": baseline_version,
            "tag": tag,
            "tolerance": tolerance,
            "ai_ignore_dynamic_content": str(use_ai).lower(),
            "ignore_regions": "[]" if ignore_regions is None else str(ignore_regions).replace("'", '"')
        }

        try:
            response = requests.post(f"{self.base_url}/compare", data=data, files=files)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print("Comparison request failed:", e)
            return {"status": "error", "message": str(e)}

    def upload_baseline(self, image_path, component_name, version="v1.0", tag="default"):
        if not os.path.exists(image_path):
            raise FileNotFoundError("Image not found")

        files = {"image": open(image_path, "rb")}
        data = {
            "component_name": component_name,
            "version": version,
            "tag": tag
        }

        try:
            response = requests.post(f"{self.base_url}/baseline", data=data, files=files)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print("Baseline upload failed:", e)
            return {"status": "error", "message": str(e)}
