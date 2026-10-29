FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/common:/app/simulator
WORKDIR /app
COPY simulator/requirements.txt /tmp/req.txt
RUN pip install --no-cache-dir -r /tmp/req.txt
COPY common /app/common
COPY simulator /app/simulator
COPY tools/uji_skenario.py /app/tools/uji_skenario.py
CMD ["python", "-m", "simulator"]
