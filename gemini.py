"""
gemini.py — AI Engine for SQL & PDF Analysis
=============================================
Uses Sarvam AI API (sarvam-m model) to:
  1. Convert natural language queries into SQL and execute them.
  2. Extract text from PDFs, chunk it, and answer questions (RAG).
"""

import os
import re
import sqlite3
import json
import time
from dotenv import load_dotenv

from sarvamai import SarvamAI
import PyPDF2
import pandas as pd

load_dotenv()

# ── Configure Sarvam ──────────────────────────────────────────────────────────
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY")

def _get_client() -> SarvamAI:
    """Return a configured SarvamAI client."""
    return SarvamAI(api_subscription_key=SARVAM_API_KEY)


def _safe_generate(prompt: str, max_retries: int = 3) -> str:
    """
    Call Sarvam sarvam-m with automatic retry + exponential backoff
    on rate-limit / transient errors.
    """
    last_error = None

    for attempt in range(max_retries):
        try:
            client = _get_client()
            response = client.chat.completions(
                messages=[{"role": "user", "content": prompt}],
            )
            # Response shape: response.choices[0].message.content
            return response.choices[0].message.content
        except Exception as e:
            last_error = e
            err_str = str(e).lower()
            if "429" in str(e) or "quota" in err_str or "rate" in err_str or "resource" in err_str:
                wait = 5 * (2 ** attempt)   # 5s, 10s, 20s
                time.sleep(wait)
                continue
            else:
                # Non-rate-limit error — fail immediately
                raise Exception(f"Sarvam AI error: {last_error}")

    raise Exception(f"Sarvam AI failed after {max_retries} retries. Last error: {last_error}")


# ══════════════════════════════════════════════════════════════════════════════
#  SQL AI  AGENT
# ══════════════════════════════════════════════════════════════════════════════

# Per-session in-memory SQLite databases keyed by session id
_DB_CONNECTIONS: dict[str, sqlite3.Connection] = {}


def _get_db(session_id: str) -> sqlite3.Connection:
    """Get or create an in-memory SQLite connection for a session."""
    if session_id not in _DB_CONNECTIONS:
        conn = sqlite3.connect(":memory:", check_same_thread=False)
        conn.row_factory = sqlite3.Row
        _DB_CONNECTIONS[session_id] = conn
    return _DB_CONNECTIONS[session_id]


def load_dataframe_to_sql(df: pd.DataFrame, table_name: str, session_id: str) -> dict:
    """
    Load a pandas DataFrame into an in-memory SQLite table.
    Returns schema info for the LLM context.
    """
    conn = _get_db(session_id)
    # Clean column names: remove spaces and special chars
    df.columns = [re.sub(r'[^\w]', '_', col.strip()) for col in df.columns]
    df.to_sql(table_name, conn, if_exists="replace", index=False)

    # Build schema description
    cursor = conn.execute(f"PRAGMA table_info('{table_name}')")
    columns_info = cursor.fetchall()
    schema = []
    for col in columns_info:
        schema.append({
            "name": col[1],
            "type": col[2],
        })

    # Sample rows
    sample = conn.execute(f"SELECT * FROM '{table_name}' LIMIT 3").fetchall()
    sample_rows = [dict(row) for row in sample]

    row_count = conn.execute(f"SELECT COUNT(*) FROM '{table_name}'").fetchone()[0]

    return {
        "table_name": table_name,
        "columns": schema,
        "sample_rows": sample_rows,
        "row_count": row_count,
    }


def generate_sql_from_question(question: str, schema_info: dict, session_id: str) -> dict:
    """
    Use Sarvam AI to convert a natural language question into SQL,
    execute it, and return results.
    """
    # Build prompt with schema context
    columns_desc = "\n".join(
        [f"  - {c['name']} ({c['type']})" for c in schema_info["columns"]]
    )
    sample_json = json.dumps(schema_info["sample_rows"], indent=2, default=str)

    prompt = f"""You are an expert SQL analyst. Given the following SQLite database table information,
generate a SQL query to answer the user's question.

TABLE NAME: {schema_info['table_name']}
COLUMNS:
{columns_desc}

SAMPLE DATA (first 3 rows):
{sample_json}

TOTAL ROW COUNT: {schema_info['row_count']}

USER QUESTION: {question}

IMPORTANT RULES:
1. Return ONLY the SQL query, nothing else.
2. Use SQLite syntax.
3. Always use the exact table name: {schema_info['table_name']}
4. Use exact column names as listed above.
5. For aggregations, always use meaningful aliases with AS.
6. Limit results to 100 rows max unless user asks for specific count.
7. Do NOT include any markdown formatting, code blocks, or backticks.
8. Return just the raw SQL statement.

SQL QUERY:"""

    sql_query = _safe_generate(prompt).strip()

    # Clean up: remove markdown code fences if present
    sql_query = re.sub(r'^```sql\s*', '', sql_query, flags=re.IGNORECASE)
    sql_query = re.sub(r'^```\s*', '', sql_query)
    sql_query = re.sub(r'\s*```$', '', sql_query)
    sql_query = sql_query.strip()

    # Execute the query
    conn = _get_db(session_id)
    try:
        cursor = conn.execute(sql_query)
        columns = [desc[0] for desc in cursor.description] if cursor.description else []
        rows = cursor.fetchall()
        results = [dict(zip(columns, row)) for row in rows]

        return {
            "status": "success",
            "sql_query": sql_query,
            "columns": columns,
            "results": results,
            "row_count": len(results),
        }
    except Exception as e:
        return {
            "status": "error",
            "sql_query": sql_query,
            "error": str(e),
        }


