
from fastapi import FastAPI, UploadFile, File, Form, Query
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
import os, json, uuid, shutil
from report_generator import generate_html_report_embedded, export_report_as_pdf
from hybrid_compare import hybrid_compare

app = FastAPI()
BASE_DIR = "runs"

@app.post("/compare")
async def compare_images(
    component_name: str = Form(...),
    baseline_version: str = Form("v1.0"),
    tag: str = Form("default"),
    tolerance: float = Form(0.05),
    ai_ignore_dynamic_content: bool = Form(True),
    ignore_regions: str = Form("[]"),
    test_image: UploadFile = File(...)
):
    test_run_id = str(uuid.uuid4())
    run_dir = os.path.join(BASE_DIR, test_run_id)
    os.makedirs(run_dir, exist_ok=True)

    test_path = os.path.join(run_dir, "test.png")
    with open(test_path, "wb") as buffer:
        shutil.copyfileobj(test_image.file, buffer)

    baseline_filename = f"{baseline_version}__{tag}.png"
    baseline_path = os.path.join("baselines", component_name, baseline_filename)

    if not os.path.exists(baseline_path):
        os.makedirs(os.path.dirname(baseline_path), exist_ok=True)
        shutil.copy(test_path, baseline_path)

    ignore_region_list = json.loads(ignore_regions)

    result = hybrid_compare(
        test_path=test_path,
        baseline_path=baseline_path,
        output_dir=run_dir,
        ignore_regions=ignore_region_list,
        use_ai=ai_ignore_dynamic_content,
        tolerance=tolerance
    )

    result["test_run_id"] = test_run_id
    result["report_url"] = f"/report/{test_run_id}"
    return JSONResponse(content=result)

@app.post("/baseline")
async def upload_baseline(
    component_name: str = Form(...),
    version: str = Form(...),
    tag: str = Form("default"),
    image: UploadFile = File(...)
):
    filename = f"{version}__{tag}.png" if tag else f"{version}.png"
    save_dir = os.path.join("baselines", component_name)
    os.makedirs(save_dir, exist_ok=True)

    save_path = os.path.join(save_dir, filename)
    with open(save_path, "wb") as f:
        content = await image.read()
        f.write(content)

    return JSONResponse(content={"status": "success", "message": "Baseline uploaded", "path": save_path})

@app.get("/report/{test_run_id}")
async def get_report(test_run_id: str, format: str = Query("html")):
    run_dir = os.path.join(BASE_DIR, test_run_id)
    metadata_path = os.path.join(run_dir, "metadata.json")

    if not os.path.exists(metadata_path):
        return JSONResponse(content={"error": "Test run not found"}, status_code=404)

    with open(metadata_path) as f:
        metadata = json.load(f)

    if format == "html":
        report_path = os.path.join(run_dir, f"{test_run_id}_embedded.html")
        if not os.path.exists(report_path):
            generate_html_report_embedded(run_dir, test_run_id, metadata)
        return HTMLResponse(content=open(report_path).read())

    elif format == "pdf":
        report_path = os.path.join(run_dir, f"{test_run_id}.pdf")
        if not os.path.exists(report_path):
            export_report_as_pdf(run_dir, test_run_id, metadata)
        return FileResponse(report_path, media_type='application/pdf', filename=f"{test_run_id}.pdf")

    return JSONResponse(content={"error": "Invalid format"}, status_code=400)
