FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

USER node
ENV HOME=/home/node \
    PATH=/home/node/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    REPO=https://github.com/ArgyaSabih/CardioVest.git \
    BRANCH=faza
WORKDIR /home/node

RUN python3 -m venv venv \
 && git clone -q -b "$BRANCH" "$REPO" app \
 && pip install -q --no-cache-dir -r app/cloud/requirements.txt -r app/dataset/requirements.txt \
 && cd app/server && npm ci --omit=dev --no-audit --no-fund \
 && sha1sum package-lock.json | cut -d' ' -f1 > /home/node/.npm-lock

EXPOSE 10000
CMD ["bash", "-c", "cd /home/node/app && git fetch -q origin \"$BRANCH\" && git reset -q --hard FETCH_HEAD; exec bash deploy/backend/run.sh"]