def generate_ai_summary(question: str, sql_result: dict) -> str:
    """Generate a natural language summary of SQL results using Sarvam AI."""
    if sql_result["status"] == "error":
        return f"❌ SQL Error: {sql_result['error']}"

    results_preview = json.dumps(sql_result["results"][:20], indent=2, default=str)

    prompt = f"""You are a helpful data analyst. The user asked a question and we ran a SQL query.
Provide a clear, concise, and insightful answer based on the results.

USER QUESTION: {question}
SQL QUERY EXECUTED: {sql_result['sql_query']}
TOTAL ROWS RETURNED: {sql_result['row_count']}

RESULTS (first 20 rows):
{results_preview}

Provide a helpful, well-formatted summary in markdown. Include:
1. A direct answer to the question
2. Key insights or patterns if applicable
3. Any notable findings

Keep it concise but informative."""

    return _safe_generate(prompt)


def cleanup_session(session_id: str):
    """Close and remove the database connection for a session."""
    if session_id in _DB_CONNECTIONS:
        _DB_CONNECTIONS[session_id].close()
        del _DB_CONNECTIONS[session_id]


# ══════════════════════════════════════════════════════════════════════════════
#  PDF  RAG  ENGINE
# ══════════════════════════════════════════════════════════════════════════════

def extract_text_from_pdf(pdf_file) -> str:
    """Extract all text from a PDF file object."""
    reader = PyPDF2.PdfReader(pdf_file)
    text_parts = []
    for page_num, page in enumerate(reader.pages, 1):
        text = page.extract_text()
        if text:
            text_parts.append(f"[Page {page_num}]\n{text}")
    return "\n\n".join(text_parts)


def chunk_text(text: str, chunk_size: int = 1000, overlap: int = 200) -> list[str]:
    """Split text into overlapping chunks for better context retrieval."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start += chunk_size - overlap
    return chunks


def _simple_relevance_score(query: str, chunk: str) -> float:
    """
    Simple keyword-based relevance scoring.
    Uses TF-based matching for lightweight retrieval without heavy ML models.
    """
    query_words = set(query.lower().split())
    chunk_lower = chunk.lower()

    score = 0.0
    for word in query_words:
        if len(word) > 2:  # skip very short words
            count = chunk_lower.count(word)
            score += count

    # Normalize by chunk length to avoid bias toward longer chunks
    if len(chunk) > 0:
        score = score / (len(chunk.split()) ** 0.5)

    return score


def retrieve_relevant_chunks(query: str, chunks: list[str], top_k: int = 5) -> list[str]:
    """Retrieve the most relevant chunks for a given query."""
    scored = [(chunk, _simple_relevance_score(query, chunk)) for chunk in chunks]
    scored.sort(key=lambda x: x[1], reverse=True)
    return [chunk for chunk, score in scored[:top_k]]


def answer_pdf_question(question: str, pdf_text: str) -> str:
    """
    RAG pipeline: chunk the PDF text, find relevant sections,
    and use Sarvam AI to generate an answer.
    """
    # Chunk the document
    chunks = chunk_text(pdf_text)

    if not chunks:
        return "❌ Could not extract any text from the PDF document."

    # Retrieve relevant chunks
    relevant_chunks = retrieve_relevant_chunks(question, chunks, top_k=5)
    context = "\n\n---\n\n".join(relevant_chunks)

    prompt = f"""You are an expert document analyst. Answer the user's question based ONLY on the
provided document context. If the answer is not found in the context, say so clearly.

DOCUMENT CONTEXT:
{context}

USER QUESTION: {question}

INSTRUCTIONS:
1. Answer the question based ONLY on the information in the document context.
2. If the exact answer is not in the context, provide the most relevant information available.
3. Use markdown formatting for clarity.
4. Cite the page numbers when possible (they appear as [Page X] in the context).
5. Be concise but comprehensive.
6. If the question asks for a summary, provide a structured summary of the content.

ANSWER:"""

    return _safe_generate(prompt)


def summarize_pdf(pdf_text: str) -> str:
    """Generate a comprehensive summary of the entire PDF document."""
    # If text is very long, use chunks and summarize progressively
    if len(pdf_text) > 30000:
        chunks = chunk_text(pdf_text, chunk_size=5000, overlap=500)
        # Summarize first ~6 chunks (covering most of the document)
        context = "\n\n".join(chunks[:6])
    else:
        context = pdf_text

    prompt = f"""You are a document analysis expert. Provide a comprehensive summary of the following document.

DOCUMENT CONTENT:
{context}

Please provide:
1. **Document Overview**: What the document is about (2-3 sentences)
2. **Key Topics**: Major topics covered
3. **Important Points**: Key findings, data, or conclusions
4. **Structure**: How the document is organized

Format your response in clear markdown."""

    return _safe_generate(prompt)


# ══════════════════════════════════════════════════════════════════════════════
#  UNIFIED  QUERY  (handles both SQL + PDF in one question)
# ══════════════════════════════════════════════════════════════════════════════

def classify_query(question: str, has_sql_data: bool, has_pdf: bool) -> str:
    """Classify whether a question is for SQL, PDF, or both."""
    prompt = f"""Classify the following user question into one of these categories:
- "sql" - if it's about structured data, numbers, tables, records, statistics
- "pdf" - if it's about document content, policies, text information
- "both" - if it requires information from both data sources

Available data sources:
- SQL database: {"Available" if has_sql_data else "Not available"}
- PDF document: {"Available" if has_pdf else "Not available"}

Question: {question}

Return ONLY one word: "sql", "pdf", or "both"."""

    result = _safe_generate(prompt).strip().lower()

    if "both" in result:
        return "both"
    elif "pdf" in result:
        return "pdf"
    else:
        return "sql"
