"""Offline contract tests for the Deploy to Azure template (infra/azure) and the container it runs.

ARM preflight needs Azure permissions, so these checks pin the template to the code it deploys instead.
Drift between main.bicep and azuredeploy.json is checked separately by `npm run azure:template:check`.
"""
import json
import re

import pytest

from cicd_agent.config import MAF_DIR, PACKAGE_DIR, repo_root
from cicd_agent.server import create_app

REPO = repo_root()
TEMPLATE = json.loads((REPO / "infra" / "azure" / "azuredeploy.json").read_text(encoding="utf-8"))
DOCKERFILE = (MAF_DIR / "Dockerfile").read_text(encoding="utf-8")
ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
OPENAI_USER = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"


def resources(kind: str) -> list[dict]:
    return [r for r in TEMPLATE["resources"] if r["type"] == kind]


def only(kind: str) -> dict:
    [resource] = resources(kind)
    return resource


CONTAINER = only("Microsoft.App/containerApps")["properties"]
AGENT = CONTAINER["template"]["containers"][0]


def test_template_is_bicep_build_output():
    assert TEMPLATE["metadata"]["_generator"]["name"] == "bicep"
    assert (REPO / "infra" / "azure" / "main.bicep").is_file()


def test_api_key_is_secure_and_matches_server_minimum():
    key = TEMPLATE["parameters"]["apiKey"]
    assert key["type"] == "securestring"
    with pytest.raises(RuntimeError):
        create_app(api_key="k" * (key["minLength"] - 1))
    assert len(AGENT["env"]) == len({e["name"] for e in AGENT["env"]})
    [entry] = [e for e in AGENT["env"] if e["name"] == "CICD_AGENT_API_KEY"]
    assert entry == {"name": "CICD_AGENT_API_KEY", "secretRef": "api-key"}
    assert CONTAINER["configuration"]["secrets"] == [{"name": "api-key", "value": "[parameters('apiKey')]"}]


def test_outputs_never_expose_credentials():
    outputs = json.dumps(TEMPLATE["outputs"])
    assert "apiKey" not in outputs and not re.search(r"\blist\w*\(", outputs)
    # The only key read is the Log Analytics key the Container Apps environment needs for log shipping.
    listed = re.findall(r"\blist\w*\(", json.dumps(TEMPLATE))
    assert listed == ["listKeys("]
    logs = only("Microsoft.App/managedEnvironments")["properties"]["appLogsConfiguration"]
    assert logs["logAnalyticsConfiguration"]["sharedKey"].startswith("[listKeys(resourceId('Microsoft.OperationalInsights/workspaces'")


def test_local_auth_is_disabled_everywhere():
    registry = only("Microsoft.ContainerRegistry/registries")["properties"]
    assert registry["adminUserEnabled"] is False and registry["anonymousPullEnabled"] is False
    assert only("Microsoft.CognitiveServices/accounts")["properties"]["disableLocalAuth"] is True
    ingress = CONTAINER["configuration"]["ingress"]
    assert ingress["allowInsecure"] is False


def test_identity_is_granted_exactly_the_roles_it_needs():
    variables = TEMPLATE["variables"]
    roles = {variables[re.search(r"variables\('(\w+)'\)", r["properties"]["roleDefinitionId"])[1]]: r["condition"]
             for r in resources("Microsoft.Authorization/roleAssignments")}
    assert roles == {ACR_PULL: "[variables('buildImage')]", OPENAI_USER: "[variables('createOpenAi')]"}
    for role in resources("Microsoft.Authorization/roleAssignments"):
        assert "userAssignedIdentities" in role["properties"]["principalId"]
        assert role["properties"]["principalType"] == "ServicePrincipal"


def test_container_env_matches_what_the_code_reads():
    read = set()
    for source in PACKAGE_DIR.rglob("*.py"):
        read |= set(re.findall(r"environ\.get\(\"([A-Z_]+)\"", source.read_text(encoding="utf-8")))
    names = {e["name"] for e in AGENT["env"]}
    # AZURE_CLIENT_ID selects the user-assigned identity for azure-identity's DefaultAzureCredential.
    assert names - read == {"AZURE_CLIENT_ID"}
    assert {"CICD_AGENT_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT"} <= names


def test_ingress_and_probes_target_the_served_health_route():
    port = TEMPLATE["variables"]["port"]
    assert re.search(rf"^EXPOSE {port}$", DOCKERFILE, re.M)
    assert re.search(rf"PORT={port}\b", DOCKERFILE)
    assert CONTAINER["configuration"]["ingress"]["targetPort"] == "[variables('port')]"
    paths = {(p["type"], p["httpGet"]["path"]) for p in AGENT["probes"]}
    assert paths == {("Startup", "/healthz"), ("Readiness", "/healthz"), ("Liveness", "/healthz")}
    routes = {route.path for route in create_app(api_key="k" * 32).routes}
    assert {"/healthz", "/chat"} <= routes


def test_acr_task_builds_the_committed_dockerfile():
    request = only("Microsoft.ContainerRegistry/registries/taskRuns")["properties"]["runRequest"]
    assert request["type"] == "DockerBuildRequest"
    assert (REPO / request["dockerFilePath"]).resolve() == (MAF_DIR / "Dockerfile").resolve()


def test_dockerfile_is_classic_and_digest_pinned():
    # ACR Tasks builds without BuildKit front-end directives.
    assert not re.search(r"^#\s*syntax=", DOCKERFILE, re.M | re.I)
    assert "--mount" not in DOCKERFILE
    bases = re.findall(r"^FROM\s+(\S+)", DOCKERFILE, re.M)
    assert bases and all(re.search(r"@sha256:[0-9a-f]{64}$", base) for base in bases)
    assert re.search(r"^USER 10001$", DOCKERFILE, re.M)
