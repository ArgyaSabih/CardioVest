# Image layanan cloud: inferensi CNN 1D + decision engine FSM. Build context: folder CardioVest/
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/common:/app/cloud \
    TF_CPP_MIN_LOG_LEVEL=2 TF_ENABLE_ONEDNN_OPTS=0
WORKDIR /app
COPY cloud/requirements.txt /tmp/req.txt
RUN pip install --no-cache-dir -r /tmp/req.txt
COPY common /app/common
COPY cloud /app/cloud
CMD ["python", "-m", "cloud", "--db", "/data/cardiovest.db"]
