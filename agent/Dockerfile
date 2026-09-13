FROM python:3.12-slim-bookworm

WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --upgrade pip==26.2.1 \
    && python -m pip install --no-cache-dir -r requirements.txt
COPY server.py .

RUN addgroup --system agent && adduser --system --ingroup agent agent \
    && chown -R agent:agent /app
USER agent

EXPOSE 8787
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8787", "--no-access-log", "--no-server-header"]
