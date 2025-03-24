
import base64
from fpdf import FPDF
import os

def embed_image_base64(path):
    with open(path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("utf-8")
    mime = "image/png"
    return f"data:{mime};base64,{encoded}"

def generate_html_report_embedded(output_dir, test_run_id, metadata):
    baseline_b64 = embed_image_base64(os.path.join(output_dir, "baseline.png"))
    test_b64 = embed_image_base64(os.path.join(output_dir, "test.png"))
    diff_b64 = embed_image_base64(os.path.join(output_dir, "diff.png"))

    html_template = f"""
    <html>
    <head><title>Visual Report - {test_run_id}</title></head>
    <body>
        <h1>Visual Comparison Report</h1>
        <p><b>Status:</b> {metadata['status']}</p>
        <p><b>Diff Score:</b> {metadata['diff_score']:.4f}</p>
        <div style='display: flex; gap: 20px;'>
            <div><h3>Baseline</h3><img src="{baseline_b64}" width="300"></div>
            <div><h3>Test</h3><img src="{test_b64}" width="300"></div>
            <div><h3>Diff</h3><img src="{diff_b64}" width="300"></div>
        </div>
    </body>
    </html>
    """
    with open(os.path.join(output_dir, f"{test_run_id}_embedded.html"), "w") as f:
        f.write(html_template)

class PDFReport(FPDF):
    def header(self):
        self.set_font("Arial", "B", 14)
        self.cell(0, 10, "Visual Comparison Report", ln=True, align="C")

    def add_image_comparison(self, baseline_path, test_path, diff_path):
        self.set_font("Arial", "B", 12)
        self.ln(10)
        self.cell(0, 10, "Side-by-Side Comparison", ln=True)
        self.image(baseline_path, w=60)
        self.image(test_path, w=60)
        self.image(diff_path, w=60)
        self.ln(10)

    def add_metadata(self, test_run_id, metadata):
        self.set_font("Arial", "", 11)
        self.cell(0, 10, f"Test Run ID: {test_run_id}", ln=True)
        self.cell(0, 10, f"Status: {metadata['status']}", ln=True)
        self.cell(0, 10, f"Diff Score: {metadata['diff_score']:.4f}", ln=True)
        self.ln(5)
        if metadata.get("ai_ignored_regions"):
            self.cell(0, 10, "AI-Ignored Regions:", ln=True)
            for region in metadata["ai_ignored_regions"]:
                self.cell(0, 10,
                    f" - x: {region['x']}, y: {region['y']}, width: {region['width']}, height: {region['height']}",
                    ln=True)

def export_report_as_pdf(output_dir, test_run_id, metadata):
    pdf = PDFReport()
    pdf.add_page()
    pdf.add_metadata(test_run_id, metadata)
    pdf.add_image_comparison(
        os.path.join(output_dir, "baseline.png"),
        os.path.join(output_dir, "test.png"),
        os.path.join(output_dir, "diff.png")
    )
    pdf_path = os.path.join(output_dir, f"{test_run_id}.pdf")
    pdf.output(pdf_path)
    return pdf_path
