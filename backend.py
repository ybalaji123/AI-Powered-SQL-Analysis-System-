"""
backend.py — FastAPI Backend
=============================
Provides API endpoints for:
  - User authentication (login/register via Supabase)
  - SQL AI analysis (upload data, ask questions)
  - PDF AI analysis (upload PDF, ask questions, summarize)
"""

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
import pandas as pd
import json
import uuid
import io

import gemini

app = FastAPI(
    title="SQL & PDF AI Analysis API",
    description="AI-powered question answering over structured databases and PDF documents",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory stores ─────────────────────────────────────────────────────────
# session_id -> { "schema_info": {...}, "table_name": str }
SQL_SESSIONS: dict[str, dict] = {}

# session_id -> { "pdf_text": str, "filename": str }
PDF_SESSIONS: dict[str, dict] = {}


# ══════════════════════════════════════════════════════════════════════════════
#  AUTH  MODELS
# ══════════════════════════════════════════════════════════════════════════════

class LoginRequest(BaseModel):
    username: str
    password: str

class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str


# ══════════════════════════════════════════════════════════════════════════════
#  HEALTH
# ══════════════════════════════════════════════════════════════════════════════

# Mount static files (HTML/CSS/JS frontend)
import os
_static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if os.path.isdir(_static_dir):
    app.mount("/static", StaticFiles(directory=_static_dir, html=True), name="static")

@app.get("/")
def read_root():
    return RedirectResponse(url="/static/index.html")


# ══════════════════════════════════════════════════════════════════════════════
#  SQL AI  ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

class SQLQueryRequest(BaseModel):
    session_id: str
    question: str

@app.post("/sql/upload")
async def sql_upload_data(file: UploadFile = File(...), session_id: str = Form(...)):
    """Upload a CSV/Excel file and load it into an in-memory SQL database."""
    try:
        contents = await file.read()
        filename = file.filename or "data"

        # Read into DataFrame
        if filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(contents))
        elif filename.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(contents))
        elif filename.endswith(".txt"):
            df = pd.read_csv(io.BytesIO(contents), delimiter="\t")
        else:
            raise HTTPException(status_code=400, detail="Unsupported file type. Use CSV, Excel, or TXT.")

        # Create a safe table name from filename
        table_name = filename.rsplit(".", 1)[0]
        table_name = "".join(c if c.isalnum() or c == "_" else "_" for c in table_name)
        if not table_name:
            table_name = "data_table"

        schema_info = gemini.load_dataframe_to_sql(df, table_name, session_id)

        SQL_SESSIONS[session_id] = {
            "schema_info": schema_info,
            "table_name": table_name,
        }

        return {
            "status": "success",
            "message": f"Data loaded into table '{table_name}'",
            "schema": schema_info,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing file: {str(e)}")


@app.post("/sql/query")
async def sql_query(request: SQLQueryRequest):
    """Convert natural language to SQL and execute it."""
    if request.session_id not in SQL_SESSIONS:
        raise HTTPException(status_code=400, detail="No data loaded. Please upload a file first.")

    session = SQL_SESSIONS[request.session_id]
    try:
        result = gemini.generate_sql_from_question(
            request.question,
            session["schema_info"],
            request.session_id,
        )

        # Generate AI summary
        summary = gemini.generate_ai_summary(request.question, result)

        return {
            "status": result["status"],
            "sql_query": result.get("sql_query", ""),
            "results": result.get("results", []),
            "columns": result.get("columns", []),
            "row_count": result.get("row_count", 0),
            "ai_summary": summary,
            "error": result.get("error"),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI Error: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════════
#  PDF  AI  ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/pdf/upload")
async def pdf_upload(file: UploadFile = File(...), session_id: str = Form(...)):
    """Upload a PDF and extract its text for RAG queries."""
    try:
        contents = await file.read()
        pdf_file = io.BytesIO(contents)
        pdf_text = gemini.extract_text_from_pdf(pdf_file)

        if not pdf_text.strip():
            raise HTTPException(status_code=400, detail="Could not extract text from PDF. The PDF might be image-based.")

        PDF_SESSIONS[session_id] = {
            "pdf_text": pdf_text,
            "filename": file.filename,
        }

        # Count pages
        pdf_file.seek(0)
        import PyPDF2
        reader = PyPDF2.PdfReader(pdf_file)
        page_count = len(reader.pages)

        return {
            "status": "success",
            "message": f"PDF '{file.filename}' processed successfully",
            "page_count": page_count,
            "text_length": len(pdf_text),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing PDF: {str(e)}")


class PDFQueryRequest(BaseModel):
    session_id: str
    question: str

@app.post("/pdf/query")
async def pdf_query(request: PDFQueryRequest):
    """Answer a question about the uploaded PDF using RAG."""
    if request.session_id not in PDF_SESSIONS:
        raise HTTPException(status_code=400, detail="No PDF loaded. Please upload a PDF first.")

    session = PDF_SESSIONS[request.session_id]
    try:
        answer = gemini.answer_pdf_question(request.question, session["pdf_text"])
        return {
            "status": "success",
            "answer": answer,
            "source_file": session["filename"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI Error: {str(e)}")


@app.post("/pdf/summarize")
async def pdf_summarize(session_id: str = Form(...)):
    """Generate a summary of the uploaded PDF."""
    if session_id not in PDF_SESSIONS:
        raise HTTPException(status_code=400, detail="No PDF loaded. Please upload a PDF first.")

    session = PDF_SESSIONS[session_id]
    try:
        summary = gemini.summarize_pdf(session["pdf_text"])
        return {
            "status": "success",
            "summary": summary,
            "source_file": session["filename"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI Error: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════════
#  UNIFIED  QUERY
# ══════════════════════════════════════════════════════════════════════════════

class UnifiedQueryRequest(BaseModel):
    session_id: str
    question: str

@app.post("/unified/query")
async def unified_query(request: UnifiedQueryRequest):
    """
    Unified endpoint: automatically routes to SQL, PDF, or both
    based on question intent.
    """
    has_sql = request.session_id in SQL_SESSIONS
    has_pdf = request.session_id in PDF_SESSIONS

    if not has_sql and not has_pdf:
        raise HTTPException(
            status_code=400,
            detail="No data sources available. Please upload a dataset or PDF first.",
        )

    try:
        query_type = gemini.classify_query(request.question, has_sql, has_pdf)
    except Exception:
        query_type = "sql" if has_sql else "pdf"

    response = {"query_type": query_type}

    if query_type in ("sql", "both") and has_sql:
        session = SQL_SESSIONS[request.session_id]
        sql_result = gemini.generate_sql_from_question(
            request.question, session["schema_info"], request.session_id
        )
        sql_summary = gemini.generate_ai_summary(request.question, sql_result)
        response["sql"] = {
            "sql_query": sql_result.get("sql_query", ""),
            "results": sql_result.get("results", []),
            "columns": sql_result.get("columns", []),
            "row_count": sql_result.get("row_count", 0),
            "summary": sql_summary,
        }

    if query_type in ("pdf", "both") and has_pdf:
        session = PDF_SESSIONS[request.session_id]
        pdf_answer = gemini.answer_pdf_question(request.question, session["pdf_text"])
        response["pdf"] = {
            "answer": pdf_answer,
            "source_file": session["filename"],
        }

    return response


# ══════════════════════════════════════════════════════════════════════════════
#  CLEANUP
# ══════════════════════════════════════════════════════════════════════════════

@app.delete("/session/{session_id}")
async def cleanup(session_id: str):
    """Clean up all data for a session."""
    gemini.cleanup_session(session_id)
    SQL_SESSIONS.pop(session_id, None)
    PDF_SESSIONS.pop(session_id, None)
    return {"status": "success", "message": "Session cleaned up."}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)