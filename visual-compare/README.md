
# 🧪 Visual Compare – On-Premise Visual Testing Tool

A fast, flexible, and privacy-first alternative to Applitools.  
Compare screenshots with baseline images using pixel + AI-assisted visual diffs.

---

## 🚀 Features

- ✅ Hybrid image comparison (pixel + AI ignore)
- ✅ Region-based ignore rules
- ✅ Auto-baseline promotion on first run
- ✅ Versioning and tagging of baseline images
- ✅ HTML and PDF visual reports
- ✅ FastAPI REST API
- ✅ Python SDK for test automation (e.g., Selenium)
- ✅ Fully on-premise, no cloud dependency

---

## 🗂️ Folder Structure

```
visual-compare/
├── server/                       # FastAPI backend
│   ├── main.py                   # REST API endpoints
│   ├── hybrid_compare.py         # Core comparison logic
│   ├── report_generator.py       # HTML & PDF report utilities
│   └── requirements.txt
│
├── sdk/                          # Python SDK for easy integration
│   ├── visual_compare_sdk.py
│   └── __init__.py
│
├── runs/                         # Stores test runs (diffs, reports)
├── baselines/                    # Stores baseline images
└── README.md
```

---

## 🔧 Setup Instructions

### 1. Install Server Dependencies
```bash
cd server
pip install -r requirements.txt
```

### 2. Start the API Server
```bash
uvicorn main:app --reload
```
API runs at: [http://localhost:8000](http://localhost:8000)

### 3. Use the Python SDK
```python
from sdk import VisualCompareClient

client = VisualCompareClient()
result = client.compare_image("test.png", "LoginPage")
print(result)
```

Or manually upload a baseline:
```python
client.upload_baseline("baseline.png", "LoginPage", version="v1.0", tag="Desktop")
```

---

## 🧪 Web UI for Manual Testing

Open `web_upload_test.html` in your browser to test two image uploads visually.  
Make sure the API is running at `http://localhost:8000`.

---

## 📊 View Reports

After a test run, open:

```
GET /report/{test_run_id}?format=html
GET /report/{test_run_id}?format=pdf
```

---

## 📦 License

MIT – Use freely, deploy locally.

---

## 🙋‍♂️ Contributions

PRs and suggestions welcome!
