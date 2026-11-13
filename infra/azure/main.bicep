// Source of truth for the Deploy to Azure button. The portal accepts only ARM JSON, so
// azuredeploy.json is generated from this file: npm run azure:template (and checked in CI).
metadata description = 'Deploys the CI/CD Optimizer Microsoft Agent Framework (MAF) agent to Azure Container Apps. ACR Tasks builds agents/maf/Dockerfile from source unless containerImage is set; the app reaches Azure OpenAI through a user-assigned managed identity (no model keys).'

@description('Lowercase letters and digits used to name every resource.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'cicdagent'

@description('Region for the container app, registry and logs.')
param location string = resourceGroup().location

@description('Bearer token callers send to POST /chat (at least 32 characters). Stored only as a Container Apps secret.')
@minLength(32)
@secure()
param apiKey string

@description('Optional prebuilt public image. Leave empty to build agents/maf/Dockerfile from sourceRepository with ACR Tasks.')
param containerImage string = ''

@description('Public Git repository that ACR Tasks builds when containerImage is empty.')
param sourceRepository string = 'https://github.com/MSFT-TKENDRICK/ci-cd-optimizer.git'

@description('Branch, tag or commit of sourceRepository to build.')
param sourceBranch string = 'main'

@description('Image tag for the source build; the default rebuilds and rolls a new revision on every deployment.')
param buildTag string = utcNow('yyyyMMddHHmmss')

@description('Optional existing Azure OpenAI endpoint. Leave empty to create an account and deployment; otherwise grant the output identity \'Cognitive Services OpenAI User\' on that account.')
param azureOpenAiEndpoint string = ''

@description('Region for the new Azure OpenAI account; it must offer modelName with modelSku.')
param openAiLocation string = resourceGroup().location

@description('Model deployment name the agent calls (created when azureOpenAiEndpoint is empty).')
param modelDeploymentName string = 'gpt-5.2'

@description('Azure OpenAI model; gpt-5.2 is the model the repository\'s evaluations used.')
param modelName string = 'gpt-5.2'

@description('Model version for modelName.')
param modelVersion string = '2025-12-11'

@description('Deployment type for the new model deployment.')
@allowed([
  'GlobalStandard'
  'DataZoneStandard'
  'Standard'
])
param modelSku string = 'GlobalStandard'

@description('Model capacity in thousands of tokens per minute; requires matching quota.')
@minValue(1)
param modelCapacity int = 50

@description('0 scales to zero when idle; the first request then waits for a cold start.')
@minValue(0)
@maxValue(10)
param minReplicas int = 0

@description('Upper bound for HTTP-driven scale-out.')
@minValue(1)
@maxValue(30)
param maxReplicas int = 3

@description('Concurrent /chat requests per replica; extra requests receive 429 and the HTTP scale rule adds replicas.')
@minValue(1)
@maxValue(16)
param maxConcurrency int = 2

var suffix = uniqueString(resourceGroup().id, namePrefix)
var buildImage = empty(containerImage)
var createOpenAi = empty(azureOpenAiEndpoint)
var imageRepository = 'cicd-maf-agent'
var port = 8000
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var openAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: '${namePrefix}-logs-${suffix}'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${namePrefix}-id-${suffix}'
  location: location
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = if (buildImage) {
  name: '${namePrefix}acr${suffix}'
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

// A stable task-run name with a changing forceUpdateTag reruns the build on every deployment.
resource sourceBuild 'Microsoft.ContainerRegistry/registries/taskRuns@2025-03-01-preview' = if (buildImage) {
  parent: registry
  name: 'build-agent'
  location: location
  properties: {
    forceUpdateTag: buildTag
    runRequest: {
      type: 'DockerBuildRequest'
      dockerFilePath: 'agents/maf/Dockerfile'
      imageNames: [
        '${imageRepository}:${buildTag}'
        '${imageRepository}:latest'
      ]
      isPushEnabled: true
      noCache: false
      platform: {
        os: 'Linux'
        architecture: 'amd64'
      }
      sourceLocation: '${sourceRepository}#${sourceBranch}'
      timeout: 3600
    }
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (buildImage) {
  scope: registry
  name: guid(registry.id, identity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource openAi 'Microsoft.CognitiveServices/accounts@2025-06-01' = if (createOpenAi) {
  name: '${namePrefix}-aoai-${suffix}'
  location: openAiLocation
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: '${namePrefix}-aoai-${suffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = if (createOpenAi) {
  parent: openAi
  name: modelDeploymentName
  sku: {
    name: modelSku
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource openAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createOpenAi) {
  scope: openAi
  name: guid(openAi.id, identity.id, openAiUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${namePrefix}-env-${suffix}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
  }
}

var image = buildImage ? '${registry!.properties.loginServer}/${imageRepository}:${buildTag}' : containerImage
var openAiEndpoint = createOpenAi ? openAi!.properties.endpoint : azureOpenAiEndpoint

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${namePrefix}-app'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: port
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'api-key'
          value: apiKey
        }
      ]
      registries: buildImage
        ? [
            {
              server: registry!.properties.loginServer
              identity: identity.id
            }
          ]
        : []
    }
    template: {
      containers: [
        {
          name: 'agent'
          image: image
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            {
              name: 'CICD_AGENT_API_KEY'
              secretRef: 'api-key'
            }
            {
              name: 'CICD_AGENT_MAX_CONCURRENCY'
              value: string(maxConcurrency)
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'AZURE_OPENAI_ENDPOINT'
              value: openAiEndpoint
            }
            {
              name: 'AZURE_OPENAI_DEPLOYMENT'
              value: modelDeploymentName
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: port
              }
              periodSeconds: 5
              failureThreshold: 24
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: port
              }
              periodSeconds: 10
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: port
              }
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(maxConcurrency)
              }
            }
          }
        ]
      }
    }
  }
  // The first revision needs the pushed image and both role assignments.
  dependsOn: [
    sourceBuild
    acrPull
    modelDeployment
    openAiUser
  ]
}

output agentUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output healthUrl string = 'https://${app.properties.configuration.ingress.fqdn}/healthz'
output chatUrl string = 'https://${app.properties.configuration.ingress.fqdn}/chat'
output azureOpenAiEndpoint string = openAiEndpoint
output identityPrincipalId string = identity.properties.principalId
output image string = image
