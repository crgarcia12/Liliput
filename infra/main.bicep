targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment that can be used as part of naming resource convention')
param environmentName string

@minLength(1)
@maxLength(90)
@description('Name of the resource group to use or create')
param resourceGroupName string = 'rg-${environmentName}'

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Id of the user or app to assign application roles')
param principalId string

@description('Principal type of user or app')
param principalType string

param apiContainerAppName string = ''
param containerAppsEnvironmentName string = ''
param containerRegistryName string = ''
param webContainerAppName string = ''
param webAppExists bool = false
param apiAppExists bool = false

var tags = {
  'azd-env-name': environmentName
}

var abbrs = loadJsonContent('./abbreviations.json')
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

// Monitoring
module logAnalytics 'core/monitor/loganalytics.bicep' = {
  name: 'loganalytics'
  scope: rg
  params: {
    name: 'logs-${resourceToken}'
    location: location
    tags: tags
  }
}

module applicationInsights 'core/monitor/applicationinsights.bicep' = {
  name: 'applicationinsights'
  scope: rg
  params: {
    name: 'appi-${resourceToken}'
    location: location
    tags: tags
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
  }
}

// Container apps host (including container registry)
module containerApps 'br/public:avm/ptn/azd/container-apps-stack:0.1.0' = {
  name: 'container-apps'
  scope: rg
  params: {
    containerAppsEnvironmentName: !empty(containerAppsEnvironmentName) ? containerAppsEnvironmentName : '${abbrs.appManagedEnvironments}${resourceToken}'
    containerRegistryName: !empty(containerRegistryName) ? containerRegistryName : '${abbrs.containerRegistryRegistries}${resourceToken}'
    logAnalyticsWorkspaceResourceId: logAnalytics.outputs.id
    appInsightsConnectionString: applicationInsights.outputs.connectionString
    acrSku: 'Basic'
    location: location
    acrAdminUserEnabled: true
    zoneRedundant: false
    tags: tags
  }
}

// Managed identity for web frontend
module webIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.2.1' = {
  name: 'webidentity'
  scope: rg
  params: {
    name: '${abbrs.managedIdentityUserAssignedIdentities}web-${resourceToken}'
    location: location
  }
}

// Web frontend
module web 'br/public:avm/ptn/azd/container-app-upsert:0.1.1' = {
  name: 'web-container-app'
  scope: rg
  params: {
    name: !empty(webContainerAppName) ? webContainerAppName : '${abbrs.appContainerApps}web-${resourceToken}'
    tags: union(tags, { 'azd-service-name': 'web' })
    location: location
    containerAppsEnvironmentName: containerApps.outputs.environmentName
    containerRegistryName: containerApps.outputs.registryName
    ingressEnabled: true
    identityType: 'UserAssigned'
    exists: webAppExists
    containerName: 'main'
    identityName: webIdentity.name
    userAssignedIdentityResourceId: webIdentity.outputs.resourceId
    containerMinReplicas: 1
    identityPrincipalId: webIdentity.outputs.principalId
  }
}

// Managed identity for api backend
module apiIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.2.1' = {
  name: 'apiidentity'
  scope: rg
  params: {
    name: '${abbrs.managedIdentityUserAssignedIdentities}api-${resourceToken}'
    location: location
  }
}

// Api backend
module api 'br/public:avm/ptn/azd/container-app-upsert:0.1.1' = {
  name: 'api-container-app'
  scope: rg
  params: {
    name: !empty(apiContainerAppName) ? apiContainerAppName : '${abbrs.appContainerApps}api-${resourceToken}'
    tags: union(tags, { 'azd-service-name': 'api' })
    location: location
    env: [
      {
        name: 'AZURE_CLIENT_ID'
        value: apiIdentity.outputs.clientId
      }
      {
        name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
        value: applicationInsights.outputs.connectionString
      }
      {
        name: 'JWT_SECRET'
        value: uniqueString(resourceGroup().id, resourceToken, 'jwt-secret')
      }
    ]
    containerAppsEnvironmentName: containerApps.outputs.environmentName
    containerRegistryName: containerApps.outputs.registryName
    exists: apiAppExists
    identityType: 'UserAssigned'
    identityName: apiIdentity.name
    containerCpuCoreCount: '1.0'
    containerMemory: '2.0Gi'
    targetPort: 8080
    containerMinReplicas: 1
    ingressEnabled: true
    containerName: 'main'
    userAssignedIdentityResourceId: apiIdentity.outputs.resourceId
    identityPrincipalId: apiIdentity.outputs.principalId
  }
}

// App outputs
output APPLICATIONINSIGHTS_CONNECTION_STRING string = applicationInsights.outputs.connectionString
output AZURE_CONTAINER_ENVIRONMENT_NAME string = containerApps.outputs.environmentName
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerApps.outputs.registryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = containerApps.outputs.registryName
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output API_BASE_URL string = api.outputs.uri
output REACT_APP_WEB_BASE_URL string = web.outputs.uri
output SERVICE_API_NAME string = api.outputs.name
output SERVICE_WEB_NAME string = web.outputs.name
output AZURE_RESOURCE_GROUP string = resourceGroupName

