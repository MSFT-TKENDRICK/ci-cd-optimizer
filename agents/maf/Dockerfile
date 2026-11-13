# Container for the Microsoft Agent Framework (MAF) CI/CD agent. Build from the repository root:
#   docker build -f agents/maf/Dockerfile -t cicd-maf-agent .
# Uses only classic Dockerfile features so Azure Container Registry Tasks can build it from Git.

FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS dependencies
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
COPY agents/maf/requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/venv && /opt/venv/bin/pip install -r /tmp/requirements.txt

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS node

FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
# The agent launches the bundled CI/CD optimizer MCP server with Node.js; only the runtime binary is needed.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /opt/venv /opt/venv
WORKDIR /app
COPY plugins/ci-cd-optimizer ./plugins/ci-cd-optimizer
COPY agents/maf/policy.json ./agents/maf/policy.json
COPY agents/maf/instructions ./agents/maf/instructions
COPY agents/maf/cicd_agent ./agents/maf/cicd_agent
COPY LICENSE THIRD_PARTY_NOTICES.txt ./
RUN useradd --system --uid 10001 --no-create-home agent
USER 10001
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CICD_AGENT_REPO_ROOT=/app \
    HOST=0.0.0.0 \
    PORT=8000
WORKDIR /app/agents/maf
EXPOSE 8000
# CICD_AGENT_API_KEY (32+ characters) must be supplied at run time; the server refuses to start without it.
CMD ["python", "-m", "cicd_agent", "serve"]
