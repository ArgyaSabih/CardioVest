FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/common:/app/cloud
WORKDIR /app
COPY cloud/requirements.txt /tmp/req.txt
RUN pip install --no-cache-dir -r /tmp/req.txt
COPY common /app/common
COPY cloud/cloud /app/cloud/cloud
COPY cloud/model/artifacts/cnn1d_ecg.onnx /app/cloud/model/artifacts/cnn1d_ecg.onnx
CMD ["python", "-m", "cloud", "--db", "/data/cardiovest.db"]
