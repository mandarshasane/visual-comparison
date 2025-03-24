# Visual Compare

On-premise visual testing tool with image diffing and AI-ignore.

## 🔧 Installation & Setup

### 1. Install Server Dependencies
```bash
cd server
pip install -r requirements.txt
```

### 2. Start FastAPI Server
```bash
uvicorn main:app --reload
```
Server will run at `http://localhost:8000`

### 3. Use the Python SDK in Your Tests
Example:
```python
from sdk import VisualCompareClient

client = VisualCompareClient()
result = client.compare_image("test.png", "LoginPage")
print(result)
```

You can also manually upload a baseline:
```python
client.upload_baseline("baseline.png", "LoginPage", version="v1.0", tag="Desktop")
```

### 4. Access Reports
After a test run, view reports at:
```
GET /report/{test_run_id}?format=html or pdf
```
